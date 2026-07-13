/**
 * URLs, from user-typed text to cache identity. Safe in Node, Workers, and
 * browsers. The whole funnel every consumer walks — is there a URL? which
 * resource? whose content? what identity? — answered ONCE, on one object:
 *
 *   Url {
 *     raw, start, end   what they typed, and where in the text
 *     hadScheme         typed https:// vs inferred from a bare domain
 *     href              cleaned absolute URL — fetch, share, display this
 *     host              www-less host
 *     site              recognized service ("youtube") or null
 *     id                the service's native content id, or null
 *     key               canonical identity for caches/dedupe:
 *                       "youtube:dQw4w9WgXcQ" | "theverge.com/2026/story"
 *   }
 *
 * Two verbs, one per input shape:
 *   urlsIn(text)  → Url[]        every URL in free text, in order, with spans
 *   urlOf(token)  → Url | null   one pasted token / URL string
 *
 * The `key` is the point: every spelling of one resource collides (scheme,
 * www., trailing slash, tracking params, and for recognized sites every URL
 * shape of the same content id), and two different resources never do.
 *
 * Each concern rides its state of the art instead of hand-rolls:
 *  - detection in free text: linkifyjs (scanner-based, TLD-aware, MIT) — it
 *    owns the messy boundaries (trailing punctuation, brackets, emails);
 *  - parsing/serialization: the WHATWG URL API, never regexes;
 *  - which params are tracking: vendored from @protontech/tidy-url (Proton's
 *    maintained fork of DrKain/tidy-url, MIT; see tidy-rules.ts, refresh with
 *    `pnpm update-url-rules`) plus a small tested overlay (overlay.ts) —
 *    param names compare literally (lowercased), per host;
 *  - per-site content identity: the adapter registry (sites.ts).
 *
 * The low-level verbs (`cleanUrl`, `urlKey`, `hostOf`, `hostMatches`,
 * `isTrackingParam`, the youtube helpers) stay exported for surgical use.
 * Unparseable or non-http(s) input passes through unchanged: these are
 * hygiene functions over user-pasted text, not validators.
 */
import { find } from "linkifyjs";
import { OVERLAY_RULES } from "./overlay.js";
import { siteFor } from "./sites.js";
import { TIDY_RULES, type TrackingProvider } from "./tidy-rules.js";

export { TIDY_RULES, TIDY_VERSION, type TrackingProvider } from "./tidy-rules.js";
export { OVERLAY_RULES } from "./overlay.js";
export {
	SITES,
	siteFor,
	youtubeThumbnailUrl,
	youtubeTimestampUrl,
	youtubeUrl,
	youtubeVideoId,
	type SiteAdapter,
} from "./sites.js";

export interface StripOptions {
	/** Extra param names to strip (compared lowercased), for app-specific junk. */
	strip?: readonly string[];
}

export interface UrlsInOptions extends StripOptions {
	/** Drop scheme-less matches (`example.com/x`) instead of coercing them to https://. */
	requireScheme?: boolean;
}

/** One URL resolved from text: every layer of the funnel, answered once. */
export interface Url {
	/** Exactly the text that matched (punctuation and tracking still on it). */
	raw: string;
	/** Span of the raw match in the input text (cut links out of a message). */
	start: number;
	end: number;
	/** False when the scanner inferred the link from a bare domain (`example.com/x`). */
	hadScheme: boolean;
	/** The cleaned absolute URL — fetch, share, and display this. */
	href: string;
	/** The www-less host. */
	host: string;
	/** The recognized service owning the host ("youtube"), or null. */
	site: string | null;
	/** The service's native content id (a YouTube video id), or null. */
	id: string | null;
	/** Canonical identity for caches/dedupe: every spelling of one resource collides. */
	key: string;
}

/**
 * Every http(s) URL in free text, in order, fully resolved. Duplicate
 * spellings are kept (spans matter); dedupe is one line on `key`.
 */
export function urlsIn(text: string, opts?: UrlsInOptions): Url[] {
	const out: Url[] = [];
	for (const link of find(text, "url", { defaultProtocol: "https" })) {
		// href === value exactly when the text already carried a scheme; otherwise
		// the scanner built href by prepending defaultProtocol onto the bare match.
		const hadScheme = link.href === link.value;
		if (!hadScheme && opts?.requireScheme) continue;
		const u = parseHttp(link.href);
		if (!u) continue; // a non-http scheme the scanner knows; not our job
		deleteTracking(u, opts);
		out.push(resolveUrl(u, { raw: link.value, start: link.start, end: link.end, hadScheme }));
	}
	return out;
}

/** One pasted token / URL string as a resolved {@link Url}, or null. */
export function urlOf(token: string, opts?: UrlsInOptions): Url | null {
	return urlsIn(token, opts)[0] ?? null;
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
 * A canonical identity for the resource behind `url`, for cache keys and
 * dedupe. A recognized site's content collapses to its native id
 * ("youtube:dQw4w9WgXcQ" — watch, youtu.be, shorts, live, embed, all one
 * key); everything else canonicalizes to `host/path?sortedQuery`,
 * scheme-agnostic, www-less, tracking-stripped, fragment-free. Unparseable
 * or non-http(s) input is returned unchanged so it still keys consistently.
 */
export function urlKey(url: string, opts?: StripOptions): string {
	const u = parseHttp(url);
	if (!u) return url;
	const site = siteFor(normalizedHost(u));
	const id = site?.id(u);
	if (site && id) return site.key(id);
	deleteTracking(u, opts);
	u.searchParams.sort();
	const port = u.port ? `:${u.port}` : ""; // default ports never survive URL parsing
	const path = u.pathname.replace(/\/+$/, "") || "/";
	const query = u.searchParams.toString();
	return `${normalizedHost(u)}${port}${path}${query ? `?${query}` : ""}`;
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

/** Assemble a {@link Url} from an already-cleaned parsed URL + its text facts. */
function resolveUrl(u: URL, text: { raw: string; start: number; end: number; hadScheme: boolean }): Url {
	const host = normalizedHost(u);
	const site = siteFor(host);
	const id = site?.id(u) ?? null;
	return {
		...text,
		href: u.toString(),
		host,
		site: site?.name ?? null,
		id,
		key: site && id ? site.key(id) : urlKey(u.toString()),
	};
}

/** Lowercased hostname without a leading www. or a trailing dot. */
function normalizedHost(u: URL): string {
	return u.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

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
