import type { MetricsReader } from "./sqlite.js";

export interface D1RestOptions {
	accountId: string;
	databaseId: string;
	/** A Cloudflare API token with D1 read on the database. */
	token: string;
	fetch?: typeof fetch;
}

/**
 * A D1 database read over Cloudflare's REST API, for a process that has no binding
 * (a Next server, a CLI). A reader only: one REST call cannot transact, so writes stay
 * with `metrics/d1` inside the Worker that owns the binding.
 */
export function d1RestReader(options: D1RestOptions): MetricsReader {
	const url = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/d1/database/${options.databaseId}/query`;
	const call = options.fetch ?? fetch;
	return {
		async query({ sql, args }) {
			const response = await call(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${options.token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ sql, params: args }),
			});
			const data = (await response.json()) as {
				success: boolean;
				errors?: { message: string }[];
				result?: { results: Record<string, unknown>[] }[];
			};
			if (!response.ok || !data.success)
				throw new Error(
					`metrics: d1 ${data.errors?.[0]?.message ?? response.status}`,
				);
			return data.result?.[0]?.results ?? [];
		},
	};
}
