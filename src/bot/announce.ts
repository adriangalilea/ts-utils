/**
 * The house announcement ("news") template for bot mass messages, as a first-class structure:
 * compose an {@link Announcement} once, render it per language, and hand the bodies to a
 * polyglot broadcast engine. The render targets the common Telegram-markdown subset
 * (`# heading` → bold, `- ` bullets, `*…*` italics) most bot pipelines already convert to
 * Telegram HTML — no parse_mode assumptions live here.
 *
 * Shape (each section optional, order preserved):
 *
 *   # 📰 <banner>
 *
 *   💬 Info
 *   - …
 *
 *   ✨ New Features
 *   - …
 *
 *   🐛 Fixes
 *   - …
 *
 *   _<closer>_
 *
 *   · <signature>
 *
 * The signature separator is a middle dot by design — never an em dash.
 */

export interface AnnouncementSection {
	/** Leading emoji for the section title, e.g. "💬". */
	emoji: string;
	/** Section title, e.g. "Info". */
	title: string;
	/** Bulleted items, one line each. */
	items: string[];
}

export interface Announcement {
	/** Banner line, e.g. "theSummaryBot News". Rendered as `# 📰 <banner>`. */
	banner: string;
	sections: AnnouncementSection[];
	/** Italic closing line, e.g. "Questions? Feedback? Feel free to reach out!". */
	closer?: string;
	/** Attribution, e.g. "@adriangalilea". Rendered as `· <signature>`. */
	signature?: string;
}

/** The three canonical sections, so every announcement wears the same iconography. */
export const section = {
	info: (items: string[], title = "Info"): AnnouncementSection => ({ emoji: "💬", title, items }),
	features: (items: string[], title = "New Features"): AnnouncementSection => ({ emoji: "✨", title, items }),
	fixes: (items: string[], title = "Fixes"): AnnouncementSection => ({ emoji: "🐛", title, items }),
};

/** Render one language's announcement to the Telegram-markdown subset. */
export function renderAnnouncement(a: Announcement): string {
	const blocks: string[] = [`# 📰 ${a.banner}`];
	for (const s of a.sections) {
		if (s.items.length === 0) continue;
		blocks.push(`${s.emoji} **${s.title}**`);
		blocks.push(s.items.map((i) => `- ${i}`).join("\n"));
	}
	if (a.closer) blocks.push(`*${a.closer}*`);
	if (a.signature) blocks.push(`· ${a.signature}`);
	return blocks.join("\n\n");
}

/**
 * Per-language bodies for a polyglot broadcast: language code → rendered body. "en" is the
 * required fallback anchor — an engine resolves each recipient's language and falls back to it.
 */
export type AnnouncementBodies = Record<string, string>;

/** Render a per-language map of announcements into broadcast bodies. Throws without "en". */
export function renderAnnouncementBodies(byLanguage: Record<string, Announcement>): AnnouncementBodies {
	if (!byLanguage.en) throw new Error("announcement bodies need an 'en' fallback");
	const bodies: AnnouncementBodies = {};
	for (const [lang, a] of Object.entries(byLanguage)) bodies[lang] = renderAnnouncement(a);
	return bodies;
}
