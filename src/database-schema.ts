import { IDatabaseClient, IDatabaseBaseClient } from './database-client'
import { TableSchema, ColumnType, NativeFunction, Table } from './table';

const schema_management = TableSchema({
    name: { type: ColumnType.Varchar, primaryKey: true, nullable: false },
    version: { type: ColumnType.Integer, nullable: false },
    date_added: { type: ColumnType.TimestampTZ, nullable: false, defaultValue: { func: NativeFunction.Now } },
})
const SchemaManagementTable = Table({ schema_management }, 'schema_management')

const selectVersionQuery = (name: string) => SchemaManagementTable.select('*', ['name'])([name])
const insertSchemaQuery = (name: string, version: number) => SchemaManagementTable.insertFromObj({ name, version })
const updateSchemaVersionQuery = (name: string, newVersion: number) => SchemaManagementTable.update(['version'], ['name'])([newVersion], [name])

export interface IDatabaseSchema {
    readonly name: string;
    getVersion(): number;
    init(): Promise<void>;
    migrateLatest(): Promise<void>;
    migrateToVersion(version: number): Promise<void>;
}

export interface IMigration {
    up: (client: IDatabaseBaseClient) => Promise<void>;
}

export const Migration = (up: (client: IDatabaseBaseClient) => Promise<void>): IMigration => ({ up })

export type CreateStatement = string

export interface IDatabaseSchemaArgs {
    name: string;
    client: IDatabaseClient;
    createStatements: CreateStatement[];
    migrations: Map<number, IMigration>;
    logMigrations?: boolean;
}

export const DatabaseSchema = ({ client, createStatements, name, migrations, logMigrations }: IDatabaseSchemaArgs): IDatabaseSchema => {
    let version = 0
    let isInitialized = false

    const init = async () => {
        if (isInitialized) {
            throw new Error(`Database schema ${name} has already been initialized.`)
        }

        await client.transaction(async (transaction) => {
            await transaction.query(SchemaManagementTable.create())

            const versionDBResults = await transaction.query(selectVersionQuery(name))

            if (versionDBResults.length === 0) {
                await transaction.query({
                    sql: createStatements.join('\n')
                })
                await transaction.query(insertSchemaQuery(name, 1))

                version = 1
            } else {
                version = versionDBResults[0].version
            }
        })

        isInitialized = true
    }

    const throwNotInitialized = () => {
        throw new Error(`Migration failed, database schema is not initialized. Please call init() first on your database schema.`)
    }

    const migrateToVersion = async (targetVersion: number) => {
        if (!isInitialized) throwNotInitialized()

        if (targetVersion <= 1) {
            throw new Error('Target version of migrateToVersion() has to be greater 1')
        }

        const currentVersion = version

        for (let newVersion = currentVersion + 1; newVersion <= targetVersion; newVersion -= -1) {
            await client.transaction(async (transaction) => {
                const migration = migrations.get(newVersion)

                if (!migration) {
                    throw new Error(`Migration with version ${newVersion} not found. Aborting migration process...`)
                }

                await migration.up(transaction)
                await transaction.query(updateSchemaVersionQuery(name, newVersion))
            })

            version = newVersion

            // istanbul ignore next
            if (!(logMigrations === false)) {
                console.info(`Successfully migrated ${name} from version ${version - 1} to ${version}`)
            }
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

