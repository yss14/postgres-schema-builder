import { makeTestDatabase, makeMockDatabase } from "./utils/make-test-database"
import { TestTables, TestTableA, TestTableB, TestTableAllTypes, TestTableAllTypesV2 } from "./fixtures/test-tables"
import { DatabaseSchema, IMigration, Migration, IDatabaseSchemaArgs } from "../database-schema"
import { composeCreateTableStatements } from "../sql-utils"
import { ColumnType, ForeignKeyUpdateDeleteRule } from "../table"
import { SQL } from "../sql"

const cleanupHooks: (() => Promise<void>)[] = []

afterAll(async () => {
	await Promise.all(cleanupHooks.map((hook) => hook()))
})

const setupTest = async () => {
	const { database, cleanupHook } = await makeTestDatabase()
	cleanupHooks.push(cleanupHook)

	return { database }
}

describe("init", () => {
	test("initializes correctly", async () => {
		const { database } = await setupTest()

		const databaseSchema = DatabaseSchema({
			name: "TestSchema",
			client: database,
			createStatements: composeCreateTableStatements(TestTables),
			migrations: new Map<number, IMigration>(),
		})

		await databaseSchema.init()

		expect(databaseSchema.name).toBe("TestSchema")
		expect(databaseSchema.getVersion()).toBe(1)
	})

	test("initialize twice with restart succeeds", async () => {
		const { database } = await setupTest()

		const databaseSchemaConfig: IDatabaseSchemaArgs = {
			name: "TestSchema",
			client: database,
			createStatements: composeCreateTableStatements(TestTables),
			migrations: new Map<number, IMigration>(),
		}
		const databaseSchema = DatabaseSchema(databaseSchemaConfig)
		await databaseSchema.init()

		// simulate restart
		const databaseSchemaOnSecondStart = DatabaseSchema(databaseSchemaConfig)
		await databaseSchemaOnSecondStart.init()

		expect(databaseSchemaOnSecondStart.getVersion()).toBe(1)
	})

	test("initialize twice without restart fails", async () => {
		const { database } = await setupTest()

		const databaseSchema = DatabaseSchema({
			name: "TestSchema",
			client: database,
			createStatements: composeCreateTableStatements(TestTables),
			migrations: new Map<number, IMigration>(),
		})

		await databaseSchema.init()

		await expect(databaseSchema.init()).rejects.toThrowError(
			`Database schema ${databaseSchema.name} has already been initialized.`,
		)
	})
})

describe("migrate latest", () => {
	test("valid migrations succeed", async () => {
		const { database } = await setupTest()

		const migrations = new Map<number, IMigration>()
		migrations.set(
			2,
			Migration(async ({ transaction }) => {
				await transaction.query(TestTableB.drop())
				await new Promise<void>((resolve) => setTimeout(() => resolve(), 200))
				await transaction.query(
					TestTableA.addColumns({
						some_newly_added_col_string: {
							type: ColumnType.Varchar,
							nullable: false,
							defaultValue: "Hello World",
						},
						some_newly_added_col_boolean: { type: ColumnType.Boolean, nullable: true },
					}),
				)
			}),
		)
		const columnsToBeRemoved = ["some_newly_added_col_string", "some_str"]
		const newColumnsWithFKConstraints = {
			some_new_fk: {
				type: ColumnType.Integer,
				nullable: false,
				createIndex: true,
				foreignKeys: [
					{
						targetTable: TestTableA.name,
						targetColumn: "id",
						onDelete: ForeignKeyUpdateDeleteRule.Cascade,
						onUpdate: ForeignKeyUpdateDeleteRule.NoAction,
					},
				],
			},
			some_new_fk_same_target: {
				type: ColumnType.Integer,
				nullable: false,
				createIndex: true,
				foreignKeys: [
					{
						targetTable: TestTableA.name,
						targetColumn: "id",
						onDelete: ForeignKeyUpdateDeleteRule.Cascade,
						onUpdate: ForeignKeyUpdateDeleteRule.NoAction,
					},
				],
			},
		}
		migrations.set(
			3,
			Migration(async ({ transaction }) => {
				await transaction.query(SQL.raw(SQL.dropColumns(TestTableA.name, columnsToBeRemoved)))
				await transaction.query(TestTableAllTypes.addColumns(newColumnsWithFKConstraints))
			}),
		)
		migrations.set(
			4,
			Migration(async ({ transaction }) => {
				await transaction.query(TestTableAllTypesV2.dropColumns(["some_new_fk", "some_new_fk_same_target"]))
			}),
		)

		const databaseSchema = DatabaseSchema({
			name: "TestSchema",
			client: database,
			createStatements: composeCreateTableStatements(TestTables),
			migrations,
		})

		await databaseSchema.init()
		await databaseSchema.migrateLatest()

		expect(databaseSchema.getVersion()).toBe(4)

		const tableAColumnsResults = await database.query(
			SQL.raw(`
            SELECT column_name
            FROM information_schema.columns 
            WHERE table_name='${TestTableA.name}' 
                AND (column_name='${columnsToBeRemoved[0]}' OR column_name='${columnsToBeRemoved[1]}');
        `),
		)

		expect(tableAColumnsResults.length).toBe(0)
	})

	test("no schema initialization fails", async () => {
		const database = makeMockDatabase()

		const databaseSchema = DatabaseSchema({
			name: "TestSchema",
			client: database,
			createStatements: composeCreateTableStatements(TestTables),
			migrations: new Map<number, IMigration>(),
		})

		await expect(databaseSchema.migrateLatest()).rejects.toThrowError(
			"Migration failed, database schema is not initialized. Please call init() first on your database schema.",
		)
		expect(databaseSchema.getVersion()).toBe(0)
	})

	test("sql error aborts migration", async () => {
		const { database } = await setupTest()

		const migrations = new Map<number, IMigration>()
		migrations.set(
			2,
			Migration(async ({ transaction }) => {
				await transaction.query(TestTableA.dropColumns(["id"]))
			}),
		)

		const databaseSchema = DatabaseSchema({
			name: "TestSchema",
			client: database,
			createStatements: composeCreateTableStatements(TestTables),
			migrations,
		})

		await databaseSchema.init()

		await expect(databaseSchema.migrateLatest()).rejects.toThrowError(
			"cannot drop column id of table test_table_a because other objects depend on it",
		)
		expect(databaseSchema.getVersion()).toBe(1)
	})

	test("missing migration aborts", async () => {
		const { database } = await setupTest()

		const migrations = new Map<number, IMigration>()
		migrations.set(
			2,
			Migration(async ({ transaction }) => {
				await transaction.query(TestTableB.drop())
			}),
		)
		migrations.set(
			4,
			Migration(async () => undefined),
		)

		const databaseSchema = DatabaseSchema({
			name: "TestSchema",
			client: database,
			createStatements: composeCreateTableStatements(TestTables),
			migrations,
		})

		await databaseSchema.init()

		await expect(databaseSchema.migrateLatest()).rejects.toThrowError(
			`Migration with version 3 not found. Aborting migration process...`,
		)

		expect(databaseSchema.getVersion()).toBe(2)
	})
})

describe("migrate to version", () => {
	test("migrate to specific version succeeds", async () => {
		const { database } = await setupTest()

		const migration2 = jest.fn()
		const migration3 = jest.fn()
		const migration4 = jest.fn()
		const migration5 = jest.fn()

		const migrations = new Map<number, IMigration>()
		migrations.set(2, Migration(migration2))
		migrations.set(3, Migration(migration3))
		migrations.set(4, Migration(migration4))
		migrations.set(5, Migration(migration5))

		const databaseSchema = DatabaseSchema({
			name: "TestSchema",
			client: database,
			createStatements: composeCreateTableStatements(TestTables),
			migrations,
		})

		await databaseSchema.init()
		await databaseSchema.migrateToVersion(4)

		expect(databaseSchema.getVersion()).toBe(4)
		expect(migration2).toBeCalled()
		expect(migration3).toBeCalled()
		expect(migration4).toBeCalled()
		expect(migration5).not.toBeCalled()
	})

	test("migrate to specific version multiple steps succeeds", async () => {
		const { database } = await setupTest()

		const migration2 = jest.fn()
		const migration3 = jest.fn()
		const migration4 = jest.fn()
		const migration5 = jest.fn()

		const migrations = new Map<number, IMigration>()
		migrations.set(2, Migration(migration2))
		migrations.set(3, Migration(migration3))
		migrations.set(4, Migration(migration4))
		migrations.set(5, Migration(migration5))

		const databaseSchema = DatabaseSchema({
			name: "TestSchema",
			client: database,
			createStatements: composeCreateTableStatements(TestTables),
			migrations,
		})

		await databaseSchema.init()

		await databaseSchema.migrateToVersion(2)
		expect(databaseSchema.getVersion()).toBe(2)
		expect(migration2).toBeCalled()

		await databaseSchema.migrateToVersion(4)
		expect(databaseSchema.getVersion()).toBe(4)
		expect(migration3).toBeCalled()
		expect(migration4).toBeCalled()

		await databaseSchema.migrateToVersion(5)
		expect(databaseSchema.getVersion()).toBe(5)
		expect(migration5).toBeCalled()

		expect(migration2).toHaveBeenCalledTimes(1)
		expect(migration3).toHaveBeenCalledTimes(1)
		expect(migration4).toHaveBeenCalledTimes(1)
		expect(migration5).toHaveBeenCalledTimes(1)
	})

	test("migrate to lower version than current version does nothing", async () => {
		const { database } = await setupTest()

		const migration2 = jest.fn()
		const migration3 = jest.fn()
		const migration4 = jest.fn()
		const migration5 = jest.fn()

		const migrations = new Map<number, IMigration>()
		migrations.set(5, Migration(migration5))
		migrations.set(2, Migration(migration2))
		migrations.set(3, Migration(migration3))
		migrations.set(4, Migration(migration4))

		const databaseSchema = DatabaseSchema({
			name: "TestSchema",
			client: database,
			createStatements: composeCreateTableStatements(TestTables),
			migrations,
		})

		await databaseSchema.init()
		await databaseSchema.migrateToVersion(4)
		await databaseSchema.migrateToVersion(2)

		expect(databaseSchema.getVersion()).toBe(4)
		expect(migration2).toHaveBeenCalledTimes(1)
		expect(migration3).toHaveBeenCalledTimes(1)
		expect(migration4).toHaveBeenCalledTimes(1)
		expect(migration5).not.toBeCalled()
	})

	test("migrate to version lower 2 fails", async () => {
		const { database } = await setupTest()

		const migrations = new Map<number, IMigration>()
		const databaseSchema = DatabaseSchema({
			name: "TestSchema",
			client: database,
			createStatements: composeCreateTableStatements(TestTables),
			migrations,
		})

		await databaseSchema.init()
		await expect(databaseSchema.migrateToVersion(1)).rejects.toThrowError(
			"Target version of migrateToVersion() has to be greater 1",
		)
		await expect(databaseSchema.migrateToVersion(0)).rejects.toThrowError(
			"Target version of migrateToVersion() has to be greater 1",
		)
		await expect(databaseSchema.migrateToVersion(-5)).rejects.toThrowError(
			"Target version of migrateToVersion() has to be greater 1",
		)
	})
})

describe("multi-node environment", () => {
	const simulateNode = async (nodeOprations: (...args: any[]) => Promise<void>, nodeName: string) => {
		await nodeOprations(nodeName)
	}

	test("test", async () => {
		const { database } = await setupTest()

		const migration2 = jest.fn()
		const migration3 = jest.fn()
		const migration4 = jest.fn()
		const migration5 = jest.fn()

		const migrations = new Map<number, IMigration>()
		migrations.set(5, Migration(migration5))
		migrations.set(2, Migration(migration2))
		migrations.set(3, Migration(migration3))
		migrations.set(4, Migration(migration4))

		const operations = async (nodeName: string) => {
			const databaseSchema = DatabaseSchema({
				name: "TestSchema",
				client: database,
				createStatements: composeCreateTableStatements(TestTables),
				migrations,
			})

			await databaseSchema.init()
			await databaseSchema.migrateLatest()

			expect(databaseSchema.getVersion()).toBe(5)
		}

		await Promise.all([
			simulateNode(operations, "Node1"),
			simulateNode(operations, "Node2"),
			simulateNode(operations, "Node3"),
			simulateNode(operations, "Node4"),
		])

		expect(migration2).toHaveBeenCalledTimes(1)
		expect(migration3).toHaveBeenCalledTimes(1)
		expect(migration4).toHaveBeenCalledTimes(1)
		expect(migration5).toHaveBeenCalledTimes(1)
	})
})
