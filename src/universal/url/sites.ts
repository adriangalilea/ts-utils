/**
 * The site registry: per-service identity knowledge, one adapter per service
 * (the same knowledge-as-data pattern as tidy-rules.ts). An adapter answers
 * "is this host yours?" and "what's the native content id in this URL?", and
 * from the id derives the canonical URL and the cache-identity key — so every
 * spelling of one video (watch, youtu.be, shorts, live, embed, music.,
 * nocookie, nested redirects) collapses to ONE identity.
 *
 * Extraction is WHATWG-URL based, nested-redirect aware, and percent-decode
 * tolerant — no regex URL parsing. Adding a service (spotify, vimeo, …) is
 * one more adapter entry.
 */

export interface SiteAdapter {
	/** The service name, and the prefix of its identity keys ("youtube"). */
	name: string;
	/** Whether this (lowercased, www-less) host belongs to the service. */
	matches(host: string): boolean;
	/** The service's native content id in this URL, or null. */
	id(url: URL): string | null;
	/** The canonical URL for a content id. */
	canonicalUrl(id: string): string;
	/** The cache-identity key for a content id ("youtube:dQw4w9WgXcQ"). */
	key(id: string): string;
}

// ── youtube ─────────────────────────────────────────────────────────────────

const YOUTUBE_ID = /^[a-zA-Z0-9_-]{11}$/;
const YOUTUBE_PATH_KINDS = new Set(["embed", "v", "shorts", "live"]);

function isYouTubeHost(host: string): boolean {
	return (
		host === "youtube.com" ||
		host.endsWith(".youtube.com") ||
		host === "youtube-nocookie.com" ||
		host.endsWith(".youtube-nocookie.com")
	);
}

function validYouTubeId(value: string | null | undefined): string | null {
	return value && YOUTUBE_ID.test(value) ? value : null;
}

function youtubeIdFromUrl(url: URL): string | null {
	const host = url.hostname.toLowerCase().replace(/^www\./, "");

	if (host === "youtu.be") {
		return validYouTubeId(url.pathname.split("/").filter(Boolean)[0]);
	}
	if (!isYouTubeHost(host)) return null;

	const queryId = validYouTubeId(url.searchParams.get("v") ?? url.searchParams.get("video_id"));
	if (queryId) return queryId;

	const [kind, id] = url.pathname.split("/").filter(Boolean);
	if (YOUTUBE_PATH_KINDS.has(kind)) {
		const pathId = validYouTubeId(id);
		if (pathId) return pathId;
	}

	// Redirect wrappers (attribution_link?u=/watch%3Fv%3D…, redirect?q=…): the
	// nested value may be relative, so resolve it against the outer URL.
	for (const param of ["u", "url", "q"]) {
		const nested = url.searchParams.get(param);
		if (!nested) continue;
		let nestedUrl: URL;
		try {
			nestedUrl = new URL(nested, url);
		} catch {
			continue;
		}
		if (nestedUrl.href === url.href) continue;
		const nestedId = youtubeIdFromUrl(nestedUrl);
		if (nestedId) return nestedId;
	}

	return null;
}

const youtube: SiteAdapter = {
	name: "youtube",
	matches: (host) => host === "youtu.be" || isYouTubeHost(host),
	id: youtubeIdFromUrl,
	canonicalUrl: (id) => `https://www.youtube.com/watch?v=${id}`,
	key: (id) => `youtube:${id}`,
};

/**
 * The 11-char video id from ANY YouTube URL spelling or a bare id; null if
 * the input isn't one. Percent-encoded input gets one decode attempt so a
 * copied-from-HTML link still resolves.
 */
export function youtubeVideoId(input: string): string | null {
	const trimmed = input.trim();
	if (YOUTUBE_ID.test(trimmed)) return trimmed;

	for (const candidate of [trimmed, safeDecode(trimmed)]) {
		const url = parseLoose(candidate);
		if (url) {
			const id = youtubeIdFromUrl(url);
			if (id) return id;
		}
	}
	return null;
}

/** The canonical watch URL for a video id or any YouTube URL spelling; null if neither. */
export function youtubeUrl(idOrUrl: string): string | null {
	const id = youtubeVideoId(idOrUrl);
	return id ? youtube.canonicalUrl(id) : null;
}

/**
 * A public thumbnail URL for a video id or any YouTube URL spelling; null if
 * neither. Uses `hqdefault`, which exists for every valid video (unlike
 * `maxresdefault`, which 404s for many).
 */
export function youtubeThumbnailUrl(idOrUrl: string): string | null {
	const id = youtubeVideoId(idOrUrl);
	return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

/**
 * Add or replace the playhead offset (`t=90s`) on a YouTube video URL,
 * preserving the URL's shape and other params. A bare id gets the canonical
 * watch URL first. Non-video input is returned unchanged.
 */
export function youtubeTimestampUrl(idOrUrl: string, seconds: number): string {
	if (!youtubeVideoId(idOrUrl)) return idOrUrl;
	const source = YOUTUBE_ID.test(idOrUrl.trim()) ? youtube.canonicalUrl(idOrUrl.trim()) : idOrUrl;
	const offset = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
	try {
		const url = new URL(source);
		if (url.protocol !== "http:" && url.protocol !== "https:") return idOrUrl;
		url.searchParams.set("t", `${offset}s`);
		return url.toString();
	} catch {
		return idOrUrl;
	}
}

// ── the registry ────────────────────────────────────────────────────────────

export const SITES: readonly SiteAdapter[] = [youtube];

/** The adapter owning this (lowercased, www-less) host, or null. */
export function siteFor(host: string): SiteAdapter | null {
	return SITES.find((s) => s.matches(host)) ?? null;
}

// ── internals ───────────────────────────────────────────────────────────────

function parseLoose(input: string): URL | null {
	try {
		return new URL(input);
	} catch {
		try {
			return new URL(`https://${input}`);
		} catch {
			return null;
		}
	}
}

function safeDecode(input: string): string {
	try {
		return decodeURIComponent(input);
	} catch {
		return input;
	}
}
