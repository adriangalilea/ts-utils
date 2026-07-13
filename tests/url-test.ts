/**
 * Assert-based checks for `universal/url` — cleanUrl/urlKey over the vendored
 * tidy-url ruleset + overlay. The split must stay honest: a missed strip
 * fragments consumers' caches; an over-strip corrupts real URLs (GitHub's
 * `ref` names a branch, Medium's `sk` unlocks friend links).
 *
 *   pnpm test:url
 */
import { strict as assert } from "node:assert";
import {
	cleanUrl,
	hostMatches,
	hostOf,
	isTrackingParam,
	urlKey,
	urlOf,
	urlsIn,
	youtubeThumbnailUrl,
	youtubeUrl,
	youtubeVideoId,
} from "../src/universal/url/index.js";

// ── cleanUrl: global trackers gone, everything else intact ──────────────────

assert.equal(
	cleanUrl("https://example.com/post?utm_source=x&utm_medium=social&id=7"),
	"https://example.com/post?id=7",
);
assert.equal(cleanUrl("https://example.com/a?fbclid=abc123"), "https://example.com/a");
// Vendored global list: analytics + email-marketing ids
assert.equal(
	cleanUrl("https://example.com/a?gclid=1&mc_eid=2&_hsenc=3&mkt_tok=4&pk_campaign=5&keep=yes"),
	"https://example.com/a?keep=yes",
);
// Overlay global list: click ids upstream misses
assert.equal(
	cleanUrl("https://example.com/a?msclkid=1&twclid=2&ttclid=3&srsltid=4&_ga=5&keep=yes"),
	"https://example.com/a?keep=yes",
);
// Case-insensitive param matching
assert.equal(cleanUrl("https://example.com/a?UTM_Source=x&b=1"), "https://example.com/a?b=1");
// Survivor param order preserved; fragment preserved (real anchors live there)
assert.equal(
	cleanUrl("https://example.com/a?z=1&utm_campaign=c&a=2#section-3"),
	"https://example.com/a?z=1&a=2#section-3",
);
// Repeated non-tracking params survive as-is
assert.equal(cleanUrl("https://example.com/a?t=1&t=2"), "https://example.com/a?t=1&t=2");

// ── cleanUrl: per-host rules strip there, never elsewhere ───────────────────

assert.equal(cleanUrl("https://youtu.be/dQw4w9WgXcQ?si=share_junk"), "https://youtu.be/dQw4w9WgXcQ");
assert.equal(
	cleanUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=x&feature=share&ab_channel=Foo&pp=xyz"),
	"https://www.youtube.com/watch?v=dQw4w9WgXcQ",
);
// Bare host (no www.) — upstream's matcher misses it, the overlay covers it
assert.equal(cleanUrl("https://youtube.com/watch?v=abc&feature=share"), "https://youtube.com/watch?v=abc");
// Subdomains match
assert.equal(cleanUrl("https://music.youtube.com/watch?v=abc&si=x"), "https://music.youtube.com/watch?v=abc");
// YouTube keeps what matters: the video id and the timestamp
assert.equal(
	cleanUrl("https://www.youtube.com/watch?v=abc&t=120s&si=junk"),
	"https://www.youtube.com/watch?v=abc&t=120s",
);
assert.equal(cleanUrl("https://open.spotify.com/track/xyz?si=abc"), "https://open.spotify.com/track/xyz");
assert.equal(cleanUrl("https://medium.com/@a/post-1?source=rss"), "https://medium.com/@a/post-1");
// Medium's `sk` unlocks friend links — must survive
assert.equal(cleanUrl("https://medium.com/@a/post-1?sk=secret"), "https://medium.com/@a/post-1?sk=secret");
// x.com (overlay) and twitter.com (vendored + overlay `t`)
assert.equal(cleanUrl("https://x.com/user/status/1?s=20&t=tok"), "https://x.com/user/status/1");
assert.equal(cleanUrl("https://twitter.com/user/status/1?s=20&t=tok"), "https://twitter.com/user/status/1");
assert.equal(
	cleanUrl("https://newsletter.substack.com/p/post?r=abc123&utm_campaign=post"),
	"https://newsletter.substack.com/p/post",
);
// `si` / `source` / `s` / `t` are MEANINGFUL off their hosts — never stripped globally
assert.equal(
	cleanUrl("https://example.com/a?si=1&source=2&s=3&t=30"),
	"https://example.com/a?si=1&source=2&s=3&t=30",
);
// GitHub `ref` names a branch — must survive (reddit strips its own `ref`)
assert.equal(
	cleanUrl("https://github.com/o/r/blob/main/x.ts?ref=feature-branch"),
	"https://github.com/o/r/blob/main/x.ts?ref=feature-branch",
);
assert.equal(
	cleanUrl("https://www.reddit.com/r/x/comments/1/?share_id=a&ref=share"),
	"https://www.reddit.com/r/x/comments/1/",
);

// ── cleanUrl: pass-through for what it must not touch ───────────────────────

assert.equal(cleanUrl("not a url at all"), "not a url at all");
assert.equal(cleanUrl("mailto:a@b.com?subject=utm_source"), "mailto:a@b.com?subject=utm_source");
assert.equal(cleanUrl("ftp://example.com/file?utm_source=x"), "ftp://example.com/file?utm_source=x");

// ── urlKey: one identity for every spelling of the same page ────────────────

const KEY = "example.com/post?id=7";
assert.equal(urlKey("https://example.com/post?id=7"), KEY);
assert.equal(urlKey("http://example.com/post?id=7"), KEY); // scheme-agnostic
assert.equal(urlKey("https://www.example.com/post?id=7"), KEY); // www.
assert.equal(urlKey("https://EXAMPLE.com./post/?id=7"), KEY); // case, trailing dot, trailing slash
assert.equal(urlKey("https://example.com:443/post?id=7"), KEY); // default port
assert.equal(urlKey("https://example.com/post?utm_source=a&id=7&utm_medium=b"), KEY); // tracking
assert.equal(urlKey("https://example.com/post?id=7#comments"), KEY); // fragment

// Param sorting: order never fragments the key…
assert.equal(urlKey("https://example.com/a?b=2&a=1"), urlKey("https://example.com/a?a=1&b=2"));
// …but different values are different resources
assert.notEqual(urlKey("https://example.com/a?page=1"), urlKey("https://example.com/a?page=2"));
// Path case is identity (many servers are case-sensitive)
assert.notEqual(urlKey("https://example.com/About"), urlKey("https://example.com/about"));
// Non-default port is identity
assert.notEqual(urlKey("https://example.com:8443/a"), urlKey("https://example.com/a"));
// Root path stays "/"
assert.equal(urlKey("https://example.com"), "example.com/");
assert.equal(urlKey("https://example.com/?utm_source=x"), "example.com/");
// Unparseable input still keys consistently (passes through)
assert.equal(urlKey("not a url"), "not a url");

// The motivating case: one article, three shares, one key → one summary, one charge
assert.equal(
	urlKey("https://www.theverge.com/2026/1/1/some-story?utm_source=twitter&utm_campaign=social"),
	urlKey("http://theverge.com/2026/1/1/some-story/"),
);

// ── isTrackingParam + caller extras ─────────────────────────────────────────

assert.equal(isTrackingParam("utm_source"), true); // vendored global
assert.equal(isTrackingParam("UTM_CAMPAIGN"), true);
assert.equal(isTrackingParam("msclkid"), true); // overlay global
assert.equal(isTrackingParam("id"), false);
assert.equal(isTrackingParam("si"), false); // ambiguous → global no
assert.equal(isTrackingParam("si", "youtube.com"), true);
assert.equal(isTrackingParam("si", "www.youtube.com"), true);
assert.equal(isTrackingParam("si", "open.spotify.com"), true);
assert.equal(isTrackingParam("si", "notyoutube.com"), false); // suffix, not subdomain
assert.equal(isTrackingParam("ref", "github.com"), false);
assert.equal(isTrackingParam("ref", "www.reddit.com"), true);
// Provider `allow` protects a param even when other rules would kill it
assert.equal(isTrackingParam("go", "open.spotify.com"), false);

assert.equal(cleanUrl("https://example.com/a?session=x&id=1", { strip: ["session"] }), "https://example.com/a?id=1");
assert.equal(urlKey("https://example.com/a?Session=x&id=1", { strip: ["session"] }), "example.com/a?id=1");

// ── urlsIn: every URL in free text, fully resolved ──────────────────────────

{
	const text = "check https://a.com/x?utm_source=t and also example.com/y thanks";
	const found = urlsIn(text);
	assert.deepEqual(
		found.map((u) => [u.href, u.hadScheme, u.site, u.id]),
		[
			["https://a.com/x", true, null, null],
			["https://example.com/y", false, null, null], // scheme-less coerces to https
		],
	);
	// Spans point at the raw matches (usable to cut links out of a message)
	assert.equal(text.slice(found[0].start, found[0].end), "https://a.com/x?utm_source=t");
	assert.equal(found[0].raw, "https://a.com/x?utm_source=t");
	assert.equal(found[0].host, "a.com");
	assert.equal(found[0].key, "a.com/x");
}
// The scanner owns text boundaries: brackets and trailing punctuation stay out
assert.deepEqual(
	urlsIn("(see <https://a.com/x>, or https://b.com/y.)").map((u) => u.href),
	["https://a.com/x", "https://b.com/y"],
);
// Emails are not URLs; bare words and unknown TLDs don't match
assert.deepEqual(urlsIn("mail a@b.com or ping foo.invalidtld"), []);
// requireScheme drops scheme-less matches (the bot's bare-link trigger semantics)
assert.deepEqual(
	urlsIn("https://a.com/x and example.com/y", { requireScheme: true }).map((u) => u.href),
	["https://a.com/x"],
);
// A recognized site resolves the whole funnel in one object
{
	const [u] = urlsIn("watch this youtu.be/dQw4w9WgXcQ?si=junk !");
	assert.equal(u.href, "https://youtu.be/dQw4w9WgXcQ");
	assert.equal(u.site, "youtube");
	assert.equal(u.id, "dQw4w9WgXcQ");
	assert.equal(u.key, "youtube:dQw4w9WgXcQ");
}
// Duplicate spellings are kept (spans matter); dedupe is one line on key
{
	const found = urlsIn("https://youtu.be/dQw4w9WgXcQ and https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share");
	assert.equal(found.length, 2);
	assert.equal(new Set(found.map((u) => u.key)).size, 1);
}

// ── urlOf: one pasted token → one resolved Url ──────────────────────────────

assert.equal(urlOf("https://example.com/a?utm_source=x")?.href, "https://example.com/a");
assert.equal(urlOf("<https://example.com/a>,")?.href, "https://example.com/a");
assert.equal(urlOf("example.com/a")?.href, "https://example.com/a");
assert.equal(urlOf("example.com/a", { requireScheme: true }), null);
assert.equal(urlOf("a@b.com"), null);
assert.equal(urlOf("hello"), null);

// ── youtube identity: one id from every URL shape ───────────────────────────

const YT = "dQw4w9WgXcQ";
for (const spelling of [
	YT, // bare id
	`https://www.youtube.com/watch?v=${YT}`,
	`https://youtube.com/watch?v=${YT}&t=120s`,
	`https://m.youtube.com/watch?v=${YT}`,
	`https://music.youtube.com/watch?v=${YT}&si=x`,
	`https://youtu.be/${YT}?si=share`,
	`https://www.youtube.com/shorts/${YT}`,
	`https://www.youtube.com/live/${YT}`,
	`https://www.youtube.com/embed/${YT}`,
	`https://www.youtube-nocookie.com/embed/${YT}`,
	`https://www.youtube.com/v/${YT}`,
	`https://www.youtube.com/watch?video_id=${YT}`,
	// redirect wrappers, including a RELATIVE nested target
	`https://www.youtube.com/attribution_link?a=x&u=%2Fwatch%3Fv%3D${YT}`,
	`https://www.youtube.com/redirect?q=https%3A%2F%2Fyoutu.be%2F${YT}`,
]) {
	assert.equal(youtubeVideoId(spelling), YT, `youtubeVideoId(${spelling})`);
}
assert.equal(youtubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ"), null); // not a youtube host
assert.equal(youtubeVideoId("https://youtu.be/short"), null); // not an 11-char id
assert.equal(youtubeVideoId("hello world"), null);
assert.equal(youtubeUrl(`https://youtu.be/${YT}?si=x`), `https://www.youtube.com/watch?v=${YT}`);
assert.equal(youtubeUrl(YT), `https://www.youtube.com/watch?v=${YT}`);
assert.equal(youtubeUrl("nope"), null);
assert.equal(youtubeThumbnailUrl(YT), `https://i.ytimg.com/vi/${YT}/hqdefault.jpg`);
assert.equal(youtubeThumbnailUrl("nope"), null);

// urlKey collapses every spelling of one video to one identity
assert.equal(urlKey(`https://youtu.be/${YT}?si=x`), `youtube:${YT}`);
assert.equal(urlKey(`https://music.youtube.com/watch?v=${YT}`), `youtube:${YT}`);
assert.equal(urlKey(`https://www.youtube.com/shorts/${YT}`), `youtube:${YT}`);
// …but a non-video youtube page keys generically
assert.equal(urlKey("https://www.youtube.com/@somechannel"), "youtube.com/@somechannel");

// ── hostOf / hostMatches ────────────────────────────────────────────────────

assert.equal(hostOf("https://www.theverge.com/a/b"), "theverge.com");
assert.equal(hostOf("not a url"), "not a url");
assert.equal(hostMatches("music.youtube.com", "youtube.com"), true);
assert.equal(hostMatches("www.youtube.com", "youtube.com"), true);
assert.equal(hostMatches("youtube.com", "youtube.com"), true);
assert.equal(hostMatches("notyoutube.com", "youtube.com"), false);

console.log("✓ url-test: urlsIn/urlOf/urlKey/cleanUrl/youtube identity/host helpers hold");
