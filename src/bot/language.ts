/**
 * Per-user language preference for GramIO bots.
 *
 * Follows gramio's canonical "shared infrastructure" pattern (see
 * [Composer docs — Production Architecture](https://gramio.dev/extend/middleware.html#production-architecture)):
 * the bot's session is extended once at the top level by the user,
 * and each feature plugin declares it as a required dependency.
 * gramio's runtime deduplication ensures the session derive runs
 * exactly once per update; TypeScript flows the session's data shape
 * into every plugin that `.extend()`s it.
 *
 * ## What this plugin owns
 *
 *   - Validates the supported BCP-47 language tags via `Intl.getCanonicalLocales`
 *   - Resolves `ctx.lang` AND `ctx.say` on every event (stored pick → Telegram
 *     hint → default), all READ-TIME: the hint is never persisted, so a user who
 *     switches their Telegram client language moves with it until they pick
 *   - Persists a language as `ctx.session.language` ONLY on an explicit pick
 *     (the menuItem action) — consumers must not auto-write inferred values
 *   - Provides a `menuItem` for a `botMenu`'s language picker (highlight shows
 *     the EFFECTIVE language, hint included)
 *
 * ## What this plugin does NOT own
 *
 *   - The session itself. The user creates it (`session(...)`) and
 *     extends it at bot level before this plugin.
 *   - GDPR machinery. A language preference is trivially covered by
 *     [Telegram's Standard Bot Privacy Policy](https://telegram.org/privacy-tpa)
 *     under "data necessary to function".
 *
 * ## Resolution priority for `ctx.lang`
 *
 *   1. `ctx.session.language` — stored override
 *   2. `ctx.from.languageCode` — Telegram-detected user lang, only in
 *      user-scoped resolution (in groups it would flicker per-speaker)
 *   3. `default` — the fallback passed at construction
 *
 * Peer deps: `gramio`, `@gramio/session`.
 *
 * @example
 * import { Bot } from 'gramio'
 * import { session } from '@gramio/session'
 * import { redisStorage } from '@gramio/storage-redis'
 * import { language } from '@adriangalilea/utils/bot/language'
 *
 * const userSession = session({
 *   storage: redisStorage(),
 *   key: 'session',
 *   initial: () => ({}),     // plugins add their fields by convention
 * })
 *
 * const lang = language({
 *   session: userSession,
 *   supported: ['en','es'] as const,
 *   default: 'en',
 * })
 *
 * const bot = new Bot(process.env.BOT_TOKEN!)
 *   .extend(userSession)        // ← FIRST: ctx.session lands on the real ctx
 *   .extend(lang.plugin)        // declares userSession as dep; runtime dedup
 *   .command('hello', (ctx) => ctx.send({ en: 'Hello', es: 'Hola' }[ctx.lang]))
 */

import type { session } from "@gramio/session";
import { type DeriveDefinitions, type InlineKeyboard, Plugin } from "gramio";

import { type Polyglot, say } from "../say/index.js";
import type { ActionResult, MenuCtx, MenuItem } from "./menu.js";

// ─── public types ──────────────────────────────────────────────────

/** Branded BCP-47 language tag — obtainable only via the validators below. */
export type LangCode = string & { readonly __langCode: unique symbol };

/**
 * Validate + canonicalize a BCP-47 tag using the standard
 * `Intl.getCanonicalLocales`. Throws `RangeError` on invalid input.
 * Canonicalizes casing: `'en-us'` → `'en-US'`.
 */
export const parseLangCode = (s: string): LangCode =>
	Intl.getCanonicalLocales(s)[0] as LangCode;

/** Non-throwing type guard. Same parser path as `parseLangCode`. */
export const isLangCode = (s: unknown): s is LangCode => {
	if (typeof s !== "string") return false;
	try {
		Intl.getCanonicalLocales(s);
		return true;
	} catch {
		return false;
	}
};

/**
 * Primary subtag of a Telegram client language hint (`"pt-BR"` → `"pt"`),
 * or undefined when absent/unusable. The shared normalizer behind every
 * read-time hint fallback (`ctx.lang`, `ctx.say`, menu chrome): the hint is
 * resolved live per event and NEVER persisted — only an explicit user pick
 * writes `session.language`.
 */
export const langHintOf = (code: string | undefined): string | undefined => {
	const primary = code?.toLowerCase().split("-")[0] ?? "";
	return /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
};

export type LanguageScopeStrategy = "user" | "chat";

export type LanguageScope =
	| LanguageScopeStrategy
	| {
			private?: LanguageScopeStrategy;
			group?: LanguageScopeStrategy;
			supergroup?: LanguageScopeStrategy;
			channel?: LanguageScopeStrategy;
	  };

/** Loose session shape — the plugin only touches the `language` field. */
type SessionLike = { language?: string };

/** @internal — kept unexported so it doesn't clash with peers' refs. */
type LangSessionPluginRef = ReturnType<typeof session<SessionLike, "session">>;

export type LanguageOptions<Langs extends readonly string[]> = {
	/**
	 * The session plugin to read/write `ctx.session.language` from.
	 * Must be extended on the bot before this plugin (gramio's runtime
	 * dedup ensures the session derive only runs once per update).
	 */
	session: LangSessionPluginRef;
	/** Tuple of BCP-47 tags. Each validated via `Intl.getCanonicalLocales`. */
	supported: Langs;
	/** Must be a member of `supported`. */
	default: Langs[number];
	/** See module docstring. Per chat-type override possible. */
	scope?: LanguageScope;
	/**
	 * Override per-language menu label. Default uses an emoji flag prefix
	 * derived from the language code.
	 */
	labels?: Partial<Record<Langs[number], string>>;
	/**
	 * Header text for the language sub-menu. Accepts a plain string or a
	 * polyglot literal. Default: `{ en: '🌐 Language', es: '🌐 Idioma' }`.
	 */
	menuLabel?: string | Polyglot<string>;
};

export type LanguageFeature<Lang extends string> = {
	plugin: ReturnType<typeof buildLanguagePlugin<Lang>>;
	menuItem: MenuItem;
};

// ─── derives ───────────────────────────────────────────────────────

/**
 * Callable namespace attached to `ctx.say`.
 *
 *   ctx.say({ en, es })           — resolves to a string at ctx.lang
 *   ctx.say.send({ en, es }, p?)  — ctx.send with the resolved string
 *   ctx.say.edit({ en, es }, p?)  — ctx.editText (callback ctx only)
 *   ctx.say.answer({ en, es }, p?)— ctx.answer (callback ctx only)
 *
 * `.send` is valid wherever `ctx.send` exists; `.edit` / `.answer`
 * require a callback_query ctx. Calling the wrong one for the event
 * type raises a clear TypeError at runtime — the type-level declares
 * them uniformly to keep the surface flat.
 */
export type Sayer<L extends string> = {
	<V extends Polyglot<L>>(value: V): string;
	send<V extends Polyglot<L>>(value: V, params?: object): Promise<unknown>;
	edit<V extends Polyglot<L>>(value: V, params?: object): Promise<unknown>;
	answer<V extends Polyglot<L>>(value: V, params?: object): Promise<unknown>;
};

/**
 * What this plugin decorates onto `ctx`. Two surfaces:
 *
 *   - `ctx.lang` — the user's current language, **resolved once at
 *     event start and frozen** for the rest of the handler. Cheap to
 *     read repeatedly, but goes stale if you mutate
 *     `ctx.session.language` mid-handler (typical inside a
 *     `MenuItem.action` that flips the user's selection). For
 *     post-mutation freshness use `ctx.session.language` directly,
 *     or call `ctx.say(...)` which is live.
 *
 *   - `ctx.say(value)` — callable + namespace, **resolves the lang
 *     on every call** by re-reading `ctx.session.language`. Safe to
 *     use both before and after a mid-handler mutation. Plus
 *     `.send / .edit / .answer` that forward to gramio's
 *     `ctx.send / .editText / .answer` with the resolved string.
 */
type LanguageDerives<Lang extends string> = {
	lang: Lang;
	say: Sayer<Lang>;
};

/**
 * Builds `ctx.say` with LIVE lang resolution — the lang is re-read
 * from `ctx.session.language` on every `say(value)` / `.send` / `.edit`
 * / `.answer` call. That way handlers that mutate the session
 * (e.g. a `MenuItem.action` flipping the user's language) and then
 * emit further messages within the same event get the freshly-stored
 * lang, NOT the one that was captured when `derive` ran at event start.
 *
 * Contrast with `ctx.lang`, which IS a snapshot at event start and
 * stays static through the handler. Read `ctx.session.language`
 * directly (or call `ctx.say(...)`) when you need post-mutation
 * freshness.
 */
const buildSayer = <L extends string>(
	ctx: unknown,
	canonicalSet: ReadonlySet<string>,
	defaultLang: L,
	/** Scope-resolved Telegram hint, precomputed by the derive (it can't change
	 *  mid-handler); the read-time fallback between the stored pick and the default. */
	hintLang?: L,
): Sayer<L> => {
	type CtxLike = {
		session?: { language?: string };
		send?: (text: string, params?: object) => Promise<unknown>;
		editText?: (text: string, params?: object) => Promise<unknown>;
		answer?: (params: object) => Promise<unknown>;
	};
	const c = ctx as CtxLike;

	const currentLang = (): L => {
		const stored = c.session?.language;
		if (stored && canonicalSet.has(stored)) return stored as L;
		return hintLang ?? defaultLang;
	};

	const resolve = <V extends Polyglot<L>>(value: V): string => {
		const lang = currentLang();
		return (
			value[lang] ?? value[defaultLang] ?? say(value as Polyglot<string>, lang)
		);
	};

	const fn = (<V extends Polyglot<L>>(value: V): string =>
		resolve(value)) as Sayer<L>;

	fn.send = (value, params) => {
		if (typeof c.send !== "function") {
			throw new TypeError(
				"ctx.say.send: ctx.send is not available on this event",
			);
		}
		// ctx.send auto-forwards message_thread_id (gramio SendMixin).
		return c.send(resolve(value), params);
	};
	fn.edit = (value, params) => {
		if (typeof c.editText !== "function") {
			throw new TypeError(
				"ctx.say.edit: ctx.editText is only available on callback_query events",
			);
		}
		return c.editText(resolve(value), params);
	};
	fn.answer = (value, params) => {
		if (typeof c.answer !== "function") {
			throw new TypeError(
				"ctx.say.answer: ctx.answer is only available on callback_query events",
			);
		}
		return c.answer({ text: resolve(value), ...(params ?? {}) });
	};

	return fn;
};

// ─── scope helpers ─────────────────────────────────────────────────

const DEFAULT_SCOPE = {
	private: "user" as LanguageScopeStrategy,
	group: "chat" as LanguageScopeStrategy,
	supergroup: "chat" as LanguageScopeStrategy,
	channel: "chat" as LanguageScopeStrategy,
} as const;

const resolveScope = (
	scope: LanguageScope | undefined,
	chatType: string,
): LanguageScopeStrategy => {
	if (typeof scope === "string") return scope;
	const t = chatType as keyof typeof DEFAULT_SCOPE;
	return scope?.[t] ?? DEFAULT_SCOPE[t] ?? "user";
};

// ─── flag emoji (best-effort) ──────────────────────────────────────

const REGIONLESS_FLAGS: Record<string, string> = {
	en: "🇬🇧",
	es: "🇪🇸",
	fr: "🇫🇷",
	de: "🇩🇪",
	it: "🇮🇹",
	pt: "🇵🇹",
	ru: "🇷🇺",
	zh: "🇨🇳",
	ja: "🇯🇵",
	ko: "🇰🇷",
	ar: "🇸🇦",
	tr: "🇹🇷",
	pl: "🇵🇱",
	nl: "🇳🇱",
	uk: "🇺🇦",
	hi: "🇮🇳",
	bn: "🇧🇩",
	id: "🇮🇩",
	vi: "🇻🇳",
	th: "🇹🇭",
	fa: "🇮🇷",
	he: "🇮🇱",
};

const regionToFlag = (region: string): string =>
	String.fromCodePoint(
		...region
			.toUpperCase()
			.split("")
			.map((c) => 0x1f1a5 + c.charCodeAt(0)),
	);

/** A representative flag for a language tag: the region's flag when the tag carries one
 *  (`pt-BR` → 🇧🇷), a curated flag for common regionless tags (`es` → 🇪🇸), 🌐 otherwise. */
export const flagFor = (lang: string): string => {
	const parts = lang.split("-");
	if (parts.length > 1) {
		const region = parts.find((p) => /^[A-Z]{2}$/.test(p));
		if (region) return regionToFlag(region);
	}
	return REGIONLESS_FLAGS[parts[0].toLowerCase()] ?? "🌐";
};

/** The language's name in itself (`es` → "Español", `ja` → "日本語") — what its own
 *  speakers scan a picker for. Falls back to the tag when Intl doesn't know it. */
export const autonym = (lang: string): string => {
	try {
		const dn = new Intl.DisplayNames([lang], { type: "language" });
		return dn.of(lang) ?? lang;
	} catch {
		return lang;
	}
};

/** The canonical picker label: flag + autonym (`es` → "🇪🇸 Español"). The autonym is
 *  title-cased for the label position — Intl returns "español" (correct in running
 *  Spanish prose, wrong on a button); caseless scripts pass through untouched. */
export const languageLabel = (lang: string): string => {
	const name = autonym(lang);
	return `${flagFor(lang)} ${name.charAt(0).toLocaleUpperCase(lang)}${name.slice(1)}`;
};

/**
 * The language-picker MenuItem, storage- and policy-agnostic: one submenu entry per
 * code, packed two-up, the active code wearing Telegram's `primary` fill, re-rendered
 * in place after a tap. What "active" means and what a tap DOES live in your closures —
 * the plugin's own session-writing `menuItem`, a group-scoped admin-gated picker, and a
 * tier-gated one are all this one factory.
 *
 * `pick` returns the toast (or a refusal toast — gate inside it); the menu owns the
 * single answerCallbackQuery, so never call `ctx.answer` from `pick`.
 */
export type LanguagePickerSpec = {
	/** MenuItem id (default "lang"); submenu entry ids are the codes. */
	id?: string;
	/** The submenu button's label. */
	label: string | Polyglot<string>;
	codes: readonly string[];
	/** Button label per code; default {@link languageLabel}. */
	labelFor?: (code: string) => string;
	isActive: (ctx: MenuCtx, code: string) => boolean | Promise<boolean>;
	pick: (ctx: MenuCtx, code: string) => ActionResult | Promise<ActionResult>;
};

export function languagePickerItem(spec: LanguagePickerSpec): MenuItem {
	const labelFor = spec.labelFor ?? languageLabel;
	return {
		id: spec.id ?? "lang",
		label: spec.label,
		submenu: spec.codes.map((code, i, arr) => ({
			id: code,
			label: labelFor(code),
			// Two per row (break after each even index).
			keepRow: i % 2 === 0 && i < arr.length - 1,
			style: async (ctx) =>
				(await spec.isActive(ctx, code)) ? "primary" : undefined,
			refresh: true,
			action: (ctx) => spec.pick(ctx, code),
		})),
	};
}

/**
 * Append flag-labeled language rows to an InlineKeyboard — the raw-surface twin of
 * {@link languagePickerItem} for keyboards outside `botMenu` (an onboarding /start, a
 * group welcome). The caller owns the callback schema: `pack(code)` returns the
 * callback_data. Returns the same keyboard, so lead rows go before and trailing rows
 * chain after.
 */
export function addLanguageRows(
	kb: InlineKeyboard,
	opts: {
		codes: readonly string[];
		pack: (code: string) => string;
		labelFor?: (code: string) => string;
		/** The code that wears the active fill (the current setting), if any. */
		active?: string;
		/** The active code's fill (default `primary`). Pass `success` when blue already
		 *  means something else on the same keyboard (e.g. an active nav tab). */
		activeStyle?: "primary" | "success" | "danger";
		perRow?: number;
	},
): InlineKeyboard {
	const labelFor = opts.labelFor ?? languageLabel;
	const perRow = opts.perRow ?? 2;
	opts.codes.forEach((code, i) => {
		if (i % perRow === 0) kb.row();
		kb.text(
			labelFor(code),
			opts.pack(code),
			code === opts.active ? { style: opts.activeStyle ?? "primary" } : undefined,
		);
	});
	return kb;
}

// ─── feature factory ───────────────────────────────────────────────

export const language = <const Langs extends readonly string[]>(
	opts: LanguageOptions<Langs>,
): LanguageFeature<Langs[number]> => {
	type Lang = Langs[number];

	const scopeOpt = opts.scope;
	const labels = (opts.labels ?? {}) as Record<string, string>;
	const menuLabel: string | Polyglot<string> = opts.menuLabel ?? {
		en: "🌐 Language",
		es: "🌐 Idioma",
	};

	// Canonicalize all supported tags at construction.
	const canonical = opts.supported.map((l): Lang => {
		try {
			return Intl.getCanonicalLocales(l)[0] as Lang;
		} catch {
			throw new Error(
				`language: "${l}" is not a valid BCP-47 tag (per Intl.getCanonicalLocales)`,
			);
		}
	});
	const canonicalSet = new Set<string>(canonical);

	let defaultLanguage: Lang;
	try {
		defaultLanguage = Intl.getCanonicalLocales(opts.default)[0] as Lang;
	} catch {
		throw new Error(
			`language: default "${opts.default}" is not a valid BCP-47 tag`,
		);
	}
	if (!canonicalSet.has(defaultLanguage)) {
		throw new Error(
			`language: default "${defaultLanguage}" is not in supported[]`,
		);
	}

	const matchSupported = (s: string | undefined): Lang | undefined => {
		if (!s) return undefined;
		try {
			const c = Intl.getCanonicalLocales(s)[0];
			if (canonicalSet.has(c)) return c as Lang;
		} catch {
			// fall through
		}
		return undefined;
	};

	// The user's EFFECTIVE language for chrome that renders outside the derive
	// (the picker highlight): stored pick → Telegram hint (full tag, then primary
	// subtag) → default. Read-time, mirrors the derive's chain.
	const effectiveLang = (ctx: unknown): Lang => {
		const c = ctx as {
			session?: { language?: string };
			from?: { languageCode?: string };
		};
		const stored = c.session?.language;
		if (stored && canonicalSet.has(stored)) return stored as Lang;
		return (
			matchSupported(c.from?.languageCode) ??
			matchSupported(langHintOf(c.from?.languageCode)) ??
			defaultLanguage
		);
	};

	const plugin = buildLanguagePlugin<Lang>({
		sessionPlugin: opts.session,
		canonicalSet,
		defaultLanguage,
		matchSupported,
		scopeOpt,
	});

	// The plugin's stock picker is the generic factory with session-backed closures.
	// `isActive` resolves stored → hint → default LIVE (not `ctx.lang`, the event-start
	// snapshot — stale within the same callback after `pick` mutated the session), so
	// the highlight tracks reality even before any explicit pick exists.
	const menuItem: MenuItem = languagePickerItem({
		label: menuLabel,
		codes: canonical,
		labelFor: (l) => labels[l] ?? languageLabel(l),
		isActive: (ctx, l) => effectiveLang(ctx) === l,
		pick: (ctx, l) => {
			// ctx.session is the shared session record; mutations go through
			// @gramio/session's Proxy and auto-persist. We own `language` by convention.
			const c = ctx as unknown as { session: { language?: Lang } };
			c.session.language = l as Lang;
			return `✓ ${l}`;
		},
	});

	return { plugin, menuItem };
};

// ─── plugin builder ────────────────────────────────────────────────

const buildLanguagePlugin = <Lang extends string>(args: {
	sessionPlugin: LangSessionPluginRef;
	canonicalSet: ReadonlySet<string>;
	defaultLanguage: Lang;
	matchSupported: (s: string | undefined) => Lang | undefined;
	scopeOpt: LanguageScope | undefined;
}) => {
	const {
		sessionPlugin,
		canonicalSet,
		defaultLanguage,
		matchSupported,
		scopeOpt,
	} = args;

	return (
		new Plugin<
			Record<string, never>,
			DeriveDefinitions & { global: LanguageDerives<Lang> }
		>("@adriangalilea/utils/bot/language")
			// Declare the session as a dependency. gramio's runtime dedupes
			// this against the bot's top-level session extension so the
			// session derive runs exactly once per update — but the types
			// (ctx.session: SessionLike) flow into our handlers below.
			.extend(sessionPlugin)
			.derive(
				// Inline events included: ctx.lang/ctx.say must exist wherever the
				// user speaks to the bot, or consumers fork their own resolvers.
				["message", "callback_query", "inline_query", "chosen_inline_result"],
				(ctx) => {
					// The Telegram hint, scope-resolved ONCE per event (it can't change
					// mid-handler): honored only in user-scoped resolution — in groups it
					// would flicker per-speaker. Full tag first ("pt-BR"), then its
					// primary subtag ("pt"). Never persisted: the read-time middle rung
					// between a stored explicit pick and the configured default.
					// Inline events carry no chat — they resolve as "private" (user-scoped),
					// which is what an inline interaction is. Structural read: `message`
					// only exists on callback ctxs in the widened event union.
					const chatType = ctx.is("message")
						? ctx.chat.type
						: ((ctx as { message?: { chat: { type: string } } }).message?.chat
								.type ?? "private");
					const strategy = resolveScope(scopeOpt, chatType);
					const hintLang =
						strategy === "user"
							? (matchSupported(ctx.from.languageCode) ??
								matchSupported(langHintOf(ctx.from.languageCode)))
							: undefined;

					// Snapshot resolved at event start. Stays static through the
					// handler — see the JSDoc on `LanguageDerives.lang` below for
					// the staleness gotcha and why `ctx.say` is the live escape.
					const stored = ctx.session.language;
					const lang: Lang =
						stored && canonicalSet.has(stored)
							? (stored as Lang)
							: (hintLang ?? defaultLanguage);

					return {
						lang,
						// LIVE: re-resolves ctx.session.language on every call so
						// post-mutation reads inside a handler get the new value;
						// falls to the hint, then the default, when nothing is stored.
						say: buildSayer<Lang>(ctx, canonicalSet, defaultLanguage, hintLang),
					};
				},
			)
	);
};
