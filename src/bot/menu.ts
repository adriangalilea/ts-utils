/**
 * Composable settings menu — registers a single slash command, renders
 * an `InlineKeyboard`, routes callbacks. Features (language, history,
 * etc.) contribute items; the bot builder adds custom items inline.
 *
 * ## Why menu is a separate primitive
 *
 * The user-facing menu is just UI — composing items. Features (per-user
 * state, recording, gates) have their OWN runtime behaviour independent
 * of any menu.
 *
 * ## Privacy & data submenu
 *
 * The menu always renders a single `🛡️ Privacy & data` button at root
 * which navigates to a virtual submenu containing the privacy policy
 * link plus (when `personalData: { storage }` is passed):
 *
 *   - 🗑 Forget my data — `storage.delete(sessionKey(userId))`
 *   - 📥 Export my data — `storage.get(sessionKey(userId))` → JSON file
 *   - 📖 Privacy policy  — URL from `privacy` (defaults to Telegram's)
 *
 * Keeping these one tap away avoids cluttering the root view with
 * destructive / informational buttons that the user only needs rarely.
 *
 * Because all per-user state across our plugins lives in ONE shared
 * session record (see `bot/language`, `bot/llm`'s `llmHistory`), wiping
 * or exporting that single key covers everything in one shot. No
 * registry, no cascade, no per-plugin coordination.
 *
 * The `sessionKey` option defaults to `String(userId)` — matching
 * `@gramio/session`'s default `getSessionKey: (ctx) => `${ctx.senderId}`.
 * If you customize the session's `getSessionKey`, pass a matching
 * function here.
 *
 * ## Privacy URL
 *
 * `privacy` defaults to [Telegram's Standard Bot Privacy Policy](https://telegram.org/privacy-tpa)
 * which covers everything the plugins in this package retain
 * (language preference, access state, threaded LLM conversation
 * history — Telegram designed Threaded Mode explicitly for AI
 * chatbots with multi-turn memory). Override only if your bot retains
 * data beyond what the plugins do.
 *
 * Peer deps: `gramio`, `@gramio/storage`.
 *
 * @example  Personal LLM bot — language only, no retention
 *
 * import { language } from '@adriangalilea/utils/bot/language'
 * import { botMenu } from '@adriangalilea/utils/bot/menu'
 *
 * const lang = language({ session: userSession, supported: ['en','es'] as const, default: 'en' })
 *
 * const menu = botMenu({
 *   command: 'settings',
 *   description: 'Open settings',
 *   adminContact: '@adriangalilea',
 *   items: [lang.menuItem],
 * })
 *
 * bot.extend(userSession).extend(lang.plugin).extend(menu.plugin)
 *
 * @example  Bot with retention — adds Forget/Export
 *
 * const menu = botMenu({
 *   command: 'settings',
 *   description: 'Open settings',
 *   adminContact: '@adriangalilea',
 *   privacy: 'https://yourbot.com/privacy',
 *   personalData: { storage },              // ← enables Forget/Export
 *   items: [lang.menuItem],
 * })
 *
 * bot
 *   .extend(userSession)
 *   .extend(history.plugin)
 *   .extend(menu.plugin)
 */

import type { Storage } from "@gramio/storage";
import { CallbackData, InlineKeyboard, Plugin } from "gramio";

import { type Polyglot, say } from "../say/index.js";
import { botStorageKey } from "./keys.js";

// ─── public types ──────────────────────────────────────────────────

/**
 * Shape of the `ctx` an action / label / predicate sees.
 *
 * - Static fields (`bot`, `from`, `chat`, `session`, `threadId`,
 *   `message`) come from gramio's `CallbackQueryContext`.
 * - Common reply methods (`send`, `reply`, `answer`, `editText`) are
 *   declared as optional so action callbacks can call them without
 *   `as unknown as` casts. They exist at runtime on every callback ctx
 *   gramio dispatches.
 * - Plugin-decorated fields (`ctx.llm`, `ctx.say`, `ctx.lang`, …)
 *   live on the real gramio ctx but aren't declared here — narrow
 *   them via a local type assertion where you use them. The menu
 *   stays plugin-agnostic.
 */
export type MenuCtx = {
	bot: unknown;
	from?: { id: number };
	chat?: { id: number; type: string };
	session?: { language?: string };
	threadId?: number;
	message?: { threadId?: number };
	send?: (
		text: string | { toString(): string },
		params?: object,
	) => Promise<unknown>;
	reply?: (
		text: string | { toString(): string },
		params?: object,
	) => Promise<unknown>;
	answer?: (params: object) => Promise<unknown>;
	// gramio 0.12 narrowed ctx.editText's text param to `string | undefined`;
	// the menu only ever passes strings, so `string` keeps the real gramio
	// ctx assignable to MenuCtx on both 0.10 and 0.12.
	editText?: (text: string, params?: object) => Promise<unknown>;
};

/**
 * Anything a button or header can render as. Authoring a polyglot
 * label is just an inline `{ en, es }` literal — `say()` resolves it
 * to the recipient's language at render time.
 *
 *   label: 'Static'
 *   label: { en: 'Settings', es: 'Ajustes' }
 *   label: (ctx) => `Hi ${ctx.from?.firstName}`
 *   label: (ctx) => ({ en: `Hi ${name}`, es: `Hola ${name}` })
 */
type Label =
	| string
	| Polyglot<string>
	| ((ctx: MenuCtx) => string | Polyglot<string>);
type Predicate = (ctx: MenuCtx) => boolean;

/**
 * What a menu action's return value means:
 *
 *   - `undefined` / `void` — menu sends an empty `answerCallbackQuery`
 *     (just clears the loading spinner).
 *   - `string` — menu sends `answerCallbackQuery({ text })`. The string
 *     pops as a toast on top of the chat.
 *   - `Polyglot<string>` — menu resolves at `ctx.session?.language` and
 *     sends as toast.
 *
 * DO NOT call `ctx.answer(...)` from inside an action — Telegram
 * rejects the second answer ("query is too old"), the action throws,
 * and `refresh: true` never runs. Return the toast instead; the menu
 * sends the single answer.
 */
type ActionResult = undefined | string | Polyglot<string>;
type Action = (ctx: MenuCtx) => Promise<ActionResult> | ActionResult;

/**
 * Telegram's inline-keyboard-button colour modes
 * ([Bot API InlineKeyboardButton.style](https://core.telegram.org/bots/api#inlinekeyboardbutton)):
 *
 *   - `primary` — blue, "selected / active / default action"
 *   - `success` — green, "positive / approve / confirm"
 *   - `danger`  — red, "destructive / reject / forget"
 *
 * On clients that don't render the style (older Telegram releases),
 * the button falls back to the app-default look — no breakage. Use
 * `style` instead of emoji markers (●/○) to mark active state, which
 * is consistent with how Telegram itself surfaces selection state.
 */
export type ButtonStyle = "primary" | "success" | "danger";

type StyleResolver = ButtonStyle | ((ctx: MenuCtx) => ButtonStyle | undefined);

const FALLBACK_LANG = "en";
const ctxLang = (ctx: MenuCtx): string =>
	ctx.session?.language ?? FALLBACK_LANG;

const styleOf = (
	s: StyleResolver | undefined,
	ctx: MenuCtx,
): ButtonStyle | undefined => {
	if (s === undefined) return undefined;
	if (typeof s === "function") return s(ctx);
	return s;
};

/**
 * An entry in the menu. Three variants:
 *
 *   - `action` — callback button; taps run `action(ctx)`. If
 *                `refresh: true`, the current menu message
 *                re-renders right after — useful for selections /
 *                toggles whose visible state depends on what the
 *                action mutated (typical: `style` based on session).
 *   - `url`    — link button (Telegram opens it externally).
 *   - `submenu` — nested item tree, navigated to via callback.
 *
 * `style` (`primary` / `success` / `danger`) maps to Telegram's
 * coloured inline-button modes; the resolver form `(ctx) => style`
 * is for state-dependent colouring (e.g. blue on the currently-selected
 * language).
 *
 * **Live state inside resolvers run by `refresh: true`.** Label /
 * style resolvers fire AFTER the action mutated the session. Read
 * mutable state from `ctx.session.<field>` directly — *not* from
 * derives that snapshot at event start (e.g. `ctx.lang` from
 * `bot/language` is the event-start value, NOT the post-mutation
 * one). `ctx.say(...)` IS live and safe to use anywhere.
 *
 * **`id` must not contain `.`.** Submenu paths are dot-joined into
 * callback_data (`parent.child.grandchild`), so a dot in an id
 * collides with the path separator and the route resolver returns
 * "Item not found" with no logging. Use `_` instead. The plugin
 * validates this at registration; misformatted ids panic the build
 * rather than silently mis-routing.
 */
export type MenuItem =
	| {
			id: string;
			label: Label;
			action: Action;
			order?: number;
			visible?: Predicate;
			style?: StyleResolver;
			/** Render on the same row as the following item (no row break after this button). */
			keepRow?: boolean;
			/** Render at the bottom of the root menu, below the Privacy & data button. */
			rootExtra?: boolean;
			/** Re-render the menu message after the action runs. */
			refresh?: boolean;
			/**
			 * Adds a one-step confirmation before the action runs. First tap
			 * edits the menu message in place to show `prompt` + "Confirm" /
			 * "Cancel" buttons; the action only runs on Confirm.
			 *
			 * Use this for destructive actions instead of
			 * `ctx.answer({ show_alert: true })` — Telegram's alert UI is
			 * disruptive and doesn't compose with refresh / toast.
			 *
			 * After Confirm runs the action, the menu navigates back to
			 * root (so the user lands in a known-good state).
			 */
			confirm?: {
				/** Body text rendered above the Confirm/Cancel buttons. */
				prompt: Label;
				/** Override "✅ Confirm" label. Default: polyglot en/es. */
				confirmLabel?: Label;
				/** Override "⬅️ Cancel" label. Default: polyglot en/es. */
				cancelLabel?: Label;
			};
	  }
	| {
			id: string;
			label: Label;
			url: string;
			order?: number;
			visible?: Predicate;
			style?: StyleResolver;
			/** Render on the same row as the following item (no row break after this button). */
			keepRow?: boolean;
			/** Render at the bottom of the root menu, below the Privacy & data button. */
			rootExtra?: boolean;
	  }
	| {
			id: string;
			label: Label;
			submenu: MenuItem[];
			order?: number;
			visible?: Predicate;
			style?: StyleResolver;
			/** Render on the same row as the following item (no row break after this button). */
			keepRow?: boolean;
			/** Render at the bottom of the root menu, below the Privacy & data button. */
			rootExtra?: boolean;
	  };

export type PersonalDataOptions = {
	/**
	 * Storage backend where each user's data lives. Must be the SAME
	 * instance you passed to your `session(...)` (or `botSession(...)`)
	 * plugin — that's how /forget and /export reach the right keys.
	 *
	 * The storage key for the calling user is derived as
	 * `bot-<botId>:<userId>` via `botStorageKey(ctx, userId)`, matching
	 * the namespace `botSession` uses by default. No `sessionKey`
	 * override exists because every plugin in this package shares the
	 * same key shape by construction.
	 */
	storage: Storage;
};

export type BotMenuOptions = {
	/** Slash command that opens the menu. Default `'settings'`. */
	command?: string;
	/** Description shown in Telegram's command list. */
	description?: string;
	/** Items rendered top-down (sorted by `order`, then registration). */
	items?: MenuItem[];
	/**
	 * URL to your privacy policy. Defaults to Telegram's Standard Bot
	 * Privacy Policy. Override when you retain content or process data
	 * beyond what the standard covers.
	 */
	privacy?: string;
	/**
	 * Header text rendered above the keyboard.
	 */
	header?: Label;
	/**
	 * Contact the user can reach when something fails (export error,
	 * etc.). **Required** — a bot that asks users to trust it with
	 * data must always offer a human to talk to when the automated
	 * paths fail.
	 */
	adminContact: string;
	/**
	 * Enables 🗑 Forget my data and 📥 Export my data buttons inside
	 * the `🛡️ Privacy & data` submenu. Pass the storage instance
	 * backing your `session()`. If omitted, the submenu still appears
	 * but only shows the privacy policy link (use this for bots with
	 * no per-user state beyond what Telegram's standard policy covers).
	 */
	personalData?: PersonalDataOptions;
	/**
	 * Allow the menu to open and operate in group chats. Off by default: with
	 * `personalData` set the menu is private-only (data controls shouldn't surface
	 * in a group). Turn on when the menu hosts a group-scoped control (e.g. a
	 * per-group toggle) that must be reachable from inside the group.
	 */
	allowInGroups?: boolean;
};

const DEFAULT_COMMAND = "settings";
const DEFAULT_DESCRIPTION = "Open settings menu";
const DEFAULT_PRIVACY_URL = "https://telegram.org/privacy-tpa";
const DEFAULT_HEADER: Polyglot<string> = { en: "⚙️ Settings", es: "⚙️ Ajustes" };

// ─── callback data schemas ─────────────────────────────────────────

/**
 * Callback data for navigating between menu levels. Exported so peer
 * plugins (e.g. `bot/payments`'s `require()` upgrade prompt) can pack
 * a "jump to /settings → <id>" button without duplicating the schema
 * name/fields. Routes through the handler registered below.
 *
 *   menuNavCb.pack({ path: 'pay' })           → goes to `pay` submenu
 *   menuNavCb.pack({ path: '_root' })          → goes back to root
 *   menuNavCb.pack({ path: 'pay.history' })    → nested path
 */
export const menuNavCb = new CallbackData("mNav").string("path");
// Internal alias — keeps the file's existing references compact.
const navCb = menuNavCb;
const actCb = new CallbackData("mAct").string("path");
/** Fired when the user taps Confirm in a `confirm:` flow. `path`
 *  identifies the underlying MenuItem.action to run. */
const actConfirmCb = new CallbackData("mActC").string("path");
const forgetConfirmCb = new CallbackData("mFcfm");
const forgetCancelCb = new CallbackData("mFcnl");
const exportCb = new CallbackData("mExp");
/** Close button — dismisses the settings message entirely. */
const closeCb = new CallbackData("mCls");

// ─── BotMenu (the builder) ─────────────────────────────────────────

type ResolvedPersonalData = {
	storage: Storage;
};

type ResolvedOpts = {
	command: string;
	description: string;
	privacy: string;
	header: Label;
	adminContact: string;
	personalData: ResolvedPersonalData | null;
	allowInGroups: boolean;
};

// Recursively validate that no MenuItem id contains `.` — the menu's
// callback paths are dot-joined, so a dot in an id collides with the
// separator and silently mis-routes. Fail loud at construction.
const validateMenuItemIds = (
	items: ReadonlyArray<MenuItem>,
	where: string,
): void => {
	for (const item of items) {
		if (item.id.includes(".")) {
			throw new Error(
				`bot/menu: MenuItem.id "${item.id}" must not contain '.' (path separator) ` +
					`at ${where}. Use '_' instead. The plugin would otherwise silently ` +
					`return "Item not found" on tap with no logging.`,
			);
		}
		if ("submenu" in item) {
			validateMenuItemIds(item.submenu, `${where}.${item.id}`);
		}
	}
};

export class BotMenu {
	/** @internal */
	readonly _items: MenuItem[];
	/** @internal */
	readonly _opts: ResolvedOpts;

	constructor(opts: BotMenuOptions) {
		this._items = [...(opts.items ?? [])];
		validateMenuItemIds(this._items, "botMenu");
		this._opts = {
			command: opts.command ?? DEFAULT_COMMAND,
			description: opts.description ?? DEFAULT_DESCRIPTION,
			privacy: opts.privacy ?? DEFAULT_PRIVACY_URL,
			header: opts.header ?? DEFAULT_HEADER,
			adminContact: opts.adminContact,
			personalData: opts.personalData
				? { storage: opts.personalData.storage }
				: null,
			allowInGroups: opts.allowInGroups ?? false,
		};
	}

	/** Append a custom item. Mutates the menu. */
	add(item: MenuItem): this {
		validateMenuItemIds([item], "botMenu.add");
		this._items.push(item);
		return this;
	}

	/** The gramio plugin: registers the slash command + all callback handlers. */
	get plugin() {
		return buildMenuPlugin(this);
	}
}

export const botMenu = (opts: BotMenuOptions): BotMenu => new BotMenu(opts);

// ─── toggleMenuItem ────────────────────────────────────────────────

export type ToggleMenuItemOptions = {
	/** Item id within the menu. Must be unique among siblings. */
	id: string;
	/**
	 * Reads the current boolean value. Typically `(ctx) =>
	 * ctx.session?.someField ?? false`. Storage-agnostic — return
	 * `false` by default so the toggle starts in the OFF state.
	 */
	read: (ctx: MenuCtx) => boolean;
	/**
	 * Persists the new value. Typically `(ctx, v) => {
	 * (ctx.session as any).someField = v }`. The menu plugin does NOT
	 * own a session — write through whatever your bot already uses.
	 */
	write: (ctx: MenuCtx, value: boolean) => void | Promise<void>;
	/**
	 * Button labels for each state. Polyglot literals resolve against
	 * `ctx.session?.language` (set by `bot/language`); strings render
	 * as-is. Use functions for runtime composition (e.g. emoji ✓/✗ +
	 * dynamic name).
	 */
	label: {
		off: Label;
		on: Label;
	};
	/**
	 * Optional toast shown via `ctx.answer({ text })` after a tap. Same
	 * polyglot resolution as `label`. Omit to stay silent.
	 */
	toast?: {
		off?: Label;
		on?: Label;
	};
	order?: number;
	visible?: Predicate;
};

/**
 * Convenience factory for a boolean-toggle `MenuItem`. The label
 * tracks `read(ctx)` and the action flips it through `write(ctx, v)`.
 * Storage is the caller's concern — pass closures that read/write the
 * field wherever you keep it (typically `ctx.session.something`).
 *
 * The current menu message is NOT auto-re-rendered after a tap — the
 * new label is visible the next time the user re-opens or navigates.
 * The optional `toast` gives immediate feedback in the meantime.
 *
 * @example
 * toggleMenuItem({
 *   id: 'thinking',
 *   read: (ctx) => (ctx.session as { thinking?: boolean }).thinking ?? false,
 *   write: (ctx, v) => { (ctx.session as { thinking?: boolean }).thinking = v },
 *   label: {
 *     off: { en: '💭 Thinking: OFF', es: '💭 Razonamiento: OFF' },
 *     on:  { en: '💭 Thinking: ON',  es: '💭 Razonamiento: ON'  },
 *   },
 *   toast: {
 *     off: { en: 'Thinking off.', es: 'Razonamiento off.' },
 *     on:  { en: 'Thinking on.',  es: 'Razonamiento on.'  },
 *   },
 * })
 */
export const toggleMenuItem = (opts: ToggleMenuItemOptions): MenuItem => ({
	id: opts.id,
	order: opts.order,
	visible: opts.visible,
	// ON state is the active state → 'primary' (blue, Telegram's
	// "selected" colour). OFF state stays unstyled (app default).
	style: (ctx) => (opts.read(ctx) ? "primary" : undefined),
	// Re-render the menu after the tap so the user sees the colour /
	// label flip immediately, without having to re-open /settings.
	refresh: true,
	label: (ctx) => {
		const l = opts.read(ctx) ? opts.label.on : opts.label.off;
		return typeof l === "function" ? l(ctx) : l;
	},
	action: async (ctx) => {
		const wasOn = opts.read(ctx);
		const willBeOn = !wasOn;
		await opts.write(ctx, willBeOn);

		// Return the toast for the menu to send as the single
		// answerCallbackQuery — don't call ctx.answer directly here.
		const t = willBeOn ? opts.toast?.on : opts.toast?.off;
		if (t === undefined) return;
		const resolved = typeof t === "function" ? t(ctx) : t;
		return resolved;
	},
});

// ─── internal: rendering + plugin ──────────────────────────────────

const labelOf = (l: Label, ctx: MenuCtx): string => {
	const resolved = typeof l === "function" ? l(ctx) : l;
	if (typeof resolved === "string") return resolved;
	return say(resolved, ctxLang(ctx));
};

const itemsForPath = (root: MenuItem[], path: string[]): MenuItem[] | null => {
	if (path.length === 0) return root;
	const [head, ...rest] = path;
	const found = root.find((i) => i.id === head);
	if (!found || !("submenu" in found)) return null;
	return itemsForPath(found.submenu, rest);
};

const itemForPath = (root: MenuItem[], path: string[]): MenuItem | null => {
	if (path.length === 0) return null;
	let current: MenuItem[] | undefined = root;
	let last: MenuItem | undefined;
	for (const segment of path) {
		if (!current) return null;
		last = current.find((i) => i.id === segment);
		if (!last) return null;
		current = "submenu" in last ? last.submenu : undefined;
	}
	return last ?? null;
};

// Virtual segment that holds Forget / Export / Privacy under one
// submenu — keeps the root view focused on user-defined items, with
// the privacy/data controls one tap away. See `renderPrivacySubmenu`.
const PRIVACY_PATH = "_privacy";

const renderPrivacySubmenu = (menu: BotMenu, ctx: MenuCtx): InlineKeyboard => {
	const lang = ctxLang(ctx);
	const kb = new InlineKeyboard();
	if (menu._opts.personalData) {
		kb.text(
			say({ en: "🗑 Forget my data", es: "🗑 Olvidar mis datos" }, lang),
			actCb.pack({ path: "_forget" }),
			{ style: "danger" },
		);
		kb.row();
		kb.text(
			say({ en: "📥 Export my data", es: "📥 Exportar mis datos" }, lang),
			exportCb.pack({}),
		);
		kb.row();
	}
	kb.url(
		say({ en: "📖 Privacy policy", es: "📖 Política de privacidad" }, lang),
		menu._opts.privacy,
	);
	kb.row();
	// Submenu — Back and Close share one row.
	kb.text(
		say({ en: "⬅️ Back", es: "⬅️ Volver" }, lang),
		navCb.pack({ path: "_root" }),
	);
	kb.text(say({ en: "✖️ Close", es: "✖️ Cerrar" }, lang), closeCb.pack({}));
	return kb;
};

const renderKeyboard = (
	items: MenuItem[],
	ctx: MenuCtx,
	parentPath: string[],
): InlineKeyboard => {
	const kb = new InlineKeyboard();
	const isRoot = parentPath.length === 0;

	const sorted = [...items]
		.filter((i) => (i.visible ? i.visible(ctx) : true))
		.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

	const addButton = (item: MenuItem) => {
		const path = [...parentPath, item.id].join(".");
		const label = labelOf(item.label, ctx);
		const style = styleOf(item.style, ctx);
		const opts = style ? { style } : undefined;

		if ("action" in item) {
			kb.text(label, actCb.pack({ path }), opts);
		} else if ("url" in item) {
			kb.url(label, item.url, opts);
		} else {
			kb.text(label, navCb.pack({ path }), opts);
		}
		// `keepRow` packs this button with the next one on the same row.
		if (!item.keepRow) kb.row();
	};

	// `rootExtra` items render at the bottom (below Privacy & data), not here.
	for (const item of sorted) {
		if (isRoot && item.rootExtra) continue;
		addButton(item);
	}

	const lang = ctxLang(ctx);
	if (isRoot) {
		// Privacy + Forget + Export live one tap away to keep the root
		// view focused on user-defined items.
		kb.text(
			say({ en: "🛡️ Privacy & data", es: "🛡️ Privacidad y datos" }, lang),
			navCb.pack({ path: PRIVACY_PATH }),
		);
		kb.row();
		// Bot-supplied bottom rows (e.g. group-scoped controls) sit below Privacy & data.
		for (const item of sorted) if (item.rootExtra) addButton(item);
		// Root has no Back — Close gets its own row.
		kb.text(say({ en: "✖️ Close", es: "✖️ Cerrar" }, lang), closeCb.pack({}));
	} else {
		// Submenus: Back and Close share one row.
		const backPath = parentPath.slice(0, -1).join(".");
		kb.text(
			say({ en: "⬅️ Back", es: "⬅️ Volver" }, lang),
			navCb.pack({ path: backPath || "_root" }),
		);
		kb.text(say({ en: "✖️ Close", es: "✖️ Cerrar" }, lang), closeCb.pack({}));
	}

	return kb;
};

const renderConfirmForget = (lang: string): InlineKeyboard =>
	new InlineKeyboard()
		.text(
			say({ en: "✅ Confirm delete", es: "✅ Confirmar borrado" }, lang),
			forgetConfirmCb.pack({}),
			{ style: "danger" },
		)
		.row()
		.text(
			say({ en: "⬅️ Cancel", es: "⬅️ Cancelar" }, lang),
			forgetCancelCb.pack({}),
		);

const buildMenuPlugin = (menu: BotMenu) => {
	const { command, description, header, personalData, adminContact } =
		menu._opts;
	const privateOnlyText = (lang: string) =>
		say(
			{
				en: "DM me to change settings or manage your data.",
				es: "Escríbeme por privado para cambiar ajustes o gestionar tus datos.",
			},
			lang,
		);
	const isPrivateContext = (ctx: MenuCtx): boolean => {
		const messageChatType = (
			ctx.message as { chat?: { type?: string } } | undefined
		)?.chat?.type;
		return (ctx.chat?.type ?? messageChatType) === "private";
	};
	const guardPrivate = async (ctx: MenuCtx): Promise<boolean> => {
		if (!personalData || menu._opts.allowInGroups || isPrivateContext(ctx))
			return true;
		const lang = ctxLang(ctx);
		if (ctx.answer) {
			await ctx.answer({ text: privateOnlyText(lang), show_alert: true });
		} else if (ctx.send) {
			await ctx.send(privateOnlyText(lang));
		}
		return false;
	};

	return (
		new Plugin("@adriangalilea/utils/bot/menu")
			.command(command, { description }, async (ctx) => {
				if (!(await guardPrivate(ctx))) return;
				const kb = renderKeyboard(menu._items, ctx, []);
				await ctx.send(labelOf(header, ctx), { reply_markup: kb });
			})
			// Navigate (root / submenu)
			.callbackQuery(navCb, async (ctx) => {
				if (!(await guardPrivate(ctx))) return;
				const lang = ctxLang(ctx);
				const raw = ctx.queryData.path;
				// Virtual privacy submenu — rendered separately because its
				// items aren't user-defined `MenuItem`s.
				if (raw === PRIVACY_PATH) {
					await ctx.answer({});
					const kb = renderPrivacySubmenu(menu, ctx);
					try {
						await ctx.editText(labelOf(header, ctx), { reply_markup: kb });
					} catch {
						// message too old to edit
					}
					return;
				}
				const segments = raw === "_root" ? [] : raw.split(".");
				const items = itemsForPath(menu._items, segments);
				if (!items) {
					await ctx.answer({
						text: say({ en: "Menu out of date.", es: "Menú obsoleto." }, lang),
					});
					return;
				}
				await ctx.answer({});
				const kb = renderKeyboard(items, ctx, segments);
				try {
					await ctx.editText(labelOf(header, ctx), { reply_markup: kb });
				} catch {
					// message too old to edit
				}
			})
			// Action items + the forget pre-confirmation
			.callbackQuery(actCb, async (ctx) => {
				if (!(await guardPrivate(ctx))) return;
				const lang = ctxLang(ctx);
				const raw = ctx.queryData.path;
				if (raw === "_forget") {
					await ctx.answer({});
					try {
						await ctx.editText(
							say(
								{
									en:
										"⚠️ Delete all your data?\n\n" +
										"This removes the session record we keep about you " +
										"(preferences, history, access state). Not reversible.",
									es:
										"⚠️ ¿Borrar todos tus datos?\n\n" +
										"Esto elimina el registro de sesión que guardamos sobre ti " +
										"(preferencias, historial, estado de acceso). No se puede deshacer.",
								},
								lang,
							),
							{ reply_markup: renderConfirmForget(lang) },
						);
					} catch {
						// message too old to edit
					}
					return;
				}
				const segments = raw.split(".");
				const item = itemForPath(menu._items, segments);
				if (!item || !("action" in item)) {
					await ctx.answer({
						text: say(
							{ en: "Item not found.", es: "Elemento no encontrado." },
							lang,
						),
					});
					return;
				}

				// If the item declares a `confirm` step, this first tap renders
				// the confirmation overlay in place instead of running the
				// action. The real action runs on actConfirmCb (Confirm tap).
				if (item.confirm) {
					await ctx.answer({});
					const promptText = labelOf(item.confirm.prompt, ctx);
					const confirmLabel = item.confirm.confirmLabel
						? labelOf(item.confirm.confirmLabel, ctx)
						: say({ en: "✅ Confirm", es: "✅ Confirmar" }, lang);
					const cancelLabel = item.confirm.cancelLabel
						? labelOf(item.confirm.cancelLabel, ctx)
						: say({ en: "⬅️ Cancel", es: "⬅️ Cancelar" }, lang);
					try {
						await ctx.editText(promptText, {
							reply_markup: new InlineKeyboard()
								.text(confirmLabel, actConfirmCb.pack({ path: raw }), {
									style: "danger",
								})
								.row()
								.text(cancelLabel, navCb.pack({ path: "_root" })),
						});
					} catch {
						// message too old to edit
					}
					return;
				}

				// Run the action, capture its toast (if any). The menu owns the
				// single `answerCallbackQuery` call for this query — actions
				// return strings / polyglots instead of calling answer
				// themselves, so we never double-answer (Telegram rejects that
				// and would block `refresh: true` from running).
				let toast: ActionResult;
				try {
					toast = await item.action(ctx);
				} catch (e) {
					// Clear the spinner so the user isn't left hanging, then
					// re-throw so gramio's error handler / our `onError` paths see
					// the failure.
					try {
						await ctx.answer({});
					} catch {
						// query already closed by Telegram
					}
					throw e;
				}

				const text =
					typeof toast === "string"
						? toast
						: toast === undefined
							? undefined
							: say(toast, lang);
				await ctx.answer(text === undefined ? {} : { text });

				// If the action wants the menu to reflect mutated state (toggles,
				// mutually-exclusive selections, …), re-render the parent path
				// in place so dynamic `label` / `style` resolvers update without
				// the user having to re-open the menu.
				if (item.refresh) {
					const parentPath = segments.slice(0, -1);
					const items = itemsForPath(menu._items, parentPath);
					if (items) {
						const kb = renderKeyboard(items, ctx, parentPath);
						try {
							await ctx.editText(labelOf(header, ctx), { reply_markup: kb });
						} catch {
							// message too old to edit
						}
					}
				}
			})
			// Confirmed tap on a `confirm:`-flagged action item: run the
			// action with the same return-value contract as actCb, then
			// navigate back to root so the user lands in a meaningful state.
			.callbackQuery(actConfirmCb, async (ctx) => {
				if (!(await guardPrivate(ctx))) return;
				const lang = ctxLang(ctx);
				const raw = ctx.queryData.path;
				const segments = raw.split(".");
				const item = itemForPath(menu._items, segments);
				if (!item || !("action" in item)) {
					await ctx.answer({
						text: say(
							{ en: "Item not found.", es: "Elemento no encontrado." },
							lang,
						),
					});
					return;
				}

				let toast: ActionResult;
				try {
					toast = await item.action(ctx);
				} catch (e) {
					try {
						await ctx.answer({});
					} catch {
						// query already closed by Telegram
					}
					throw e;
				}

				const text =
					typeof toast === "string"
						? toast
						: toast === undefined
							? undefined
							: say(toast, lang);
				await ctx.answer(text === undefined ? {} : { text });

				// Always navigate back to root after a confirmed destructive
				// action — the previous context (where the user tapped) might
				// not make sense anymore.
				const kb = renderKeyboard(menu._items, ctx, []);
				try {
					await ctx.editText(labelOf(header, ctx), { reply_markup: kb });
				} catch {
					// message too old to edit
				}
			})
			// Forget — confirm path
			.callbackQuery(forgetConfirmCb, async (ctx) => {
				if (!(await guardPrivate(ctx))) return;
				const lang = ctxLang(ctx);
				if (!personalData) {
					await ctx.answer({
						text: say({ en: "Not configured.", es: "No configurado." }, lang),
						show_alert: true,
					});
					return;
				}
				const userId = ctx.from?.id;
				if (userId === undefined)
					return ctx.answer({
						text: say({ en: "No user.", es: "Sin usuario." }, lang),
					});

				try {
					await personalData.storage.delete(botStorageKey(ctx, userId));
					await ctx.answer({
						text: say({ en: "Deleted.", es: "Borrado." }, lang),
					});
					try {
						await ctx.editText(
							say(
								{
									en: "✅ Your data has been deleted.",
									es: "✅ Tus datos han sido borrados.",
								},
								lang,
							),
						);
					} catch {
						// message too old to edit
					}
				} catch (e) {
					console.error("[menu] /forget failed", e);
					await ctx.answer({
						text: say({ en: "Failed.", es: "Falló." }, lang),
					});
					await ctx.send(
						say(
							{
								en: `❌ Could not delete your data.\n\nPlease contact ${adminContact}.`,
								es: `❌ No se han podido borrar tus datos.\n\nContacta con ${adminContact}.`,
							},
							lang,
						),
					);
				}
			})
			.callbackQuery(forgetCancelCb, async (ctx) => {
				if (!(await guardPrivate(ctx))) return;
				await ctx.answer({});
				// Cancel lands back on the privacy submenu (where the user
				// came from), not root — saves the re-navigation tap.
				const kb = renderPrivacySubmenu(menu, ctx);
				try {
					await ctx.editText(labelOf(header, ctx), { reply_markup: kb });
				} catch {
					// message too old to edit
				}
			})
			// Export — JSON file with the user's whole session record
			.callbackQuery(exportCb, async (ctx) => {
				if (!(await guardPrivate(ctx))) return;
				const lang = ctxLang(ctx);
				if (!personalData) {
					await ctx.answer({
						text: say({ en: "Not configured.", es: "No configurado." }, lang),
						show_alert: true,
					});
					return;
				}
				const userId = ctx.from?.id;
				if (userId === undefined)
					return ctx.answer({
						text: say({ en: "No user.", es: "Sin usuario." }, lang),
					});

				const record =
					(await personalData.storage.get(botStorageKey(ctx, userId))) ?? {};
				const file = new File(
					[
						JSON.stringify(
							{ userId, exportedAt: Date.now(), data: record },
							null,
							2,
						),
					],
					`my-data-${userId}-${Date.now()}.json`,
					{ type: "application/json" },
				);

				await ctx.answer({});
				try {
					await ctx.sendDocument(file, {
						caption: say(
							{ en: "📥 Your data export", es: "📥 Exportación de tus datos" },
							lang,
						),
					});
				} catch (e) {
					console.error("[menu] /export sendDocument failed", e);
					await ctx.send(
						say(
							{
								en: `❌ Could not send your data export.\n\nPlease contact ${adminContact}.`,
								es: `❌ No se ha podido enviar la exportación de tus datos.\n\nContacta con ${adminContact}.`,
							},
							lang,
						),
					);
				}
			})
			// Close — dismiss the settings message entirely.
			.callbackQuery(closeCb, async (ctx) => {
				if (!(await guardPrivate(ctx))) return;
				await ctx.answer({});
				try {
					await ctx.message?.delete();
				} catch {
					/* message too old to delete */
				}
			})
	);
};
