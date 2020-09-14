import { IDatabaseClient, IDatabaseBaseClient } from "./database-client"
import { TableSchema, ColumnType, NativeFunction, Table, IQuery, Columns } from "./table"
import { SQL } from "./sql"
import max from "lodash.max"

const schema_management = TableSchema({
	name: {
		type: ColumnType.Varchar,
		primaryKey: true,
		nullable: false,
		unique: true,
	},
	version: { type: ColumnType.Integer, nullable: false },
	date_added: {
		type: ColumnType.TimestampTZ,
		nullable: false,
		defaultValue: { func: NativeFunction.Now },
	},
	locked: { type: ColumnType.Boolean, nullable: false, defaultValue: false },
})
const SchemaManagementTable = Table({ schema_management }, "schema_management")

const selectVersionQuery = (name: string) => SchemaManagementTable.select("*", ["name"])([name])
const insertSchemaQuery = (name: string, version: number) => SchemaManagementTable.insertFromObj({ name, version })
const updateSchemaVersionQuery = (name: string, newVersion: number) =>
	SchemaManagementTable.update(["version"], ["name"])([newVersion], [name])

export type IDatabaseSchema = ReturnType<typeof DatabaseSchema>

export interface IUpDownArgs {
	transaction: IDatabaseBaseClient
	database: IDatabaseBaseClient
}

export interface IMigration {
	up: (args: IUpDownArgs) => Promise<void | IQuery<{}>[]>
}

export const Migration = (up: (args: IUpDownArgs) => Promise<void | IQuery<{}>[]>): IMigration => ({ up })

export type CreateStatement = string

export interface IDatabaseSchemaArgs {
	name: string
	client: IDatabaseClient
	createStatements: CreateStatement[]
	migrations: Map<number, IMigration>
	logMigrations?: boolean
}

export const DatabaseSchema = ({ client, createStatements, name, migrations, logMigrations }: IDatabaseSchemaArgs) => {
	let version = 0
	let isInitialized = false

	const getLatestMigrationVersion = () => {
		return max(Array.from(migrations.keys())) || 1
	}

	const init = async () => {
		if (isInitialized) {
			throw new Error(`Database schema ${name} has already been initialized.`)
		}

		try {
			await client.transaction(async (transaction) => {
				await transaction.query(SchemaManagementTable.create())

				const versionDBResults = await transaction.query(selectVersionQuery(name))

				if (versionDBResults.length === 0) {
					const initialVersion = getLatestMigrationVersion()

					await transaction.query({
						sql: createStatements.join("\n"),
					})
					await transaction.query(insertSchemaQuery(name, initialVersion))

					version = initialVersion
				} else {
					version = versionDBResults[0].version
				}
			})
		} catch (err) {
			if (err.message.indexOf("duplicate key value violates unique constraint") === -1) {
				throw err
			}
		}

		isInitialized = true
	}

	const throwNotInitialized = () => {
		throw new Error(
			`Migration failed, database schema is not initialized. Please call init() first on your database schema.`,
		)
	}

	const lockSchemaTableQuery = SQL.raw(
		`
                LOCK TABLE ${SchemaManagementTable.name} IN ACCESS EXCLUSIVE MODE;
            `,
		[],
	)
	const getSchemaVersionQuery = (awaitLock: boolean) =>
		SQL.raw<typeof schema_management>(
			`
                SELECT * FROM ${SchemaManagementTable.name}
                WHERE name = $1 ${!awaitLock ? "FOR UPDATE NOWAIT" : ""};
            `,
			[name],
		)
	const setSchemaLockQuery = (locked: boolean) =>
		SQL.raw(
			`
                UPDATE ${SchemaManagementTable.name} SET locked = $1 WHERE name=$2;
            `,
			[locked, name],
		)

	/*
        Locks schema_management table for given transaction and retrievs current schema version
        If table is already locked, the postgres client is advised to await execution until lock is released
        This ensures, that in a multi-node environment all starting nodes proceed code execution after all migrations are done
    */
	const getCurrentVersionAndLockSchema = async (client: IDatabaseBaseClient, awaitLock: boolean) => {
		await client.query(lockSchemaTableQuery)
		const dbResults = await client.query(getSchemaVersionQuery(awaitLock))

		if (dbResults.length === 1 && dbResults[0].locked === false) {
			await client.query(setSchemaLockQuery(true))

			return dbResults[0].version
		}

		return null
	}

	const migrateToVersion = async (targetVersion: number) => {
		if (!isInitialized) throwNotInitialized()

		if (targetVersion <= 1) {
			throw new Error("Target version of migrateToVersion() has to be greater 1")
		}

		for (let newVersion = version; newVersion <= targetVersion; newVersion++) {
			await client.transaction(async (transaction) => {
				const currentVersion = await getCurrentVersionAndLockSchema(transaction, true)

				if (currentVersion === null || currentVersion >= newVersion) {
					if (currentVersion) {
						await transaction.query(setSchemaLockQuery(false))
					}

					return
				}

				const migration = migrations.get(newVersion)

				if (!migration) {
					await transaction.query(setSchemaLockQuery(false))

					throw new Error(`Migration with version ${newVersion} not found. Aborting migration process...`)
				}

				const migrationQueries = await migration.up({ transaction, database: client })

				if (Array.isArray(migrationQueries)) {
					for (const migrationQuery of migrationQueries) {
						await transaction.query(migrationQuery)
					}
				}

				await transaction.query(updateSchemaVersionQuery(name, newVersion))
				await transaction.query(setSchemaLockQuery(false))

				// istanbul ignore next
				if (!(logMigrations === false)) {
					console.info(`Successfully migrated ${name} from version ${version} to ${newVersion}`)
				}
			})

			version = newVersion
		}
	}

	const migrateLatest = async () => {
		const sortedMigrationKeys = Array.from(migrations.keys()).sort()
		const latestVersion = sortedMigrationKeys[sortedMigrationKeys.length - 1]

		await migrateToVersion(latestVersion)
	}

	const getVersion = () => version

	return {
		name,
		getVersion,
		init,
		migrateLatest,
		migrateToVersion,
	}
}

type ITables = { [name: string]: Columns }

export const SchemaDiff = <OldTables extends ITables, Tables extends ITables>(oldTables: OldTables, tables: Tables) => {
	type NewKeys = Extract<keyof Tables, string>
	type OldKeys = Extract<keyof OldTables, string>
	type CommonKeys = Extract<NewKeys, OldKeys>

	return {
		dropTable: (table: Exclude<OldKeys, NewKeys>) => SQL.dropTable(table, true),

		createTable: (table: Exclude<NewKeys, OldKeys>) => SQL.createTable(table, tables[table]),

		replaceTables: (replace: CommonKeys[]) => [
			...replace.map((table) => SQL.dropTable(table, true)),
			...[...replace].reverse().map((table) => SQL.createTable(table, tables[table])),
		],

		dropTableColumn: <Name extends CommonKeys>(
			table: Name,
			column: Extract<Exclude<keyof OldTables[Name], keyof Tables[Name]>, string>,
		) => SQL.dropTableColumn(table, column, true),

		addTableColumn: <Name extends CommonKeys>(
			table: Name,
			column: Extract<Exclude<keyof Tables[Name], keyof OldTables[Name]>, string>,
		) => SQL.addTableColumn(table, { name: column, ...tables[table][column] }, true),

		replaceTableColumn: <Name extends CommonKeys>(
			table: Name,
			column: Extract<Extract<keyof Tables[Name], keyof OldTables[Name]>, string>,
		) => [
			SQL.dropTableColumn(table, column, true),
			SQL.addTableColumn(table, { name: column, ...tables[table][column] }, true),
		],

		addRequiredColumn: <Name extends CommonKeys>(
			table: Name,
			column: Extract<Exclude<keyof Tables[Name], keyof OldTables[Name]>, string>,
			updates: string[],
		) =>
			[
				SQL.addTableColumn(table, { name: column, ...tables[table][column], nullable: true }, true),
				...updates,
				SQL.raw(`ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL;`).sql,
			].join("\n"),

		replaceRequiredColumn: <Name extends CommonKeys>(
			table: Name,
			column: Extract<Extract<keyof Tables[Name], keyof OldTables[Name]>, string>,
		) => {
			const oldColumn = `__old_${column}`

			return [
				SQL.dropConstraint(table, column, oldTables[table][column]),
				SQL.raw(`ALTER TABLE ${table} RENAME COLUMN ${column} TO ${oldColumn};`),
				SQL.addTableColumn(table, { name: column, ...tables[table][column], nullable: true }, true),
				SQL.raw(`UPDATE ${table} SET ${column} = ${oldColumn}`),
				SQL.raw(`ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL;`),
				SQL.dropTableColumn(table, oldColumn, true),
			]
		},

		addIndex: <Name extends CommonKeys>(table: Name, column: keyof Tables[Name] & string, unique: boolean) =>
			SQL.createIndex(unique, table, column),
	}
}
