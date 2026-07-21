/**
 * Assert-based checks for `bot/announce` — the news template renders the exact house shape,
 * empty sections vanish, the signature separator is a middle dot (never an em dash), and
 * polyglot bodies demand the "en" anchor.
 *
 *   pnpm test:bot-announce
 */
import { strict as assert } from "node:assert";
import { renderAnnouncement, renderAnnouncementBodies, section } from "../src/bot/announce.js";

{
	const md = renderAnnouncement({
		banner: "ExampleBot News",
		sections: [
			section.info(["Sorry for the downtime! All stable now."]),
			section.features(["Follow-up questions", "Chapters on long videos"]),
			section.fixes(["Less error spam in groups"]),
		],
		closer: "Questions? Feedback? Feel free to reach out!",
		signature: "@example",
	});
	assert.equal(
		md,
		[
			"# 📰 ExampleBot News",
			"",
			"💬 **Info**",
			"",
			"- Sorry for the downtime! All stable now.",
			"",
			"✨ **New Features**",
			"",
			"- Follow-up questions",
			"- Chapters on long videos",
			"",
			"🐛 **Fixes**",
			"",
			"- Less error spam in groups",
			"",
			"_Questions? Feedback? Feel free to reach out!_",
			"",
			"· @example",
		].join("\n"),
	);
	assert.ok(!md.includes("—")); // no em dash, ever
}

{
	// Empty sections vanish; closer/signature optional.
	const md = renderAnnouncement({ banner: "B", sections: [section.fixes([])] });
	assert.equal(md, "# 📰 B");
}

{
	const bodies = renderAnnouncementBodies({
		en: { banner: "News", sections: [section.info(["hi"])] },
		es: { banner: "Noticias", sections: [section.info(["hola"])] },
	});
	assert.ok(bodies.en.includes("hi") && bodies.es.includes("hola"));
	assert.throws(() => renderAnnouncementBodies({ es: { banner: "x", sections: [] } }));
}

console.log("✓ bot-announce-test: the news template holds its shape");
