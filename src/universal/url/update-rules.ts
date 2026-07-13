#!/usr/bin/env tsx
/**
 * Vendors the tracking-parameter ruleset from @protontech/tidy-url (Proton's
 * maintained fork of DrKain/tidy-url, MIT) into ./tidy-rules.ts. Same pattern
 * as currency's download-crypto-list.ts: dataset knowledge is community-
 * maintained upstream; we vendor a snapshot instead of taking a runtime dep.
 *
 * Only the param-stripping fields are carried over (name, match, match_href,
 * rules, allow, exclude). Upstream's redirect-unwrapping, AMP, and base64-
 * decode features are out of scope — providers that ONLY do those are dropped.
 *
 * Usage: pnpm update-url-rules
 */

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "tidy-rules.ts");
const PACKAGE = "@protontech/tidy-url";

interface UpstreamRule {
	name: string;
	match: RegExp;
	match_href?: boolean;
	rules?: string[];
	allow?: string[];
	exclude?: RegExp[];
}

function fetchUpstream(): { rules: UpstreamRule[]; version: string; license: string } {
	const dir = mkdtempSync(join(tmpdir(), "tidy-url-"));
	console.log(`Packing ${PACKAGE}@latest ...`);
	const tarball = execSync(`npm pack ${PACKAGE}@latest --pack-destination ${JSON.stringify(dir)}`, {
		encoding: "utf8",
	})
		.trim()
		.split("\n")
		.at(-1);
	if (!tarball) throw new Error("npm pack produced no tarball name");
	execSync(`tar xzf ${JSON.stringify(join(dir, tarball))} -C ${JSON.stringify(dir)}`);

	const pkg = JSON.parse(readFileSync(join(dir, "package/package.json"), "utf8")) as {
		version: string;
		license: string;
	};
	// data/rules.js is CommonJS (`module.exports = [...]`) with RegExp literals;
	// requiring it yields real RegExp objects — no parsing of our own.
	const rules = createRequire(import.meta.url)(join(dir, "package/data/rules.js")) as UpstreamRule[];
	const copyright = readFileSync(join(dir, "package/LICENSE"), "utf8")
		.split("\n")
		.find((l) => l.startsWith("Copyright"));
	if (!Array.isArray(rules) || rules.length === 0) throw new Error("upstream rules did not load");
	if (pkg.license !== "MIT") throw new Error(`upstream license changed to ${pkg.license} — review before vendoring`);
	return { rules, version: pkg.version, license: `${pkg.license} — ${copyright ?? ""}`.trim() };
}

/** A regex serialized for the generated file; `g`/`y` are dropped (statefulness). */
function serializeRegex(re: RegExp): { match: string; flags: string } {
	return { match: re.source, flags: re.flags.replace(/[gy]/g, "") };
}

function assertStrings(list: unknown[], where: string): string[] {
	for (const item of list) {
		if (typeof item !== "string") throw new Error(`non-string entry in ${where}: ${JSON.stringify(item)}`);
	}
	return list as string[];
}

function generate(): void {
	const { rules, version, license } = fetchUpstream();

	const kept = rules
		.filter((r) => (r.rules?.length ?? 0) > 0 || (r.allow?.length ?? 0) > 0)
		.map((r) => {
			if (typeof r.name !== "string" || !(r.match instanceof RegExp)) {
				throw new Error(`malformed provider: ${JSON.stringify(r.name)}`);
			}
			return {
				name: r.name,
				...serializeRegex(r.match),
				...(r.match_href === true ? { matchHref: true } : {}),
				rules: assertStrings(r.rules ?? [], r.name),
				...(r.allow?.length ? { allow: assertStrings(r.allow, `${r.name}.allow`) } : {}),
				...(r.exclude?.length ? { exclude: r.exclude.map(serializeRegex) } : {}),
			};
		});

	const dropped = rules.length - kept.length;
	const body = kept.map((p) => `\t${JSON.stringify(p)},`).join("\n");
	const file = `// GENERATED FILE — do not edit; refresh with \`pnpm update-url-rules\`.
//
// Tracking-parameter ruleset vendored from ${PACKAGE}@${version} (data/rules.js),
// Proton's maintained fork of https://github.com/DrKain/tidy-url.
// Upstream license: ${license}
//
// Carried fields: the host matcher (match/flags; tested against the URL host,
// or the full href when matchHref), the param names to strip (rules), params
// protected from any rule (allow), and URL patterns that opt a URL out of the
// provider (exclude). Upstream's redirect/AMP/decode features are out of scope;
// ${dropped} providers that only did those were dropped (${kept.length} kept).
// Generated ${new Date().toISOString().slice(0, 10)}.

export interface TrackingProvider {
	name: string;
	/** Host-matcher regex source; tested against the URL host (href when matchHref). */
	match: string;
	flags: string;
	matchHref?: boolean;
	/** Param names to strip (compared lowercased). */
	rules: readonly string[];
	/** Param names protected from ANY rule on this provider's URLs. */
	allow?: readonly string[];
	/** URL patterns that opt a URL out of this provider entirely. */
	exclude?: readonly { match: string; flags: string }[];
}

export const TIDY_VERSION = ${JSON.stringify(version)};

export const TIDY_RULES: readonly TrackingProvider[] = [
${body}
];
`;
	writeFileSync(OUT, file);
	console.log(`Wrote ${kept.length} providers (${dropped} dropped) from ${PACKAGE}@${version} → ${OUT}`);
}

generate();
