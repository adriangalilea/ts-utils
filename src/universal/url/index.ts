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
 * Plus the text side: `findUrls(text)` / `asHttpUrl(token)` pull clean URLs
 * out of what a user typed, and `hostOf` / `hostMatches` (RFC 6265 domain-
 * matching) answer host questions.
 *
 * Each concern rides its state of the art instead of hand-rolls:
 *  - detection in free text: linkifyjs (scanner-based, TLD-aware, MIT);
 *  - parsing/serialization: the WHATWG URL API, never regexes;
 *  - which params are tracking: vendored from @protontech/tidy-url (Proton's
 *    maintained fork of DrKain/tidy-url, MIT; see tidy-rules.ts, refresh with
 *    `pnpm update-url-rules`) plus a small tested overlay (overlay.ts) —
 *    param names compare literally (lowercased), per host;
 *  - `urlKey` is ours: no standard exists for cache identity.
 *
 * Unparseable or non-http(s) input passes through unchanged: these are hygiene
 * functions over user-pasted text, not validators.
 */
import { find } from "linkifyjs";
import { OVERLAY_RULES } from "./overlay.js";
import { TIDY_RULES, type TrackingProvider } from "./tidy-rules.js";

export { TIDY_RULES, TIDY_VERSION, type TrackingProvider } from "./tidy-rules.js";
export { OVERLAY_RULES } from "./overlay.js";

export interface StripOptions {
	/** Extra param names to strip (compared lowercased), for app-specific junk. */
	strip?: readonly string[];
}

export interface FindUrlsOptions extends StripOptions {
	/** Drop scheme-less matches (`example.com/x`) instead of coercing them to https://. */
	requireScheme?: boolean;
}

/** One URL found in free text by {@link findUrls}. */
export interface FoundUrl {
	/** The cleaned http(s) URL (https:// coerced onto scheme-less matches). */
	url: string;
	/** Span of the raw match in the input text. */
	start: number;
	end: number;
	/** False for scheme-less matches the scanner inferred from a known TLD. */
	hadScheme: boolean;
}

/**
 * Every http(s) URL in free text, in order, cleaned. Detection is linkifyjs —
 * a real scanner, TLD-aware for scheme-less domains, and it owns the messy
 * text-boundary problems (trailing punctuation, brackets, emails-are-not-URLs)
 * — then each match goes through the URL parser and tracking-param stripping.
 * Scheme-less matches coerce to https:// (drop them with `requireScheme`).
 */
export function findUrls(text: string, opts?: FindUrlsOptions): FoundUrl[] {
	const out: FoundUrl[] = [];
	for (const link of find(text, "url", { defaultProtocol: "https" })) {
		// href === value exactly when the text already carried a scheme; otherwise
		// the scanner built href by prepending defaultProtocol onto the bare match.
		const hadScheme = link.href === link.value;
		if (!hadScheme && opts?.requireScheme) continue;
		const u = parseHttp(link.href);
		if (!u) continue; // a non-http scheme the scanner knows; not our job
		deleteTracking(u, opts);
		out.push({ url: u.toString(), start: link.start, end: link.end, hadScheme });
	}
	return out;
}

/**
 * A user-pasted token as one CLEAN http(s) URL, or null: {@link findUrls}
 * over the token, first match. The one verb between "text someone typed"
 * and "a URL you can use".
 */
export function asHttpUrl(token: string, opts?: FindUrlsOptions): string | null {
	return findUrls(token, opts)[0]?.url ?? null;
}

/** A URL's host without a leading www., or the input unchanged if it won't parse. */
export function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

/**
 * True if `host` IS `domain` or a subdomain of it — never a lookalike suffix
 * (`notyoutube.com` doesn't match `youtube.com`). RFC 6265 §5.1.3 domain-
 * matching semantics, the same rule cookies use.
 */
export function hostMatches(host: string, domain: string): boolean {
	const h = host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
	const d = domain.toLowerCase();
	return h === d || h.endsWith(`.${d}`);
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
