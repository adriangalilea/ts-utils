/**
 * Worker import-safety tripwire. The bot subpaths (everything a Telegram
 * bot on Cloudflare Workers consumes) must be importable off Node: no
 * `node:*` module and no `platform/` module (kev walks the filesystem)
 * anywhere in their static import graph, and no import-time side effects
 * that assume an OS. `bot/kit` is the deliberate exception — it owns the
 * Node-only pieces (gracefulStart's process-signal wiring, kev env reads) and
 * sits in NODE_ONLY below.
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

const ROOT = resolve(import.meta.dirname, "..");
const DIST = resolve(ROOT, "dist");

/**
 * Subpaths that reach Node on purpose: the root barrel and `cli` pull
 * `platform/` (kev walks the filesystem), `bot/kit` wires process
 * signals, `metrics/cli` renders through `cli`. Everything else in the
 * exports map is a Worker surface and is checked below, so a new
 * subpath is guarded the moment it is published.
 */
const NODE_ONLY = new Set([".", "./cli", "./bot/kit", "./metrics/cli"]);

type ExportsMap = Record<string, { default: string }>;
const { exports: exportsMap } = JSON.parse(
	readFileSync(resolve(ROOT, "package.json"), "utf8"),
) as { exports: ExportsMap };

const SAFE_ENTRIES = Object.entries(exportsMap)
	.filter(([subpath]) => !NODE_ONLY.has(subpath))
	.map(([, target]) => target.default.replace(/^\.\/dist\//, ""));

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
