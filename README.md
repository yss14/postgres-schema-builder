# postgres-schema-builder
Simple postgres schema builder for Node.JS leveraging Typescript's type system to enable typesafe queries

[![Build Status](https://travis-ci.com/yss14/postgres-schema-builder.svg?branch=master)](https://travis-ci.com/yss14/postgres-schema-builder)
[![Dependabot Status](https://api.dependabot.com/badges/status?host=github&repo=yss14/postgres-schema-builder)](https://dependabot.com)
[![codecov](https://codecov.io/gh/yss14/postgres-schema-builder/branch/master/graph/badge.svg)](https://codecov.io/gh/yss14/postgres-schema-builder)

## Installation
`npm i postgres-schema-builder` or `yarn add postgres-schema-builder`

## Usage

If you need a reference project which uses `postgres-schema-builder`, have a look at [musicshare](https://github.com/yss14/musicshare/tree/master/projects/backend/src/database).

### Schema definition

The recommended way to define your database schema is to export a namespace indicating the schema version. The namespace itself contains the table definitions.

```typescript
// DatabaseV1.ts
import { TableSchema, ColumnType, NativeFunction, ForeignKeyUpdateDeleteRule, JSONType } from "postgres-schema-builder"

export namespace DatabaseV1 {
    const baseSchema = TableSchema({
		date_added: { type: ColumnType.TimestampTZ, nullable: false, defaultValue: { func: NativeFunction.Now } },
		date_removed: { type: ColumnType.TimestampTZ, nullable: true },
	})

	export const users = TableSchema({
		...baseSchema,
		user_id: { type: ColumnType.Integer, primaryKey: true, unique: true },
        name: { type: ColumnType.Varchar, nullable: false },
        settings: { type: JSONType<ISomeSettingsInterface>(), nullable: false },
    })

    export const user_emails = TableSchema({
        user_id_ref: {type: ColumnType.Integer, primaryKey: true, nullable: false, foreignKeys: [{ targetTable: 'users', targetColumn: 'user_id', onDelete: ForeignKeyUpdateDeleteRule.Cascade }]},
        email: { type: ColumnType.Varchar, primaryKey: true, nullable: false },
    })
    
    // ...more tables
}
```

All available `ColumnType`s can be found in the [`table.ts file`](https://github.com/yss14/postgres-schema-builder/blob/master/src/table.ts#L78).

### Interfaces and Table API

After defining the tables of our schema, we can create and export an interface for each table, which contains each column as `key`, as well as the respective TypeScript type infered from the column's `ColumnType`.

Furthermore, we can also create a table object for each table entry of our schema, which provides useful API methods for typesafe queries.

```typescript
// tables.ts
import { TableRecord, Table } from "postgres-schema-builder"
import { DatabaseV1 } from "./DatabaseV1"

export const Tables = DatabaseV1

export interface IUserDBResult extends TableRecord<typeof Tables.users> { }
export interface IUserEMailDBResult extends TableRecord<typeof Tables.user_emails> { }
// ...more interfaces, for each table one interface

export const UsersTable = Table(Tables, 'users')
export const UserEMailsTable = Table(Tables, 'user_emails')
// ...more table objects, for each table one object
```

### Queries

Now, we can use our exported table objects to create typesafe queries.

```typescript
import { SQL } from "postgres-schema-builder"
import { UsersTable, UserEMailsTable} from "./tables.ts"

UsersTable.create() // table create statement
UsersTable.drop() // table drop statement

UsersTable.insert(['name'])(['Fresh Herrmann']) // insert new entry
UsersTable.insert(['name'])([null]) // compiler error, since name is not nullable
UsersTable.insertFromObj({
	name: 'Fresh Herrmann',
	date_added: new Date(),
	settings: {a: 42, b: 'no'},
})

UsersTable.select('*', ['user_id'])([42]) // select all columns where user_id=42
UsersTable.select(['user_id', 'name'], ['name'])(['Fresh Herrmann']) // select only user_id and name where name='Fresh Herrmann'

UsersTable.selectAll('*') // select all entries from users
UsersTable.selectAll(['name']) // select all names from users

UsersTable.update(['name'], ['user_id'])(['Freshly Fresh Herrmann'], [42]) // update entry's name where user_id=42

UsersTable.delete(['user_id'])([1]) // delete where user_id=1
UsersTable.delete(['user_id'])(['abcd']) // compiler error, since user_id has type number

// create custom query using a join
const query = SQL.raw<typeof Tables.users & typeof Tables.user_emails>(`
	SELECT *
	FROM ${UsersTable.name} u
	INNER JOIN ${UserEMailsTable.name} e ON u.user_id = e.user_id_ref
	WHERE u.date_removed IS NULL
		AND u.user_id = $1;
`, [42])
```

### Schema Management + Migrations

```typescript
// database schema init, e.g. database.ts

import {
	DatabaseSchema,
	composeCreateTableStatements,
} from "postgres-schema-builder"

const migrations = Migrations()

const schema = DatabaseSchema({
	client: database,
	name: "MyDatabaseSchema",
	createStatements: composeCreateTableStatements(Tables),
	migrations,
})

await schema.init()
await schema.migrateLatest()

// database migrations, e.g. migrations.ts

export const Migrations = () => {
	const migrations = new Map<number, IMigration>()

	migrations.set(
		2,
		Migration(async ({ transaction }) => {
			await transaction.query(
				SQL.raw(SQL.addColumns("song_types", { song_type_id: { type: ColumnType.UUID, nullable: true } })),
			)
			await transaction.query(SQL.raw(SQL.addColumns("genres", { genre_id: DatabaseV2.genres.genre_id })))

			await transaction.query(
				SQL.raw(`
				UPDATE genres SET genre_id = uuid_generate_v4();
				UPDATE song_types SET song_type_id = uuid_generate_v4();
			`),
			)

			...
		}),
	)

	migrations.set(
		3,
		Migration(async ({ transaction }) => {
			await transaction.query(SQL.raw(SQL.createTable("captchas", DatabaseV3.captchas)))
			await transaction.query(SQL.raw(SQL.createIndex(true, "users", "email")))
		}),
	)

    // migration with schema diff detection
	migrations.set(
		4,
		Migration(async ({ database }) => {
			const updates: IQuery<{}>[] = []
			const diffs = SchemaDiff(DatabaseV3, DatabaseV4)

			updates.push(
				SQL.raw(
					diffs.addRequiredColumn("shares", "quota", [
						`UPDATE shares SET quota = ${defaultShareQuota} WHERE is_library = True;`,
						`UPDATE shares SET quota = 0 WHERE is_library = False;`,
					]),
				),
			)
			updates.push(SQL.raw(diffs.addTableColumn("shares", "quota_used")))

			const SongsTableV4 = Table(DatabaseV4, "songs")
			const songs = await database.query(SongsTableV4.selectAll("*"))
			songs.forEach((song) =>
				updates.push(
					SongsTableV4.update(["sources"], ["song_id"])(
						[
							{
								data: song.sources.data.map((source) => ({ ...source, fileSize: 0 })),
							},
						],
						[song.song_id],
					),
				),
			)

			return updates
		}),
	)

	return migrations
}
```

### Database Client

`postgres-schema-builder` also provides a small database client to perform our typesafe and custom queries.

```typescript
import { DatabaseClient } from "postgres-schema-builder"
import { Pool } from "pg"
import { UsersTable, Tables} from "./tables.ts"
import { config } from "./some-config.ts"

const database = DatabaseClient(
	new Pool({
		host: config.database.host,
		port: config.database.port,
		user: config.database.user,
		password: config.database.password,
		database: config.database.database,
	})
);

// single query statements
await database.query(
    UsersTable.create()
)
await database.query(
    UsersTable.insertFromObj({
        name: 'Fresh Herrmann',
        date_added: new Date(),
        settings: { a: 42, b: 'no' },
    })
)
const dbResults = await database.query(UsersTable.selectAll('*'))

// batch queries
const insertStatements = someDataArray.map(entry => UsersTable.insertFromObj(entry))

await database.batch(insertStatements)

// leverage transaction creating your database schema
const createTableStatements = composeCreateTableStatements(Tables) // performs a topological sort on your tables defined in <Tables>

await database.transaction(async (client) => {
	createTableStatements.forEach(createTableStatement => client.query({ sql: createTableStatement }))
});
```

## Todos

* Improve and extend docs
* Allow `insert` and `insertFromObj` returning the inserted data
* Enable client to perform multiple queries
* Extend test cases and improve code coverage

## Support

### Node.js
Currently, this package is automatically tested under Node.js versions `8 - 13`.
All build artifact are compiled to ES6.

### PostgreSQL
Tested under `v9.6`, might work for newer versions as well.

## Contributors
* Yannick Stachelscheid ([@yss14](https://github.com/yss14))

## License
This project is licensed under the [MIT](LICENSE) license.