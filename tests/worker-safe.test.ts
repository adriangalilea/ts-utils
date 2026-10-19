/**
 * Worker import-safety tripwire. Every published subpath of every package
 * (everything a Telegram bot or a site on Cloudflare Workers consumes) must
 * be importable off Node: no `node:*` module and no `platform/` module (kev
 * walks the filesystem) anywhere in its static import graph, and no
 * import-time side effects that assume an OS. The subpaths in NODE_ONLY are
 * the deliberate exceptions.
 *
 * The graph crosses packages: `@adriangalilea/bot/menu` importing
 * `@adriangalilea/utils/log` is followed into utils' dist through utils'
 * own exports map, so splitting the repo hides no edge from this check.
 *
 * Two layers:
 *   1. Static: walk each safe entry's import graph in the built dist/,
 *      relative and @adriangalilea/* specifiers alike; no node:* specifier,
 *      no platform/ module, no NODE_ONLY module.
 *   2. Dynamic: import every safe entry; a top-level throw fails loudly.
 *
 * Run: pnpm test:repo   (builds every package first)
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PACKAGES = resolve(import.meta.dirname, "..", "packages");

type ExportsMap = Record<string, { default: string }>;
type Pkg = { dir: string; name: string; exports: ExportsMap };

const packages: Pkg[] = readdirSync(PACKAGES).map((d) => {
	const dir = join(PACKAGES, d);
	const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
		name: string;
		exports: ExportsMap;
	};
	return { dir, name: json.name, exports: json.exports };
});

/**
 * Subpaths that reach Node on purpose: utils' root barrel and `cli` pull
 * `platform/`, `kev` is platform, bot's `kit` wires process signals, and
 * metrics' `cli` renders through utils' `cli`. Everything else is a Worker
 * surface and is checked, so a new subpath is guarded the moment it exists.
 */
const NODE_ONLY = new Set([
	"@adriangalilea/utils",
	"@adriangalilea/utils/cli",
	"@adriangalilea/utils/kev",
	"@adriangalilea/bot/kit",
	"@adriangalilea/metrics/cli",
]);

const specOf = (pkg: Pkg, subpath: string) =>
	subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;

/** The dist file a specifier of one of our packages lands on, or undefined. */
function resolveOurs(spec: string): { file: string; spec: string } | undefined {
	const pkg = packages.find(
		(p) => spec === p.name || spec.startsWith(`${p.name}/`),
	);
	if (!pkg) return undefined;
	const subpath =
		spec === pkg.name ? "." : `./${spec.slice(pkg.name.length + 1)}`;
	const target = pkg.exports[subpath];
	if (!target) throw new Error(`${spec}: ${pkg.name} exports no ${subpath}`);
	return { file: resolve(pkg.dir, target.default), spec };
}

const IMPORT_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']\s*\)?/g;

/** Every file the entry reaches, each with the specifier it was reached by. */
function graphOf(entry: string, entryFile: string): Map<string, string> {
	const seen = new Map<string, string>();
	const queue: [string, string][] = [[entryFile, entry]];
	while (queue.length) {
		const next = queue.pop();
		if (!next) break;
		const [file, via] = next;
		if (seen.has(file)) continue;
		seen.set(file, via);
		// Strip comments: JSDoc usage examples contain import statements.
		const source = readFileSync(file, "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		for (const match of source.matchAll(IMPORT_RE)) {
			const spec = match[1];
			if (!spec) continue;
			if (spec.startsWith(".")) queue.push([resolve(dirname(file), spec), via]);
			else if (spec.startsWith("node:"))
				throw new Error(`${entry}: reaches ${spec} via ${file}`);
			else {
				const ours = resolveOurs(spec);
				if (ours) {
					if (NODE_ONLY.has(ours.spec))
						throw new Error(
							`${entry}: reaches Node-only ${ours.spec} via ${file}`,
						);
					queue.push([ours.file, ours.spec]);
				}
				// other bare specifiers (gramio, zod, …) are peers: a Worker bundler
				// resolves them against the consumer, not this graph.
			}
		}
	}
	return seen;
}

let checked = 0;
for (const pkg of packages)
	for (const [subpath, target] of Object.entries(pkg.exports)) {
		const entry = specOf(pkg, subpath);
		if (NODE_ONLY.has(entry)) continue;
		const file = resolve(pkg.dir, target.default);
		for (const reached of graphOf(entry, file).keys())
			if (reached.includes("/platform/"))
				throw new Error(`${entry}: platform module in graph, ${reached}`);
		await import(file); // import-time side effects scream here
		checked++;
	}

console.log(
	`✓ worker-safe: ${checked} entries across ${packages.length} packages, graphs clean, imports ran`,
);
