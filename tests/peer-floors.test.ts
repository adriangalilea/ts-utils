/**
 * Peer-floor tripwire. A peer dependency's range is the promise a package
 * makes to every program that installs it: "any version in here works". The
 * only version known to work is the one the package is built and tested
 * against, its devDependency, so each peer's range is `^` that floor exactly.
 * A wider floor lets a program keep an older copy the package was never run
 * on; llm 1.0.0 promised `ai ^7.0.0`, imported an error class from 7.0.130,
 * and a bot on 7.0.23 failed at load.
 *
 * Every peer must also be a devDependency, so it is tested at all, and both
 * ranges must read `^X.Y.Z` with the same X.Y.Z. Raising the dev floor raises
 * the peer floor in the same change.
 *
 * Run: pnpm test:repo
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PACKAGES = join(resolve(import.meta.dirname, ".."), "packages");
const CARET = /^\^\d+\.\d+\.\d+$/;

const errors: string[] = [];
let checked = 0;
for (const dir of readdirSync(PACKAGES)) {
	const manifest = JSON.parse(
		readFileSync(join(PACKAGES, dir, "package.json"), "utf8"),
	) as {
		name: string;
		peerDependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
	for (const [dep, peer] of Object.entries(manifest.peerDependencies ?? {})) {
		checked++;
		const dev = manifest.devDependencies?.[dep];
		if (!dev) {
			errors.push(
				`${manifest.name}: peer ${dep} ${peer} is no devDependency, so nothing tests it`,
			);
			continue;
		}
		if (!CARET.test(dev)) {
			errors.push(
				`${manifest.name}: devDependency ${dep} ${dev} must read ^X.Y.Z, the floor its peer promises`,
			);
			continue;
		}
		if (peer !== dev)
			errors.push(
				`${manifest.name}: peer ${dep} ${peer} must equal its tested floor ${dev}`,
			);
	}
}

if (errors.length) {
	console.error(`peer floors:\n  ${errors.join("\n  ")}`);
	process.exit(1);
}

console.log(
	`✓ peer-floors: ${checked} peer ranges promise the version they are tested on`,
);
