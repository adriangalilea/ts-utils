/**
 * Curated additions the vendored ruleset lacks, in the same TrackingProvider
 * shape so the engine treats both identically. Everything here is covered by
 * tests/url-test.ts; entries that land upstream can be deleted on the next
 * `pnpm update-url-rules`.
 *
 * The bar for the global entry is UNAMBIGUOUS: ad-platform click ids and
 * analytics linkers that never carry meaning anywhere. Ambiguous names
 * (`ref`, `source`, `si`, `t`) go under a host — a global strip of `ref`
 * would corrupt GitHub URLs, where it names a branch.
 */
import type { TrackingProvider } from "./tidy-rules.js";

export const OVERLAY_RULES: readonly TrackingProvider[] = [
	{
		name: "overlay:global",
		match: ".*",
		flags: "",
		rules: [
			// Ad-platform click ids upstream's Global list misses
			"msclkid", // Microsoft Ads
			"dclid", // Google DoubleClick
			"yclid", // Yandex
			"twclid", // Twitter Ads
			"ttclid", // TikTok Ads
			"li_fat_id", // LinkedIn
			"epik", // Pinterest
			"irclickid", // Impact Radius
			"srsltid", // Google Merchant / shopping results
			"gbraid", // Google Ads (iOS attribution)
			"wbraid",
			// Google Analytics cross-domain linker
			"_ga",
			"_gl",
			"_gid",
			// Openstat (mail.ru / rambler analytics)
			"_openstat",
		],
	},
	{
		// Upstream's youtube matcher (`.*.youtube.com`) misses the bare host, and its
		// rules miss the share/attribution params — carry a superset that covers both.
		name: "overlay:youtube.com",
		match: "(^|\\.)youtube\\.com$",
		flags: "i",
		rules: ["si", "pp", "ab_channel", "kw", "feature", "app", "embeds_referring_euri", "embeds_referring_origin"],
	},
	{
		name: "overlay:youtu.be",
		match: "(^|\\.)youtu\\.be$",
		flags: "i",
		rules: ["si", "feature"],
	},
	{
		// Upstream covers twitter.com but not the x.com rename; `t` (share token) is
		// missing on both. `s` and `t` are share residue here, meaningful elsewhere.
		name: "overlay:x.com",
		match: "(^|\\.)x\\.com$",
		flags: "i",
		rules: ["s", "t", "src", "ref_url", "ref_src", "mx"],
	},
	{
		name: "overlay:twitter.com",
		match: "(^|\\.)twitter\\.com$",
		flags: "i",
		rules: ["t"],
	},
	{
		// Substack share links: `r` is the referrer handle, the rest is signup routing.
		name: "overlay:substack.com",
		match: "(^|\\.)substack\\.com$",
		flags: "i",
		rules: ["r", "triedRedirect", "freeWelcomeReferral", "isFreemail"],
	},
];
