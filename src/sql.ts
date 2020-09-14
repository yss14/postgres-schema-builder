import {
	Columns,
	Column,
	IReferenceConstraintInternal,
	isCollection,
	isSQLFunction,
	ForeignKeyUpdateDeleteRule,
	ICreateIndexStatement,
	IQuery,
	isJSONType,
	IWhereConditionColumned,
	ISQLArg,
} from "./table"
import pgEscape from "pg-escape"
import { dateToSQLUTCFormat } from "./sql-utils"
import moment from "moment"
import { flatten } from "./utils"

const isStringArray = (arr: any): arr is string[] => Array.isArray(arr) && arr.every((item) => typeof item === "string")

export namespace SQL {
	export const createDatabase = (name: string) => `CREATE DATABASE ${name};`

	export const createTable = (name: string, columns: Columns): string => {
		const entries = Object.entries(columns).map(([name, column]) => ({ name, ...column }))
		const foreignKeyConstraints: IReferenceConstraintInternal[] = collectForeignKeyConstraints(entries)

		const primaryKeyColoumns = entries.filter((col) => {
			return col.primaryKey !== undefined && col.primaryKey
		})

		if (primaryKeyColoumns.length === 0) {
			throw new Error(`Primary Key(s) missing. Cannot create table ${name}.`)
		}

		const createTableQuery = `
                CREATE TABLE IF NOT EXISTS ${name} (
				${entries
					.map(prepareCreateColumnStatement)
					.concat([
						`CONSTRAINT PK_${name}_${primaryKeyColoumns
							.map((pkc) => pkc.name)
							.join("_")} PRIMARY KEY (${primaryKeyColoumns.map((pkc) => `"${pkc.name}"`).join(",")})`,
					])
					.concat(
						prepareForeignKeyConstraintStatements(name, foreignKeyConstraints).map(
							(stmt) => `CONSTRAINT ${stmt}`,
						),
					)
					.join(",\n")}
            );
		`

		const indexStatements: ICreateIndexStatement[] = entries
			.filter((col): boolean => {
				return (col.unique !== undefined && col.unique) || (col.createIndex !== undefined && col.createIndex)
			})
			.map((col) => {
				return {
					column: col.name,
					unique: col.unique !== undefined && col.unique,
				}
			})

		const createIndexQueries = indexStatements.map((indexStatement) =>
			createIndex(indexStatement.unique, name, indexStatement.column),
		)

		return `
			${createTableQuery}
			${createIndexQueries.join("\n")}
		`
	}

	export const addColumns = (tableName: string, columns: Columns): string => {
		const entries = Object.entries(columns).map(([name, column]) => ({ name, ...column }))
		const foreignKeyConstraints: IReferenceConstraintInternal[] = collectForeignKeyConstraints(entries)

		const addForeignKeyConstraintsStatements = `
			${prepareForeignKeyConstraintStatements(tableName, foreignKeyConstraints)
				.map((constraint) => `ALTER TABLE ${tableName} ADD CONSTRAINT ${constraint}`)
				.join(";\n")}
		`

		const addTableColumnStatement = `
			ALTER TABLE ${tableName}
			${entries.map((entry) => `ADD COLUMN ${prepareCreateColumnStatement(entry)}`).join(",\n")};
		`

		return `
			${addTableColumnStatement}
			${addForeignKeyConstraintsStatements}
		`
	}

	type DropColumns = {
		(tableName: string, columns: Columns): string
		(tableName: string, columns: string[], constraints?: string[]): string
	}

	export const dropColumns: DropColumns = (
		tableName: string,
		columns: Columns | string[],
		constraints?: string[],
	): string => {
		const columnNames = isStringArray(columns) ? columns : Object.keys(columns)
		let constraintNames: string[] = []

		if (constraints && constraints.length > 0) {
			constraintNames = constraints
		} else if (!isStringArray(columns)) {
			const entries = Object.entries(columns).map(([name, column]) => ({ name, ...column }))
			const foreignKeyConstraints = collectForeignKeyConstraints(entries)

			constraintNames = foreignKeyConstraints.map((fkc) => `${tableName}_${fkc.column}_fkey`)
		}

		const dropTableColumnsStatement = `
			ALTER TABLE ${tableName}
			${columnNames.map((column) => `DROP COLUMN ${column}`).join(",\n")};
		`

		const dropConstraintsStatement = constraintNames
			.map((constraint) => `ALTER TABLE ${tableName} DROP CONSTRAINT ${constraint};`)
			.join("\n")

		return `
			${dropConstraintsStatement}
			${dropTableColumnsStatement}
		`
	}

	export const insert = (tableName: string, subset: string[]) => {
		const cql =
			`INSERT INTO ${tableName}` +
			` ( ${subset.map((column) => `"${column}"`).join(", ")} )` +
			` VALUES ( ${subset.map((_, idx) => `$${idx + 1}`).join(", ")} );`

		return cql
	}

	export const update = (tableName: string, subset: string[], where: string[]) => {
		const cql =
			`UPDATE ${tableName} ` +
			`SET ${subset.map((col, idx) => `"${col}" = $${idx + 1}`).join(", ")} ` +
			`WHERE ${where.map((col, idx) => `"${col}" = $${subset.length + idx + 1}`).join(" AND ")};`

		return cql
	}

	export const selectAll = (tableName: string, subset: string[] | "*") => {
		const cql = `SELECT ${subset === "*" ? "*" : subset.join(", ")} ` + `FROM ${tableName};`

		return cql
	}

	const whereConditionToString = (cond: string | ISQLArg, idx: number) => {
		if (typeof cond === "string") {
			return `("${cond}" = $${idx + 1})`
		}

		return cond.toString()
	}

	type Select = {
		(tableName: string, subset: string[] | "*", where: string[]): string
		(tableName: string, subset: string[] | "*", where: ISQLArg[]): string
	}

	export const select: Select = (
		tableName: string,
		subset: string[] | "*",
		where: (string | IWhereConditionColumned)[],
	) => {
		const cql =
			`SELECT ${subset === "*" ? "*" : subset.map((column) => `"${column}"`).join(", ")}` +
			` FROM ${tableName}` +
			` WHERE ${where.map(whereConditionToString).join(" AND ")}` +
			`;`

		return cql
	}

	export const deleteEntry = (tableName: string, where: string[]) => {
		const cql =
			`DELETE` +
			` FROM ${tableName}` +
			` WHERE ${where.map((column, i) => `("${column}" = $${i + 1})`).join(" AND ")}` +
			`;`

		return cql
	}

	export const dropTable = (tableName: string, dropConstraints?: boolean) => {
		const statements: string[] = []

		if (dropConstraints === true) {
			statements.push(dropAllConstraintsOfTable(tableName))
		}

		statements.push(`DROP TABLE ${tableName};`)

		return statements.join("\n")
	}

	export const dropTableColumn = (tableName: string, column: string, cascade?: boolean): string => {
		const sql = `
			ALTER TABLE ${tableName}
			DROP COLUMN IF EXISTS ${column} ${cascade === true ? "CASCADE" : ""};
		`

		return sql
	}

	export const addTableColumn = (
		tableName: string,
		column: { name: string } & Column,
		ifNotExists: boolean = false,
	): string => {
		let foreignKeyConstraints = collectForeignKeyConstraints([column])

		const sql = `
			ALTER TABLE ${tableName}
			ADD COLUMN ${ifNotExists ? "IF NOT EXISTS" : ""} ${prepareCreateColumnStatement(column)};
			${
				foreignKeyConstraints.length > 0
					? prepareForeignKeyConstraintStatements(tableName, foreignKeyConstraints)
							.map((stmt) => `ALTER TABLE ${tableName} ADD CONSTRAINT ${stmt};`)
							.join("\n")
					: ""
			}
		`

		return sql
	}

	export const dropConstraint = (tableName: string, col: string, info: Column) => {
		return (info.foreignKeys || [])
			.map(
				(fkc) => `
				ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS ${tableName}_${col}_fkey CASCADE;
			`,
			)
			.join("\n")
	}

	const dropAllConstraintsOfTable = (table: string): string => {
		const sql = `
			SELECT 'ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS "' || relname || '";' as pg_drop
			FROM pg_class
			WHERE (relkind = 'i' OR relkind = 'p' OR relkind = 'f') AND relname LIKE '${table.toLowerCase()}%';
		`

		return sql
	}

	export const createIndex = (unique: boolean, name: string, column: string): string => {
		const sql = `CREATE ${unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${name}_${column}_${
			unique ? "u" : ""
		}index ON ${name} (${column});`

		return sql
	}

	export const raw = <T extends {}>(sql: string, values: unknown[] = []): IQuery<T> => ({
		sql,
		values,
	})
}

const collectForeignKeyConstraints = (columns: ({ name: string } & Column)[]): IReferenceConstraintInternal[] => {
	return flatten(
		columns.map((col) => (col.foreignKeys ? col.foreignKeys.map((fkc) => ({ ...fkc, column: col.name })) : [])),
	)
}

const prepareCreateColumnStatement = (col: { name: string } & Column): string => {
	const replaceArr: any[] = []

	if (col.defaultValue !== undefined) {
		replaceArr.push(col.defaultValue)
	}

	return (
		`"${col.name}" ${!col.autoIncrement ? mapColumnType(col) : ""} ` +
		`${col.autoIncrement ? "SERIAL " : ""}` +
		`${col.nullable !== undefined && !col.nullable ? "NOT NULL " : ""}` +
		`${
			col.defaultValue !== undefined
				? `DEFAULT ${isSQLFunction(col.defaultValue) ? col.defaultValue.func : mapValues(col.defaultValue)}`
				: ""
		}`
	)
}

const prepareForeignKeyConstraintStatements = (
	tableName: string,
	foreignKeyConstraints: IReferenceConstraintInternal[],
): string[] => {
	return foreignKeyConstraints.map(
		(fkc) =>
			`${tableName}_${fkc.column}_fkey
			FOREIGN KEY (${fkc.column}) REFERENCES ${fkc.targetTable} (${fkc.targetColumn})
			${fkc.onDelete !== undefined ? mapUpdateDeleteRule(fkc.onDelete, false) : ""}
			${fkc.onUpdate !== undefined ? mapUpdateDeleteRule(fkc.onUpdate, true) : ""}`,
	)
}

const mapColumnType = (col: Column) => {
	if (isJSONType(col.type)) {
		return "JSON"
	} else if (isCollection(col.type)) {
		return col.type.type.toUpperCase() + "[]"
	} else {
		return col.type.toUpperCase()
	}
}

const mapValues = (val: any): any => {
	if (val === undefined || val === null) {
		return "NULL"
	} else if (typeof val === "string") {
		return pgEscape("%L", val)
	} else if (moment.isMoment(val)) {
		return `'${dateToSQLUTCFormat(val.utc().toDate())}'`
	} else if (val instanceof Date) {
		return `'${dateToSQLUTCFormat(val)}'`
	} else if (typeof val === "object") {
		return mapValues(JSON.stringify(val))
	} else {
		return val
	}
}

const mapUpdateDeleteRule = (rule: ForeignKeyUpdateDeleteRule, isUpdate: boolean): string => {
	const prefix = isUpdate ? "UPDATE" : "DELETE"

	switch (rule) {
		case ForeignKeyUpdateDeleteRule.Cascade:
			return `ON ${prefix} CASCADE`
		case ForeignKeyUpdateDeleteRule.NoAction:
			return ""
		case ForeignKeyUpdateDeleteRule.Restrict:
			return ""
		case ForeignKeyUpdateDeleteRule.SetDefault:
			return `ON ${prefix} SET DEFAULT`
		case ForeignKeyUpdateDeleteRule.SetNull:
			return `ON ${prefix} SET NULL`
	}
}
