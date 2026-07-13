/**
 * URL hygiene: tracking-parameter stripping and canonical cache keys.
 * Pure and dependency-free — safe in Node, Workers, and browsers.
 *
 * Two verbs for two jobs:
 *  - `cleanUrl(url)`: the SAME resource, minus tracking params. Safe to fetch,
 *    share, and display. Keeps scheme, www., remaining param order, and the
 *    fragment (a fragment can be a real anchor).
 *  - `urlKey(url)`: the resource's IDENTITY, for cache keys and dedupe.
 *    Scheme-agnostic, lowercase host without www. or a trailing dot, no
 *    trailing slash, tracking params stripped, surviving params sorted,
 *    fragment dropped. Two spellings of one page collide; two different
 *    pages never do.
 *
 * The knowledge of WHICH params are tracking is not ours: it's vendored from
 * @protontech/tidy-url (Proton's maintained fork of DrKain/tidy-url, MIT; see
 * tidy-rules.ts, refresh with `pnpm update-url-rules`) plus a small tested
 * overlay for gaps (overlay.ts). URLs are parsed with the WHATWG URL API,
 * never regexes; the dataset's per-provider matchers select which rules apply
 * to a host, and param names are compared literally (lowercased).
 *
 * Unparseable or non-http(s) input passes through unchanged: these are hygiene
 * functions over user-pasted text, not validators.
 */
import { OVERLAY_RULES } from "./overlay.js";
import { TIDY_RULES, type TrackingProvider } from "./tidy-rules.js";

export { TIDY_RULES, TIDY_VERSION, type TrackingProvider } from "./tidy-rules.js";
export { OVERLAY_RULES } from "./overlay.js";

export interface StripOptions {
	/** Extra param names to strip (compared lowercased), for app-specific junk. */
	strip?: readonly string[];
}

/**
 * The same URL minus tracking params: safe to fetch, share, and display.
 * Unparseable or non-http(s) input is returned unchanged.
 */
export function cleanUrl(url: string, opts?: StripOptions): string {
	const u = parseHttp(url);
	if (!u) return url;
	deleteTracking(u, opts);
	return u.toString();
}

/**
 * A canonical identity for the resource behind `url` — `host/path?sortedQuery`
 * — for cache keys and dedupe. Unparseable or non-http(s) input is returned
 * unchanged so it still keys consistently.
 */
export function urlKey(url: string, opts?: StripOptions): string {
	const u = parseHttp(url);
	if (!u) return url;
	deleteTracking(u, opts);
	u.searchParams.sort();
	const host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
	const port = u.port ? `:${u.port}` : ""; // default ports never survive URL parsing
	const path = u.pathname.replace(/\/+$/, "") || "/";
	const query = u.searchParams.toString();
	return `${host}${port}${path}${query ? `?${query}` : ""}`;
}

/**
 * True if `name` is a tracking param — globally, or on `host` specifically.
 * Providers that match on the full URL (matchHref) need more context than a
 * host and are skipped here; `cleanUrl`/`urlKey` do honor them.
 */
export function isTrackingParam(name: string, host = ""): boolean {
	const n = name.toLowerCase();
	const doomed = new Set<string>();
	const allowed = new Set<string>();
	for (const p of compiled()) {
		if (p.provider.matchHref) continue;
		if (!p.match.test(host)) continue;
		collect(p.provider, doomed, allowed);
	}
	return doomed.has(n) && !allowed.has(n);
}

// ── internals ───────────────────────────────────────────────────────────────

interface CompiledProvider {
	provider: TrackingProvider;
	match: RegExp;
	exclude: readonly RegExp[];
}

let cache: CompiledProvider[] | null = null;

/** All providers (vendored + overlay), matchers compiled once per process. */
function compiled(): CompiledProvider[] {
	cache ??= [...TIDY_RULES, ...OVERLAY_RULES].map((provider) => ({
		provider,
		match: new RegExp(provider.match, provider.flags),
		exclude: (provider.exclude ?? []).map((e) => new RegExp(e.match, e.flags)),
	}));
	return cache;
}

/** Parse as a WHATWG URL, but only for http(s); anything else → null. */
function parseHttp(url: string): URL | null {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	return u.protocol === "http:" || u.protocol === "https:" ? u : null;
}

/** Fold one provider's rules/allow into the doomed/allowed sets (lowercased). */
function collect(provider: TrackingProvider, doomed: Set<string>, allowed: Set<string>): void {
	for (const r of provider.rules) doomed.add(r.toLowerCase());
	for (const a of provider.allow ?? []) allowed.add(a.toLowerCase());
}

/** Remove tracking params (dataset + overlay + caller extras) from `u` in place. */
function deleteTracking(u: URL, opts?: StripOptions): void {
	const doomed = new Set<string>();
	const allowed = new Set<string>();
	for (const p of compiled()) {
		// Upstream semantics: providers match on the host (href when matchHref),
		// and an exclude pattern opts the whole URL out of that provider.
		if (!p.match.test(p.provider.matchHref ? u.href : u.host)) continue;
		if (p.exclude.some((x) => x.test(u.href))) continue;
		collect(p.provider, doomed, allowed);
	}
	for (const extra of opts?.strip ?? []) doomed.add(extra.toLowerCase());
	for (const a of allowed) doomed.delete(a);
	if (doomed.size === 0) return;
	// Collect first: deleting while iterating URLSearchParams skips entries.
	const keys = [...new Set(u.searchParams.keys())];
	for (const k of keys) {
		if (doomed.has(k.toLowerCase())) u.searchParams.delete(k);
	}
}
