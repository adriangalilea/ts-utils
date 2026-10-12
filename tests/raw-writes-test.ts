/**
 * Raw-write tripwire. Library code writes diagnostics through the logger
 * (one event stream: JSON off a terminal, human lines at one); a raw
 * `console.*` call bypasses it, and in a JSON file its line is no event,
 * so `logs` can only pass it through unformatted.
 *
 * Every `console.<method>` in src/ outside comments is counted per file and
 * must match ALLOWED exactly: a new call anywhere fails, and so does a
 * removed one (shrink the count, or drop the entry, in the same change).
 *
 * Run: pnpm test:raw-writes
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

const ALLOWED: Record<string, { count: number; reason: string }> = {
	"src/universal/log.ts": {
		count: 2,
		reason:
			"the logger's sink: Node writes every event through console.error (cli/live patches it), browsers and Workers through the level's console method",
	},
	"src/runtime.ts": {
		count: 2,
		reason:
			"runtime.stdout/stderr.write fall back to console.log/error where no stream exists (browser, Worker); the logger's Node sink is built on them",
	},
	"src/cli/live.ts": {
		count: 10,
		reason:
			"the live region reroutes console.log/warn/error above itself and restores them, and spinner() prints its final line to stdout when no region is active: terminal rendering, not diagnostics",
	},
	"src/platform/kev.ts": {
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
			: e.name.endsWith(".ts")
				? [join(dir, e.name)]
				: [],
	);

const found = new Map<string, number>();
for (const path of walk(SRC)) {
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
	`✓ raw-writes: src/ writes through the logger (${Object.keys(ALLOWED).length} allowlisted files)`,
);
