import type { MetricsDriver, SqlStatement } from "./sqlite.js";

/** The slice of `@libsql/client` the metrics driver touches, typed structurally: no client is bundled. */
export interface LibsqlClient {
	execute(statement: SqlStatement): Promise<{
		rows: Iterable<Record<string, unknown>>;
	}>;
	batch(statements: SqlStatement[], mode: "write"): Promise<unknown>;
}

/** A Turso / libSQL / sqld connection as a metrics driver; `batch` in write mode is one transaction. */
export function libsqlDriver(client: LibsqlClient): MetricsDriver {
	return {
		query: async (statement) => (await client.execute(statement)).rows,
		transact: (statements) => client.batch(statements, "write"),
	};
}
