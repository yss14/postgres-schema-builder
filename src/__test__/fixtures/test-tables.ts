import { TableSchema, ColumnType, ForeignKeyUpdateDeleteRule, Table } from "../../table"

export namespace TestTables {
	export const test_table_a = TableSchema({
		id: { type: ColumnType.Integer, primaryKey: true, autoIncrement: true },
		some_str: { type: ColumnType.Varchar, nullable: false, createIndex: true, unique: true },
	})

	export const test_table_b = TableSchema({
		id: { type: ColumnType.Integer, primaryKey: true, autoIncrement: true },
		test_id_ref: {
			type: ColumnType.Integer,
			foreignKeys: [
				{ targetTable: "test_table_a", targetColumn: "id", onUpdate: ForeignKeyUpdateDeleteRule.Cascade },
			],
		},
	})

	export const test_table_all_types = TableSchema({
		id: { type: ColumnType.Integer, primaryKey: true, autoIncrement: true },
		some_string: { type: ColumnType.Varchar, nullable: false },
		some_string_nullable: { type: ColumnType.Varchar, nullable: true },
		some_bool: { type: ColumnType.Boolean, nullable: false },
		some_date: { type: ColumnType.Date, nullable: false },
		some_timestamp: { type: ColumnType.Timestamp, nullable: false },
		some_uuid: { type: ColumnType.UUID, nullable: false },
	})
}

export const TestTableA = Table(TestTables, "test_table_a")
export const TestTableB = Table(TestTables, "test_table_b")
export const TestTableAllTypes = Table(TestTables, "test_table_all_types")

export const TestTableAllTypesV2 = Table(
	{
		test_table_all_types: TableSchema({
			...TestTables.test_table_all_types,
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
		}),
	},
	"test_table_all_types",
)
