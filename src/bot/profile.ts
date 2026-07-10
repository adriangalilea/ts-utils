/**
 * `bot/profile` — the bot's Telegram-facing identity as CODE, synced idempotently.
 *
 * A bot should never depend on values typed into BotFather: name, description,
 * About, and the public command list are all settable over the API, so they
 * belong in the repo — reviewable, localized, and reproducible on a fresh
 * token. `syncBotProfile` declares them once and reconciles on every boot with
 * a get → compare → set diff-guard per field per language: unchanged values
 * cost one read, so firing it on every Worker cold start is free of rate-limit
 * risk. Failures are logged and swallowed — a profile hiccup must never take
 * the bot down.
 *
 * What the API canNOT set, BotFather still owns: the token itself and the
 * inline-mode switch. Those are declared as EXPECTATIONS instead — the sync
 * checks `getMe` and DMs the admins when reality disagrees with what the code
 * assumes (an inline-dependent bot silently losing inline mode is exactly the
 * kind of drift nobody notices until users do).
 *
 * @example
 * import { syncBotProfile } from '@adriangalilea/utils/bot/profile'
 *
 * void syncBotProfile(bot, {
 *   description: { en: 'What I do…', es: 'Lo que hago…' },   // first key = the default
 *   about:       { en: '⚡ short pitch', es: '⚡ pitch corto' },
 *   commands: {
 *     en: [{ command: 'start', description: 'Set up' }],
 *     es: [{ command: 'start', description: 'Configurar' }],
 *   },
 *   expects: { inline: true },
 *   adminIds: () => store.readAdminIds(ctx, []),              // live resolver or plain array
 * })
 */
import { createLogger } from "../universal/log.js";
import { notifyAdmins } from "./notify.js";

const log = createLogger("bot/profile");

// Telegram caps, counted in code points so emoji are one glyph each.
const NAME_MAX = 64;
const DESCRIPTION_MAX = 512;
const ABOUT_MAX = 120;

/** One public slash command as Telegram publishes it. */
export interface BotCommandEntry {
	command: string;
	description: string;
}

/** Per-language values; the FIRST key doubles as the unlocalized default. */
export type Localized<T> = Record<string, T>;

/** The structural bot surface the sync needs (satisfied by a gramio Bot). */
export type ProfileBot = {
	info?: { username?: string; supports_inline_queries?: boolean };
	api: {
		getMyName: (p: object) => Promise<{ name?: string }>;
		setMyName: (p: object) => Promise<unknown>;
		getMyDescription: (p: object) => Promise<{ description?: string }>;
		setMyDescription: (p: object) => Promise<unknown>;
		getMyShortDescription: (
			p: object,
		) => Promise<{ short_description?: string }>;
		setMyShortDescription: (p: object) => Promise<unknown>;
		getMyCommands: (p: object) => Promise<ReadonlyArray<BotCommandEntry>>;
		setMyCommands: (p: object) => Promise<unknown>;
		sendMessage: (p: { chat_id: number; text: string }) => Promise<unknown>;
	};
};

export interface BotProfileOptions {
	/** Display name (`setMyName`, 64 chars). */
	name?: Localized<string>;
	/** "What can this bot do?" (`setMyDescription`, 512 chars). */
	description?: Localized<string>;
	/** About / short description (`setMyShortDescription`, 120 chars). */
	about?: Localized<string>;
	/** Public command list per language (admin commands stay out — they're behavior, not menu). */
	commands?: Localized<ReadonlyArray<BotCommandEntry>>;
	/**
	 * BotFather-only capabilities this bot's features assume. Checked against `getMe` on every
	 * sync; a mismatch WARNS the admins (it can't be fixed over the API, only surfaced).
	 */
	expects?: { inline?: boolean };
	/** Admins to DM on an expectation mismatch: a plain array or a live resolver. */
	adminIds?:
		| readonly number[]
		| (() => Promise<readonly number[]> | readonly number[]);
}

/** Count Unicode code points (emoji = 1), for Telegram's limits. */
function glyphs(s: string): number {
	return [...s].length;
}

function commandsEqual(
	a: ReadonlyArray<BotCommandEntry>,
	b: ReadonlyArray<BotCommandEntry>,
): boolean {
	if (a.length !== b.length) return false;
	return a.every(
		(cmd, i) =>
			cmd.command === b[i].command && cmd.description === b[i].description,
	);
}

function overLimit(
	field: string,
	values: Localized<string>,
	max: number,
): boolean {
	for (const [lang, value] of Object.entries(values)) {
		if (glyphs(value) > max) {
			log.error(
				`${field} (${lang}) exceeds ${max} chars — skipping ${field} sync`,
			);
			return true;
		}
	}
	return false;
}

const langParam = (lang: string | undefined) =>
	lang ? { language_code: lang } : {};

/**
 * Reconcile the declared profile with Telegram, field by field, language by language —
 * writes only genuine diffs. Never throws. Call fire-and-forget after `bot.init()`.
 */
export async function syncBotProfile(
	bot: ProfileBot,
	opts: BotProfileOptions,
): Promise<void> {
	const jobs: Promise<void>[] = [];

	const eachLang = <T>(
		values: Localized<T>,
		sync: (lang: string | undefined, value: T) => Promise<void>,
	) => {
		const entries = Object.entries(values);
		if (entries.length === 0) return;
		jobs.push(sync(undefined, entries[0][1])); // first entry = the unlocalized default
		for (const [lang, value] of entries) jobs.push(sync(lang, value));
	};

	if (opts.name && !overLimit("name", opts.name, NAME_MAX)) {
		eachLang(opts.name, async (lang, value) => {
			const current = await bot.api.getMyName(langParam(lang));
			if (current.name === value) return;
			await bot.api.setMyName({ name: value, ...langParam(lang) });
			log.info(`name synced${lang ? ` (${lang})` : ""}`);
		});
	}
	if (
		opts.description &&
		!overLimit("description", opts.description, DESCRIPTION_MAX)
	) {
		eachLang(opts.description, async (lang, value) => {
			const current = await bot.api.getMyDescription(langParam(lang));
			if (current.description === value) return;
			await bot.api.setMyDescription({
				description: value,
				...langParam(lang),
			});
			log.info(`description synced${lang ? ` (${lang})` : ""}`);
		});
	}
	if (opts.about && !overLimit("about", opts.about, ABOUT_MAX)) {
		eachLang(opts.about, async (lang, value) => {
			const current = await bot.api.getMyShortDescription(langParam(lang));
			if (current.short_description === value) return;
			await bot.api.setMyShortDescription({
				short_description: value,
				...langParam(lang),
			});
			log.info(`about synced${lang ? ` (${lang})` : ""}`);
		});
	}
	if (opts.commands) {
		eachLang(opts.commands, async (lang, list) => {
			const current = await bot.api.getMyCommands(langParam(lang));
			if (commandsEqual(current, list)) return;
			await bot.api.setMyCommands({ commands: [...list], ...langParam(lang) });
			log.info(`commands synced${lang ? ` (${lang})` : ""} (${list.length})`);
		});
	}

	try {
		await Promise.all(jobs);
	} catch (e) {
		log.error(`profile sync failed: ${e instanceof Error ? e.message : e}`);
	}

	await checkExpectations(bot, opts).catch((e) =>
		log.error(
			`expectation check failed: ${e instanceof Error ? e.message : e}`,
		),
	);
}

/** The BotFather-drift check: warn the admins when a declared capability is off. */
async function checkExpectations(
	bot: ProfileBot,
	opts: BotProfileOptions,
): Promise<void> {
	if (!opts.expects?.inline) return;
	if (bot.info?.supports_inline_queries !== false) return; // true, or unknown (no getMe yet)

	const handle = bot.info?.username ? `@${bot.info.username}` : "this bot";
	log.warn(
		`inline mode is OFF for ${handle} — the bot's inline features are dead`,
	);
	const ids =
		typeof opts.adminIds === "function"
			? await opts.adminIds()
			: (opts.adminIds ?? []);
	if (ids.length === 0) return;
	await notifyAdmins(
		bot as Parameters<typeof notifyAdmins>[0],
		ids,
		`⚠️ ${handle}: inline mode is OFF, but this bot's features depend on it.\n` +
			"Only BotFather can enable it: @BotFather → /setinline (and /setinlinefeedback).",
	);
}
