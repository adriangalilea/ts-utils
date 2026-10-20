/**
 * Raw-write tripwire. Library code writes diagnostics through the logger
 * (one event stream: JSON off a terminal, human lines at one); a raw
 * `console.*` call bypasses it, and in a JSON file its line is no event,
 * so `logs` can only pass it through unformatted.
 *
 * Every `console.<method>` in each package's library code (its src/, tests
 * and live checks left out) outside comments is counted per file and
 * must match ALLOWED exactly: a new call anywhere fails, and so does a
 * removed one (shrink the count, or drop the entry, in the same change).
 *
 * Run: pnpm test:repo
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES = join(ROOT, "packages");
// Every package's library code; its tests and live checks sit beside it in
// src/ and may print what they like.
const SOURCES = readdirSync(PACKAGES).map((p) => join(PACKAGES, p, "src"));
const isLibrary = (name: string) =>
	name.endsWith(".ts") &&
	!name.endsWith(".test.ts") &&
	!name.endsWith(".live.ts");

const ALLOWED: Record<string, { count: number; reason: string }> = {
	"packages/utils/src/universal/log.ts": {
		count: 2,
		reason:
			"the logger's sink: Node writes every event through console.error (a cli/live region holds stderr and prints it above itself), browsers and Workers through the level's console method",
	},
	"packages/utils/src/runtime.ts": {
		count: 2,
		reason:
			"runtime.stdout/stderr.write fall back to console.log/error where no stream exists (browser, Worker); the logger's Node sink is built on them",
	},
	"packages/utils/src/cli/live.ts": {
		count: 1,
		reason:
			"spinner() under an active region prints its final line through console.error, which the region's hold on stderr prints above it: terminal rendering, not diagnostics",
	},
	"packages/utils/src/cli/run.ts": {
		count: 4,
		reason:
			"a program's answer (emit: JSON or its human lines on stdout) and its failure (main: the error said on stderr, or as JSON on stdout): output, not diagnostics; through console so a live region keeps them above itself",
	},
	"packages/utils/src/cli/watch.ts": {
		count: 1,
		reason:
			"a watch says on stderr why it ends at its deadline, part of the watch contract's output beside its exit code",
	},
	"packages/utils/src/platform/kev.ts": {
		count: 1,
		reason:
			"kev.dump() prints every variable (secrets masked) to stdout: the method's output is data",
	},
};

// console.log(…) and console[method](…) alike.
const CONSOLE_RE = /\bconsole\s*(?:\.\s*[A-Za-z_$]|\[)/g;

const walk = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory()
			? walk(join(dir, e.name))
			: isLibrary(e.name)
				? [join(dir, e.name)]
				: [],
	);

const found = new Map<string, number>();
for (const path of SOURCES.flatMap(walk)) {
	const code = readFileSync(path, "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "");
	const n = code.match(CONSOLE_RE)?.length ?? 0;
	if (n > 0) found.set(relative(ROOT, path), n);
}

const errors: string[] = [];
for (const [file, n] of found) {
	const allowed = ALLOWED[file];
	if (!allowed)
		errors.push(
			`${file}: ${n} raw console write(s); log through a scope instead (log.scope("…").warn(msg, { err }))`,
		);
	else if (allowed.count !== n)
		errors.push(
			`${file}: ${n} console call(s), allowlist says ${allowed.count} (${allowed.reason})`,
		);
}
for (const file of Object.keys(ALLOWED))
	if (!found.has(file))
		errors.push(`${file}: allowlisted but has no console call; drop the entry`);

if (errors.length) {
	console.error(`raw writes:\n  ${errors.join("\n  ")}`);
	process.exit(1);
}

console.log(
	`✓ raw-writes: every package writes through the logger (${Object.keys(ALLOWED).length} allowlisted files)`,
);
