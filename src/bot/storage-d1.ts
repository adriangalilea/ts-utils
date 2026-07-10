/**
 * A `@gramio/storage` adapter over a Cloudflare D1 table — the per-user
 * session blobs (language pick, consent, menu position, payments cache).
 * Follows gramio's own write-your-adapter recipe (4 methods over JSON).
 *
 * Battle-tested in production (xtldrbot) before moving here.
 *
 * `flush()` exists because `@gramio/session` calls `storage.set()` without
 * awaiting it, and a Worker freezes the isolate the instant `fetch()`
 * returns, killing in-flight writes (consent wouldn't stick). Every write
 * is tracked; hand `flush()` to `ctx.waitUntil()` — `bot/worker` does this
 * automatically when you pass it a `flush`.
 *
 * Table schema (create it in your migrations):
 *
 *   CREATE TABLE session (
 *     key TEXT PRIMARY KEY,
 *     value TEXT NOT NULL,
 *     expires INTEGER            -- reserved for future TTL use
 *   );
 *
 * No `@cloudflare/workers-types` dependency: the db is typed structurally
 * (prepare → bind → first/run), so any D1-shaped binding satisfies it.
 */
import type { Storage } from "@gramio/storage";
import { createLogger } from "../universal/log.js";

const log = createLogger("bot/storage-d1");

/** The slice of D1's API this adapter touches — satisfied by a real D1Database binding. */
export type D1Like = {
	prepare(sql: string): {
		bind(...values: unknown[]): {
			first<T = unknown>(): Promise<T | null>;
			run(): Promise<{ meta: { changes?: number } }>;
		};
	};
};

/** A {@link Storage} that also lets the Worker await its in-flight writes. */
export interface FlushableStorage extends Storage {
	/** Resolves once every write issued so far has settled. Never rejects. */
	flush(): Promise<void>;
}

export type D1StorageOptions = {
	db: D1Like;
	/** Table name (default `"session"`). Identifier-validated — SQL can't be injected through it. */
	table?: string;
};

export function d1Storage(opts: D1StorageOptions): FlushableStorage {
	const table = opts.table ?? "session";
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
		throw new Error(`bot/storage-d1: invalid table name "${table}"`);
	}
	const db = opts.db;

	// In-flight writes, awaited by flush(). Stored already error-swallowed so
	// flush() never rejects; a failed write degrades to "looks like a new
	// user", never a crash mid-update.
	const pending = new Set<Promise<unknown>>();
	const track = <T>(promise: Promise<T>): Promise<T | undefined> => {
		const settled = promise.catch((error) => {
			log.error("write failed:", error instanceof Error ? error.message : error);
			return undefined;
		});
		pending.add(settled);
		settled.finally(() => pending.delete(settled));
		return settled;
	};

	return {
		async get(key) {
			try {
				const row = await db
					.prepare(`SELECT value FROM ${table} WHERE key = ?1`)
					.bind(String(key))
					.first<{ value: string }>();
				if (!row) return undefined;
				return JSON.parse(row.value);
			} catch (error) {
				log.error("read failed:", error instanceof Error ? error.message : error);
				return undefined;
			}
		},
		async has(key) {
			try {
				const row = await db
					.prepare(`SELECT 1 AS one FROM ${table} WHERE key = ?1`)
					.bind(String(key))
					.first();
				return row !== null;
			} catch {
				return false;
			}
		},
		async set(key, value) {
			await track(
				db
					.prepare(`INSERT INTO ${table} (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2`)
					.bind(String(key), JSON.stringify(value))
					.run(),
			);
		},
		async delete(key) {
			const res = await track(db.prepare(`DELETE FROM ${table} WHERE key = ?1`).bind(String(key)).run());
			return (res?.meta.changes ?? 0) > 0;
		},
		async flush() {
			await Promise.all([...pending]);
		},
	};
}
