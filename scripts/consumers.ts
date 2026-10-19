/**
 * consumers: does every program that uses these packages still compile against
 * the code in this repo, before it is published?
 *
 * For whoever maintains both these packages and the programs that use them:
 * instead of writing down what changed for them, prove nothing broke. It finds
 * every package.json under the given roots that depends on a package of this
 * workspace, and compiles each consumer twice with its own tsc: as it is (the
 * baseline), and with every import of this workspace's packages pointed at the
 * local src. Only errors the local code adds count.
 *
 * A consumer that cannot be compiled (no node_modules, no tsconfig) is a gap,
 * said by name: an unchecked consumer is never reported as a clean one.
 *
 *   pnpm consumers <root>...                   the consumers under these roots
 *   CONSUMERS_ROOTS=<root>:<root> pnpm consumers   the same, from the environment
 *
 * The roots are the caller's: this repo names none.
 *
 * Exit 0: every consumer checked and clean. 1: a consumer breaks. 2: gaps only.
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const REPO = resolve(import.meta.dirname, "..");
const PACKAGES = join(REPO, "packages");
const given = process.argv.slice(2).length
	? process.argv.slice(2)
	: (process.env.CONSUMERS_ROOTS ?? "").split(delimiter).filter(Boolean);
if (given.length === 0) {
	console.error(
		"consumers: which roots? pnpm consumers <root>... or CONSUMERS_ROOTS=<root>:<root>",
	);
	process.exit(2);
}
const roots = given.map((r) => resolve(r.replace(/^~(?=$|\/)/, homedir())));
for (const r of roots)
	if (!existsSync(r)) throw new Error(`consumers: root ${r} does not exist`);

type Exports = Record<string, Record<string, string>>;
const ours = readdirSync(PACKAGES).map((d) => {
	const json = JSON.parse(
		readFileSync(join(PACKAGES, d, "package.json"), "utf8"),
	) as { name: string; exports: Exports };
	return { dir: join(PACKAGES, d), name: json.name, exports: json.exports };
});
const names = new Set(ours.map((p) => p.name));

// Every subpath of every package, to its source: the paths a consumer's tsc
// reads instead of node_modules. Any other subpath of one of our packages is
// gone, and resolves to an empty module so its imports fail by name; left out,
// tsc would fall back to the old copy in node_modules and call it clean.
const GONE = join(REPO, "scripts", "consumers-gone.d.ts");
const ourPaths: Record<string, string[]> = Object.fromEntries(
	ours.map((p) => [`${p.name}/*`, [GONE]]),
);
for (const p of ours)
	for (const [sub, target] of Object.entries(p.exports)) {
		const source = target["adriangalilea-source"];
		if (!source) throw new Error(`${p.name} ${sub}: no adriangalilea-source`);
		ourPaths[sub === "." ? p.name : `${p.name}/${sub.slice(2)}`] = [
			resolve(p.dir, source),
		];
	}

const SKIP = new Set([
	"node_modules",
	".git",
	"dist",
	".next",
	".next-public",
	".wrangler",
	".turbo",
	".vercel",
	"build",
	"out",
]);

/** Every directory under `dir` whose package.json depends on one of ours. */
function discover(dir: string, depth = 0, found: string[] = []): string[] {
	if (depth > 7 || resolve(dir) === REPO) return found;
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return found;
	}
	if (entries.some((e) => e.isFile() && e.name === "package.json")) {
		const json = JSON.parse(
			readFileSync(join(dir, "package.json"), "utf8"),
		) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
		};
		const deps = {
			...json.dependencies,
			...json.devDependencies,
			...json.peerDependencies,
		};
		if (Object.keys(deps).some((d) => names.has(d))) found.push(dir);
	}
	for (const e of entries)
		if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith("."))
			discover(join(dir, e.name), depth + 1, found);
	return found;
}

/** The consumer's own paths, absolute, so they survive being merged with ours
 *  into a config that lives beside theirs. */
function theirPaths(tsconfig: string): Record<string, string[]> {
	const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
	if (read.error) throw new Error(`${tsconfig}: unreadable`);
	const parsed = ts.parseJsonConfigFileContent(
		read.config,
		ts.sys,
		dirname(tsconfig),
	);
	const base =
		(parsed.options as { pathsBasePath?: string }).pathsBasePath ??
		parsed.options.baseUrl ??
		dirname(tsconfig);
	return Object.fromEntries(
		Object.entries(parsed.options.paths ?? {}).map(([k, v]) => [
			k,
			v.map((t) => resolve(base, t)),
		]),
	);
}

/** tsc's error lines, as `file(line,col): error TSxxxx: …`, made absolute. */
function errors(dir: string, tsc: string, project: string): string[] {
	const run = spawnSync(tsc, ["--noEmit", "--pretty", "false", "-p", project], {
		cwd: dir,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return `${run.stdout}${run.stderr}`
		.split("\n")
		.filter((l) => /error TS\d+/.test(l))
		.map((l) => {
			const m = l.match(/^(.+?)(\(\d+,\d+\): .*)$/);
			return m ? `${resolve(dir, m[1] as string)}${m[2]}` : l;
		});
}

type Result =
	| { dir: string; kind: "clean"; baseline: number }
	| { dir: string; kind: "breaks"; baseline: number; added: string[] }
	| { dir: string; kind: "gap"; why: string };

function check(dir: string): Result {
	const tsconfig = join(dir, "tsconfig.json");
	if (!existsSync(tsconfig))
		return { dir, kind: "gap", why: "no tsconfig.json" };
	if (!existsSync(join(dir, "node_modules")))
		return { dir, kind: "gap", why: "not installed (no node_modules)" };
	const own = join(dir, "node_modules", ".bin", "tsc");
	const tsc = existsSync(own) ? own : join(REPO, "node_modules", ".bin", "tsc");
	const temp = join(dir, ".tsconfig.consumers.json");
	writeFileSync(
		temp,
		JSON.stringify({
			extends: "./tsconfig.json",
			compilerOptions: { paths: { ...theirPaths(tsconfig), ...ourPaths } },
		}),
	);
	try {
		const before = new Set(errors(dir, tsc, "tsconfig.json"));
		// Errors inside this repo's src, compiled under the consumer's options,
		// are this repo's to see in its own gate, never the consumer's; and the
		// local src sitting outside the consumer's rootDir (TS6059) is this
		// check's doing, not a break.
		const added = errors(dir, tsc, temp).filter(
			(e) =>
				!before.has(e) &&
				!e.startsWith(PACKAGES) &&
				!(e.includes("error TS6059") && e.includes(PACKAGES)),
		);
		return added.length
			? { dir, kind: "breaks", baseline: before.size, added }
			: { dir, kind: "clean", baseline: before.size };
	} finally {
		rmSync(temp);
	}
}

const consumers = roots.flatMap((r) => discover(r));
if (consumers.length === 0)
	throw new Error(
		`no consumer of ${[...names].join(", ")} under ${roots.join(", ")}`,
	);
console.error(
	`${consumers.length} consumers of ${[...names].join(", ")} under ${roots.join(", ")}`,
);

const results = consumers.map((dir) => {
	const r = check(dir);
	const where = relative(homedir(), dir);
	if (r.kind === "clean")
		console.log(
			`✓ ${where}${r.baseline ? ` (${r.baseline} errors before too)` : ""}`,
		);
	else if (r.kind === "gap") console.log(`? ${where}: ${r.why}`);
	else {
		console.log(`✗ ${where}: ${r.added.length} new errors`);
		for (const e of r.added) console.log(`    ${relative(dir, e)}`);
	}
	return r;
});

const breaks = results.filter((r) => r.kind === "breaks").length;
const gaps = results.filter((r) => r.kind === "gap").length;
console.error(
	`${results.length - breaks - gaps} clean, ${breaks} break, ${gaps} not checked`,
);
process.exit(breaks ? 1 : gaps ? 2 : 0);
