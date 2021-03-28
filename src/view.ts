import { SQL } from "./sql"
import { ITable, Columns, Table } from "./table"
import { typedPick } from "./typed-pick"

export interface IView<C extends Columns> extends Pick<ITable<C>, "name" | "create" | "selectAll" | "select" | "drop"> {
	readonly sql: string
	readonly dependencies: string[]
}

interface ViewArgs<Tbls extends { [key: string]: Columns }, Tbl extends Extract<keyof Tbls, string>> {
	views: Tbls
	view: Tbl
	query: string
	dependencies: string[]
}

export const View = <Tbls extends { [key: string]: Columns }, Tbl extends Extract<keyof Tbls, string>>({
	view,
	views,
	query,
	dependencies = [],
}: ViewArgs<Tbls, Tbl>): IView<Tbls[Tbl]> => {
	return {
		...typedPick(Table(views, view), "name", "select", "selectAll"),
		create: () => ({
			sql: SQL.createView(view, query),
		}),
		drop: () => ({
			sql: SQL.dropView(view),
		}),
		sql: query,
		dependencies,
	}
}
