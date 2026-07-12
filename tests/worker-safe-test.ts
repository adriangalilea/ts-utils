/**
 * Worker import-safety tripwire. The bot subpaths (everything a Telegram
 * bot on Cloudflare Workers consumes) must be importable off Node: no
 * `node:*` module and no `platform/` module (kev walks the filesystem)
 * anywhere in their static import graph, and no import-time side effects
 * that assume an OS. `bot/kit` is the deliberate exception — it owns the
 * Node-only pieces (gracefulStart's process-signal wiring, kev env reads) and
 * is excluded from the safe set on purpose.
 *
 * Two layers:
 *   1. Static: BFS the relative-import graph of each safe entry in dist/,
 *      assert no node:* specifier and no platform/ or bot/kit module.
 *   2. Dynamic: import every safe entry — a top-level throw fails loudly.
 *
 * Run: pnpm test:worker-safe   (builds dist first)
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DIST = resolve(import.meta.dirname, "../dist");

// Every subpath a Worker bot consumes. bot/kit and bot/index (which
// re-exports kit) are intentionally absent.
const SAFE_ENTRIES = [
	"bot/ctx.js",
	"bot/keys.js",
	"bot/access-control.js",
	"bot/admin.js",
	"bot/allow-list.js",
	"bot/callbacks.js",
	"bot/coalesce.js",
	"bot/draft.js",
	"bot/language.js",
	"bot/llm.js",
	"bot/menu.js",
	"bot/notify.js",
	"bot/profile.js",
	"bot/flags.js",
	"bot/groups.js",
	"bot/inline-feedback.js",
	"bot/user.js",
	"bot/session.js",
	"bot/storage.js",
	"bot/storage-d1.js",
	"bot/worker.js",
	"bot/create.js",
	"bot/payments/index.js",
	"llm/index.js",
	"say/index.js",
	"tg-html/index.js",
	"tg-md/index.js",
	"offensive.js",
	"universal/log.js",
	"browser.js",
];

const IMPORT_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']\s*\)?/g;

const graphOf = (entry: string): Set<string> => {
	const seen = new Set<string>();
	const queue = [resolve(DIST, entry)];
	while (queue.length) {
		const file = queue.pop();
		if (!file || seen.has(file)) continue;
		seen.add(file);
		// Strip comments — JSDoc usage examples contain import statements.
		const source = readFileSync(file, "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		for (const match of source.matchAll(IMPORT_RE)) {
			const spec = match[1];
			if (!spec) continue;
			if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec));
			else if (spec.startsWith("node:"))
				throw new Error(`${entry}: reaches ${spec} via ${file}`);
			// bare specifiers (gramio, zod, …) are peer deps — Worker bundlers
			// resolve them against the consumer, not this graph. Skip.
		}
	}
	return seen;
};

for (const entry of SAFE_ENTRIES) {
	const graph = graphOf(entry);
	for (const file of graph) {
		if (file.includes("/platform/"))
			throw new Error(`${entry}: platform module in graph — ${file}`);
		if (file.endsWith("/bot/kit.js"))
			throw new Error(`${entry}: bot/kit (Node-only) in graph`);
	}
	await import(resolve(DIST, entry)); // import-time side effects scream here
}

console.log(
	`✓ worker-safe: ${SAFE_ENTRIES.length} entries, graphs clean, imports ran`,
);
