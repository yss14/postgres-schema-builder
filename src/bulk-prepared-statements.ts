import { IQuery } from "./table"

const mapValue = (value: unknown) => {
	if (typeof value === "boolean") return value.toString()
	if (typeof value === "number") return value.toString()
	if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`
	if (typeof value === "object") return `'${JSON.stringify(value).replace(/'/g, "''")}'`

	throw new Error(`Cannot map value ${value}`)
}

export const bulkPreparedStatements = (queries: IQuery<any>[]): string => {
	let bulkQuery = ""

	for (const { sql, values } of queries) {
		let _sql = sql

		values?.forEach((value, idx) => {
			_sql = sql.replace(new RegExp("\\$" + (idx + 1), "g"), mapValue(value))
		})

		bulkQuery += `${_sql}\n`
	}

	return bulkQuery
}
