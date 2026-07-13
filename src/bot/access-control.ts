/**
 * Access control for personal GramIO bots — a one-stop guard +
 * approve/deny + revocable allow-list with an inline admin menu.
 *
 * **Native alternative** (BotFather → Bot Settings → Access →
 * "Restrict bot usage"). Toggling that ON makes Telegram itself reject
 * any non-allowlisted user before the update ever reaches your bot.
 * It's the right pick when you want a flat "me + a few hand-picked
 * accounts" allow-list and never need to approve from inside the bot.
 *
 * This plugin is preferable when you want:
 *   - In-bot approval flow (admin gets a DM with `[✅ Approve][❌ Deny]`
 *     buttons when a stranger DMs the bot), not a BotFather round-trip
 *   - Dynamic revoke / re-approve from `/access` without leaving Telegram
 *   - Pending / approved / denied lists visible to the admin
 *   - `ctx.access.source` (`admin` / `default` / `approved`) on every
 *     update for downstream logic
 *
 * Both can coexist: BotFather's native flag is a hard pre-filter, this
 * plugin is the dynamic UX on top of whoever gets through.
 *
 * **Group adds are a second gate** (`gateGroups: true`, off by default —
 * DMs are the plugin's core; rooms are opt-in). Two different questions,
 * gated separately: the DM gate asks "may this USER talk to the bot", the
 * group gate asks "may the bot serve this ROOM". With it on:
 *
 *                bot added to a group / supergroup / channel
 *                       │
 *          added by an admin or a default id?
 *              yes → approved on the spot, silently
 *              no  → PENDING: the bot stays but serves nothing,
 *                    admin gets a DM with `[✅ Approve][🚪 Leave]`
 *                       │
 *              approve → the room works — for EVERY member
 *                        (`ctx.access.source === 'group'`: approving the
 *                        room admits the room; the per-user DM gate does
 *                        not apply inside it)
 *              leave   → the bot leaves AND remembers: re-added while
 *                        denied, it leaves again on sight (throttled DM)
 *
 * A group the bot already sits in when the gate turns on has no record;
 * its first activity seeds a pending request (throttled DM) — existing
 * rooms surface for review instead of going silently mute forever. The
 * `/access` menu grows a `👥 Groups` view (approve / leave / re-allow).
 * Removal from a group clears its record (a fresh add re-asks) UNLESS it
 * was denied — deny memory survives, that's the anti-re-add-spam. Cost:
 * one storage read per gated group update. Known edge: a group→supergroup
 * migration changes the chat id, so the room re-asks under its new id.
 *
 *                stranger DMs your bot
 *                       │
 *                       ▼
 *      ┌──── plugin gate (this file) ────────────────────┐
 *      │  ctx.from.id  ∈  admin / defaults / approved?   │
 *      │     yes → next()                                │
 *      │     no  → drop + notify admin (rate-limited)    │
 *      └─────────────────────────────────────────────────┘
 *                       │
 *           admin gets DM with [✅ Approve] [❌ Deny]
 *                       │
 *                  admin taps
 *                       │
 *      stranger's session updated  ·  stranger gets DM
 *
 * **Storage layout.** This plugin stores its per-user record under
 * the `access` field of the shared session record (see
 * `bot/CLAUDE.md` § "Shared session, one record per user"). All
 * per-user state across our plugins coexists in the same record:
 *
 *     storage[String(userId)] = {
 *       access:   { status, approvedAt, … },   // ← this plugin
 *       language: 'es',                         // ← bot/language
 *       llm:      { shards: { 'general': [...] } },  // ← bot/llm (history)
 *     }
 *
 * Plus one tiny admin-side index so `/access` can list pending /
 * approved / denied without scanning every user:
 *
 *     storage['ac:index'] = { pending: [...ids], approved: [...], denied: [...] }
 *
 * **Cross-user mutations.** When the admin taps `[✅ Approve]` on
 * Pepe's notification, `ctx` is the admin's, so `ctx.session` is the
 * admin's record — useless for mutating Pepe. We reach for Pepe's
 * record directly via `storage.get(String(pepeId))`, preserve other
 * plugins' fields in it (read-modify-write), and put it back.
 *
 * **i18n.** Every user-facing string is an inline `{ en, es }`
 * polyglot literal resolved via `say(value, lang)` at the call site
 * — no message bundle, no override registry. The recipient's stored
 * `language` field (set by `bot/language`) picks the variant; falls
 * back to `'en'`. Want a different default? Set `language` on the
 * relevant session record before this plugin fires.
 *
 * **Composes with**:
 *   - `adminContext` (kit.ts) — required, gives us `ctx.adminId` /
 *     `ctx.isAdmin`. Declared as a runtime dependency.
 *   - `@gramio/session` — the user creates ONE session at bot level
 *     and passes it to this plugin (and the other session-using
 *     ones). gramio's runtime dedup ensures the session derive runs
 *     exactly once per update.
 *
 * Peer deps: `gramio`, `@gramio/session`, `@gramio/storage`.
 *
 * @example
 * import { Bot } from 'gramio'
 * import { session } from '@gramio/session'
 * import { redisStorage } from '@gramio/storage-redis'
 * import { adminContext, gracefulStart } from '@adriangalilea/utils/bot/kit'
 * import { accessControl } from '@adriangalilea/utils/bot/access-control'
 *
 * const storage = redisStorage()
 * const userSession = session({ storage, key: 'session', initial: () => ({}) })
 *
 * const bot = new Bot(process.env.BOT_TOKEN!)
 *   .extend(adminContext(123456789))
 *   .extend(userSession)
 *   .extend(accessControl({ session: userSession, storage, defaults: [1158734055] }))
 *   .command('start', (ctx) => ctx.send(`source=${ctx.access.source ?? 'denied'}`))
 *
 * await gracefulStart(bot)
 */

import type { session } from "@gramio/session";
import type { Storage } from "@gramio/storage";
import {
	type AnyBot,
	CallbackData,
	type DeriveDefinitions,
	InlineKeyboard,
	Plugin,
} from "gramio";

import { say } from "../say/index.js";
import { botStorageKey, botSubKey } from "./keys.js";

const FIRST_MSG_LIMIT = 200;
const DEFAULT_THROTTLE_MS = 6 * 60 * 60 * 1000;
const FALLBACK_LANG = "en";

// Storage keys are computed via `botStorageKey(ctx, userId)` and
// `botSubKey(ctx, 'ac:index')` — both prefix with the calling bot's
// numeric id (parsed from `ctx.bot.info.id`) so multiple bots sharing
// one Redis stay isolated by construction. See `kit.ts` for the why.

type BotCtx = { bot: unknown };

// ─── public types ──────────────────────────────────────────────────

export type AccessStatus = "unknown" | "pending" | "approved" | "denied";

export type AccessUser = {
	id: number;
	firstName?: string;
	lastName?: string;
	username?: string;
};

/**
 * What this plugin persists under `ctx.session.access` per user. When
 * `ctx.session.access` is `undefined`, the user has never interacted
 * (or has been wiped via /forget). The plugin treats that as
 * status='unknown' for gating purposes.
 */
export type AccessRecord = {
	status: AccessStatus;
	user?: AccessUser;
	/** Chat to DM the user back. For private chats this equals user.id. */
	chatId?: number;
	requestedAt?: number;
	approvedAt?: number;
	approvedBy?: number;
	deniedAt?: number;
	deniedBy?: number;
	/** First message text from the request (truncated). */
	firstMessage?: string;
	lastActivityAt?: number;
	messageCount?: number;
	/** Counts attempts after the initial request — used by the throttle. */
	rejectedAttempts?: number;
	lastNotifiedAt?: number;
};

export type AccessIndex = {
	pending: number[];
	approved: number[];
	denied: number[];
};

export type GroupAccessStatus = "pending" | "approved" | "denied";

/**
 * What the group gate persists per room, under the chat id's storage row
 * (`groupAccess` field — chat ids are negative, so rooms and users share
 * the `bot-<id>:<n>` keyspace without collision).
 */
export type GroupAccessRecord = {
	status: GroupAccessStatus;
	chat: { id: number; title?: string; type: string };
	/** Who added the bot (or whose message surfaced an ungated room). */
	addedBy?: AccessUser;
	requestedAt?: number;
	approvedAt?: number;
	approvedBy?: number;
	deniedAt?: number;
	deniedBy?: number;
	lastNotifiedAt?: number;
};

export type AccessSource = "admin" | "default" | "store" | "group";

/**
 * What handlers downstream see on `ctx.access`. A discriminated union —
 * use the `allowed` field to narrow.
 *
 * **Snapshot semantics.** `ctx.access` is computed by this plugin's
 * derive at event start and stays static through the handler — same
 * pattern as `ctx.lang` from `bot/language`. If you mutate the user's
 * access state mid-handler (rare — usually the admin's tap mutates
 * the *target's* session record, not their own), re-read from
 * storage / `ctx.session.access` directly rather than from
 * `ctx.access`.
 */
export type AccessInfo =
	| {
			allowed: true;
			source: AccessSource;
			/** The persisted record, when source is 'store'. */
			record?: AccessRecord;
	  }
	| {
			allowed: false;
			reason: "denied" | "pending" | "unknown" | "no-sender";
	  };

/**
 * Loose session shape — this plugin writes `access`; it READS `language`
 * to localize messages it sends to the subject. Both are optional.
 */
type SessionLike = { access?: AccessRecord; language?: string };

/** @internal — kept unexported so it doesn't clash with peers' refs. */
type AcSessionPluginRef = ReturnType<typeof session<SessionLike, "session">>;

export type AccessControlOptions = {
	/**
	 * Shared session plugin. This plugin extends it for type flow;
	 * gramio's runtime dedup ensures it only runs once per update.
	 * `ctx.session.access` is where the per-user access record lives.
	 */
	session: AcSessionPluginRef;
	/**
	 * Storage backend for cross-user mutations (admin approves Pepe →
	 * write to Pepe's session record from admin's ctx). Must be the
	 * same storage instance passed to `session()`.
	 */
	storage: Storage;
	/** Always-allowed user ids, hardcoded. Bypass the entire flow. */
	defaults?: ReadonlyArray<number>;
	/** Pass `false` to silence the first-attempt reply to denied users. */
	silentDeny?: boolean;
	/** Min ms between repeat admin notifications for the same user. Default 6h. */
	notifyThrottleMs?: number;
	/**
	 * Gate group / supergroup / channel adds too (see the header). Off by
	 * default: DM gating is the plugin's core, rooms are opt-in.
	 */
	gateGroups?: boolean;
	/** Callbacks for your own logging / metrics. */
	onAccessRequest?: (info: { user: AccessUser; firstMessage?: string }) => void;
	onApprove?: (info: { userId: number; approvedBy: number }) => void;
	onDeny?: (info: { userId: number; deniedBy: number }) => void;
	/** Group-gate callbacks — e.g. send your welcome card on approve, not on add. */
	onGroupRequest?: (info: {
		chat: GroupAccessRecord["chat"];
		addedBy?: AccessUser;
	}) => void;
	onGroupApprove?: (info: { chatId: number; approvedBy: number }) => void;
	onGroupDeny?: (info: { chatId: number; deniedBy: number }) => void;
};

// ─── derived context shapes ────────────────────────────────────────

type AdminDerives = { adminId: number; isAdmin: boolean };
type AccessDerives = { access: AccessInfo };
// Session's derives are per-event (message, callback_query, …) per
// `@gramio/session`. We declare it globally here because every
// handler in this plugin runs on those events (commands, callbacks).
// gramio's runtime guarantees the session is loaded before our
// derive/handlers fire on those events.
type SessionDerives = {
	session: SessionLike & { $clear: () => Promise<void> };
};

type AcDerives = DeriveDefinitions & {
	global: AdminDerives & AccessDerives & SessionDerives;
};

// ─── callback schemas ──────────────────────────────────────────────
//
// Short `nameId`s keep callback_data under Telegram's 64-byte cap.
// `v` (optional) carries the originating list view ('pending' | 'denied'
// | 'approved'). When present, the handler refreshes that list after
// the action; absent = original notification, edits the message inline.
const acApprove = new CallbackData("acA")
	.number("uid")
	.string("v", { optional: true });
const acDeny = new CallbackData("acD")
	.number("uid")
	.string("v", { optional: true });
const acRevoke = new CallbackData("acR").number("uid");
const acView = new CallbackData("acV").string("v"); // main | approved | pending | denied | groups
const acClose = new CallbackData("acC");
// Group gate: `v` marks a tap from the groups list view (refresh it after);
// absent = the original add notification (edit it inline).
const acGroupApprove = new CallbackData("acGA")
	.number("gid")
	.string("v", { optional: true });
const acGroupLeave = new CallbackData("acGL")
	.number("gid")
	.string("v", { optional: true });

// ─── small helpers ─────────────────────────────────────────────────

const formatUser = (u: AccessUser | undefined, fallbackId: number): string => {
	if (!u) return `id ${fallbackId}`;
	const name =
		[u.firstName, u.lastName].filter(Boolean).join(" ") || `id ${u.id}`;
	const handle = u.username ? `@${u.username}` : `id ${u.id}`;
	return `${name} (${handle})`;
};

const fmtAge = (ms: number): string => {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}min`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
};

const requestNotificationText = (
	uid: number,
	r: AccessRecord,
	repeat: boolean,
	lang: string,
): string => {
	const parts = [
		say(
			repeat
				? { en: "🔁 Access re-requested", es: "🔁 Acceso re-solicitado" }
				: { en: "🔔 Access requested", es: "🔔 Acceso solicitado" },
			lang,
		),
		"",
		`👤 ${formatUser(r.user, uid)}`,
		`🆔 ${uid}`,
		`⏰ ${say({ en: "ago", es: "hace" }, lang)} ${fmtAge(Date.now() - (r.requestedAt ?? Date.now()))}`,
	];
	if (repeat) {
		parts.push(
			`🔁 ${say({ en: "attempts", es: "intentos" }, lang)}: ${(r.rejectedAttempts ?? 0) + 1}`,
		);
	}
	if (r.firstMessage) parts.push("", `💬 "${r.firstMessage}"`);
	return parts.join("\n");
};

const requestKeyboard = (uid: number, lang: string) =>
	new InlineKeyboard()
		.text(
			say({ en: "✅ Approve", es: "✅ Aprobar" }, lang),
			acApprove.pack({ uid }),
			{ style: "success" },
		)
		.text(
			say({ en: "❌ Deny", es: "❌ Denegar" }, lang),
			acDeny.pack({ uid }),
			{ style: "danger" },
		);

// ─── index helpers ─────────────────────────────────────────────────
//
// The same {pending, approved, denied} index shape serves both gates,
// under two keys: 'ac:index' holds user ids, 'ac:groups' holds chat ids.

const indexKey = (ctx: BotCtx): string => botSubKey(ctx, "ac:index");
const groupIndexKey = (ctx: BotCtx): string => botSubKey(ctx, "ac:groups");

const loadIndex = async (
	storage: Storage,
	key: string,
): Promise<AccessIndex> => {
	const raw = (await storage.get(key)) as Partial<AccessIndex> | undefined;
	return {
		pending: raw?.pending ?? [],
		approved: raw?.approved ?? [],
		denied: raw?.denied ?? [],
	};
};

const saveIndex = (storage: Storage, key: string, idx: AccessIndex) =>
	storage.set(key, idx);

const indexAdd = async (
	storage: Storage,
	key: string,
	bucket: keyof AccessIndex,
	uid: number,
): Promise<void> => {
	const idx = await loadIndex(storage, key);
	if (!idx[bucket].includes(uid)) idx[bucket].push(uid);
	await saveIndex(storage, key, idx);
};

const indexMove = async (
	storage: Storage,
	key: string,
	uid: number,
	from: keyof AccessIndex | "any",
	to: keyof AccessIndex,
): Promise<void> => {
	const idx = await loadIndex(storage, key);
	const remove = (list: number[]) => {
		const i = list.indexOf(uid);
		if (i >= 0) list.splice(i, 1);
	};
	if (from === "any") {
		remove(idx.pending);
		remove(idx.approved);
		remove(idx.denied);
	} else {
		remove(idx[from]);
	}
	if (!idx[to].includes(uid)) idx[to].push(uid);
	await saveIndex(storage, key, idx);
};

const indexRemove = async (
	storage: Storage,
	key: string,
	uid: number,
): Promise<void> => {
	const idx = await loadIndex(storage, key);
	for (const list of [idx.pending, idx.approved, idx.denied]) {
		const i = list.indexOf(uid);
		if (i >= 0) list.splice(i, 1);
	}
	await saveIndex(storage, key, idx);
};

// ─── per-user record helpers (cross-user storage access) ───────────
//
// When admin approves a stranger, we mutate the stranger's session
// record from the admin's ctx. We can't access the stranger's session
// via gramio's session plugin (it's per-ctx), so we hit `storage`
// directly using the same key format `@gramio/session` uses
// (`String(userId)`). We preserve OTHER plugins' fields in the same
// record via read-modify-write.

type FullSessionRecord = {
	access?: AccessRecord;
	language?: string;
} & Record<string, unknown>;

const loadFullRecord = async (
	storage: Storage,
	ctx: BotCtx,
	userId: number,
): Promise<FullSessionRecord> =>
	((await storage.get(botStorageKey(ctx, userId))) as
		| FullSessionRecord
		| undefined) ?? {};

const saveAccess = async (
	storage: Storage,
	ctx: BotCtx,
	userId: number,
	rec: AccessRecord,
): Promise<void> => {
	const full = await loadFullRecord(storage, ctx, userId);
	full.access = rec;
	await storage.set(botStorageKey(ctx, userId), full);
};

const loadAccess = async (
	storage: Storage,
	ctx: BotCtx,
	userId: number,
): Promise<AccessRecord | undefined> => {
	const full = await loadFullRecord(storage, ctx, userId);
	return full.access;
};

/** Read recipient's stored language (set by bot/language); fallback to en. */
const langOfUser = async (
	storage: Storage,
	ctx: BotCtx,
	userId: number,
): Promise<string> => {
	const full = await loadFullRecord(storage, ctx, userId);
	return full.language ?? FALLBACK_LANG;
};

/** Read current ctx's lang. */
const ctxLang = (ctx: { session: SessionLike }): string =>
	ctx.session.language ?? FALLBACK_LANG;

// ─── callback guard helpers ────────────────────────────────────────

type AdminAnswerCtx = {
	isAdmin: boolean;
	session: SessionLike;
	answer: (params: { text: string; show_alert?: boolean }) => Promise<unknown>;
};

// Resolve the caller's lang for admins; for non-admins send the standard
// rejection alert and return null so the caller bails. Shares one check
// across the five admin callback handlers.
const adminGuard = async (ctx: AdminAnswerCtx): Promise<string | null> => {
	const aLang = ctxLang(ctx);
	if (!ctx.isAdmin) {
		await ctx.answer({
			text: say({ en: "Admin only.", es: "Solo admin." }, aLang),
			show_alert: true,
		});
		return null;
	}
	return aLang;
};

// Read the target uid and load its record; send the "Not found." answer
// and return null when absent. Shared by the three mutating handlers.
const loadOrNotFound = async (
	storage: Storage,
	ctx: BotCtx & {
		queryData: { uid: number };
		answer: (params: { text: string }) => Promise<unknown>;
	},
	aLang: string,
): Promise<AccessRecord | null> => {
	const uid = ctx.queryData.uid;
	const rec = await loadAccess(storage, ctx, uid);
	if (!rec) {
		await ctx.answer({
			text: say({ en: "Not found.", es: "No encontrado." }, aLang),
		});
		return null;
	}
	return rec;
};

// ─── group-gate helpers ────────────────────────────────────────────
//
// A room's record lives under its chat id's storage row (negative ids —
// no collision with user rows), in a `groupAccess` field so any future
// per-chat plugin state can share the row, same read-modify-write deal
// as the user records above.

type GroupRow = { groupAccess?: GroupAccessRecord } & Record<string, unknown>;

const loadGroup = async (
	storage: Storage,
	ctx: BotCtx,
	chatId: number,
): Promise<GroupAccessRecord | undefined> =>
	((await storage.get(botStorageKey(ctx, chatId))) as GroupRow | undefined)
		?.groupAccess;

const saveGroup = async (
	storage: Storage,
	ctx: BotCtx,
	chatId: number,
	rec: GroupAccessRecord,
): Promise<void> => {
	const full =
		((await storage.get(botStorageKey(ctx, chatId))) as GroupRow | undefined) ??
		{};
	full.groupAccess = rec;
	await storage.set(botStorageKey(ctx, chatId), full);
};

const dropGroup = async (
	storage: Storage,
	ctx: BotCtx,
	chatId: number,
): Promise<void> => {
	const full = (await storage.get(botStorageKey(ctx, chatId))) as
		| GroupRow
		| undefined;
	if (!full) return;
	delete full.groupAccess;
	if (Object.keys(full).length === 0) {
		await storage.delete(botStorageKey(ctx, chatId));
	} else {
		await storage.set(botStorageKey(ctx, chatId), full);
	}
};

/** A room's display line: title when known, always the id. */
const formatGroup = (rec: GroupAccessRecord | undefined, id: number): string =>
	rec?.chat.title ? `“${rec.chat.title}” (${id})` : `chat ${id}`;

const groupRequestText = (rec: GroupAccessRecord, lang: string): string => {
	const parts = [
		say(
			{ en: "👥 Group access requested", es: "👥 Acceso de grupo solicitado" },
			lang,
		),
		"",
		`💬 ${formatGroup(rec, rec.chat.id)}`,
	];
	if (rec.addedBy) parts.push(`👤 ${formatUser(rec.addedBy, rec.addedBy.id)}`);
	parts.push(
		`⏰ ${say({ en: "ago", es: "hace" }, lang)} ${fmtAge(Date.now() - (rec.requestedAt ?? Date.now()))}`,
	);
	return parts.join("\n");
};

const groupRequestKeyboard = (chatId: number, lang: string) =>
	new InlineKeyboard()
		.text(
			say({ en: "✅ Approve", es: "✅ Aprobar" }, lang),
			acGroupApprove.pack({ gid: chatId }),
			{ style: "success" },
		)
		.text(
			say({ en: "🚪 Leave", es: "🚪 Salir" }, lang),
			acGroupLeave.pack({ gid: chatId }),
			{ style: "danger" },
		);

/** The chat shape the gate reads off a ctx — group/supergroup/channel only. */
const gatedChatOf = (ctx: {
	chat?: { id?: number; type?: string; title?: string };
}): { id: number; type: string; title?: string } | null => {
	const chat = ctx.chat;
	if (
		chat?.id === undefined ||
		chat.type === undefined ||
		chat.type === "private"
	)
		return null;
	return { id: chat.id, type: chat.type, title: chat.title };
};

/** The two api verbs the group gate uses, read structurally off any ctx
 *  (`BotLike` omits the concrete api surface; at runtime ctx.bot IS the Bot). */
const botApi = (ctx: BotCtx) =>
	(
		ctx.bot as {
			api: {
				sendMessage: (p: {
					chat_id: number;
					text: string;
					reply_markup?: InlineKeyboard;
				}) => Promise<unknown>;
				leaveChat: (p: { chat_id: number }) => Promise<unknown>;
			};
		}
	).api;

// ─── plugin ────────────────────────────────────────────────────────

export const accessControl = (opts: AccessControlOptions) => {
	const { session: sessionPlugin, storage } = opts;
	const defaults = new Set(opts.defaults ?? []);
	const silentDeny = opts.silentDeny === true;
	const throttleMs = opts.notifyThrottleMs ?? DEFAULT_THROTTLE_MS;
	const gateGroups = opts.gateGroups === true;

	// Seed (or re-notify) a room's pending request and DM the primary admin,
	// throttled per record. Called from the add event AND from an unknown
	// room's first activity (the gate-turned-on-later migration path).
	const requestGroupAccess = async (
		ctx: BotCtx & { adminId: number },
		chat: GroupAccessRecord["chat"],
		addedBy: AccessUser | undefined,
	): Promise<void> => {
		const existing = await loadGroup(storage, ctx, chat.id);
		// Approved never re-asks; denied drops silently here — the add event
		// owns the leave-on-sight response for denied rooms.
		if (existing?.status === "approved" || existing?.status === "denied")
			return;
		const now = Date.now();
		const isFirst = existing === undefined;
		// Refresh the title on every touch (rooms get renamed).
		const rec: GroupAccessRecord = existing
			? { ...existing, chat }
			: { status: "pending", chat, addedBy, requestedAt: now };
		if (isFirst)
			await indexAdd(storage, groupIndexKey(ctx), "pending", chat.id);
		if (isFirst || now - (rec.lastNotifiedAt ?? 0) > throttleMs) {
			rec.lastNotifiedAt = now;
			try {
				const adminLang = await langOfUser(storage, ctx, ctx.adminId);
				await botApi(ctx).sendMessage({
					chat_id: ctx.adminId,
					text: groupRequestText(rec, adminLang),
					reply_markup: groupRequestKeyboard(chat.id, adminLang),
				});
			} catch (e) {
				console.error(
					"[access-control] failed to notify admin of a group request",
					e,
				);
			}
			if (isFirst) opts.onGroupRequest?.({ chat, addedBy });
		}
		await saveGroup(storage, ctx, chat.id, rec);
	};

	const plugin =
		// Generic declares dependency on adminContext's derives so
		// ctx.adminId / ctx.isAdmin are typed inside our handlers.
		// Session-side types flow through `.extend(opts.session)` below
		// and TypeScript merges them with our generic via the chain.
		new Plugin<Record<string, never>, AcDerives>(
			"@adriangalilea/utils/bot/access-control",
			{
				dependencies: ["@adriangalilea/utils/bot/admin"],
			},
		)
			// Declare the shared session as a dependency. gramio's runtime
			// dedups against the bot's top-level extension; types flow.
			.extend(sessionPlugin)
			// Compute the gate decision so handlers can read `ctx.access` ergonomically.
			.derive(async (ctx) => {
				const isUserEvent = ctx.is("message") || ctx.is("callback_query");
				// channel_post joins the gated set only under the group gate — a
				// channel has no sender to user-gate, but its ROOM is gateable.
				if (!isUserEvent && !(gateGroups && ctx.is("channel_post"))) {
					return {
						access: {
							allowed: false,
							reason: "no-sender",
						} satisfies AccessInfo,
					};
				}

				// ANY admin passes (ctx.isAdmin is the multi-admin gate; ctx.adminId is only the
				// primary approve/deny target). A secondary admin must not fall through to the
				// pending-request path just because they aren't the primary — and an admin is
				// never muted, not even inside a pending room.
				if (ctx.isAdmin) {
					return {
						access: { allowed: true, source: "admin" } satisfies AccessInfo,
					};
				}
				// Defaults "bypass the entire flow" — the room gate included.
				if (isUserEvent && defaults.has(ctx.from.id)) {
					return {
						access: { allowed: true, source: "default" } satisfies AccessInfo,
					};
				}

				// Group gate: in a gated bot, the ROOM's approval decides for group
				// chats — approving the room admits the room, every member of it.
				if (gateGroups) {
					const chat = gatedChatOf(
						ctx as { chat?: { id?: number; type?: string; title?: string } },
					);
					if (chat) {
						const rec = await loadGroup(storage, ctx, chat.id);
						if (rec?.status === "approved") {
							return {
								access: { allowed: true, source: "group" } satisfies AccessInfo,
							};
						}
						return {
							access: {
								allowed: false,
								reason: rec?.status === "pending" ? "pending" : "unknown",
							} satisfies AccessInfo,
						};
					}
				}
				if (!isUserEvent) {
					// channel_post outside an approved room (unreachable when the
					// room was approved above).
					return {
						access: {
							allowed: false,
							reason: "no-sender",
						} satisfies AccessInfo,
					};
				}
				// ctx.session.access may be undefined for first-ever interaction
				// (session.initial() returns {} so .access isn't set yet).
				const rec =
					ctx.session.access ?? ({ status: "unknown" } satisfies AccessRecord);
				if (rec.status === "approved") {
					return {
						access: {
							allowed: true,
							source: "store",
							record: rec,
						} satisfies AccessInfo,
					};
				}
				return {
					access: { allowed: false, reason: rec.status } satisfies AccessInfo,
				};
			})
			// Gate. Authorized passes through; unauthorized triggers admin notify
			// and silent stranger reply, then drops.
			//
			// IMPORTANT: only `message` and `callback_query` are user-initiated
			// events we can meaningfully gate. Telegram-originated protocol
			// events (`pre_checkout_query`, `shipping_query`, `chat_member`,
			// `successful_payment` riders, …) MUST pass through unconditionally
			// — those aren't users interacting with the bot, they're the
			// platform talking to us, and dropping them silently breaks
			// downstream plugins (payments, business connection handlers, etc.)
			// with no visible error on our side and a generic "An error
			// occurred" on Telegram's side after their 10 s timeout.
			.use(async (ctx, next) => {
				const gatedPost = gateGroups && ctx.is("channel_post");
				if (!ctx.is("message") && !ctx.is("callback_query") && !gatedPost) {
					return next();
				}
				if (ctx.access.allowed) {
					// Activity bump (only for store-approved users — admins/defaults
					// don't have a session record we want to clutter).
					if (
						ctx.access.source === "store" &&
						ctx.is("message") &&
						ctx.session.access
					) {
						ctx.session.access = {
							...ctx.session.access,
							lastActivityAt: Date.now(),
							messageCount: (ctx.session.access.messageCount ?? 0) + 1,
						};
					}
					return next();
				}

				// Acknowledge unauthorized callback queries so the spinner clears.
				if (ctx.is("callback_query")) {
					await ctx.answer({
						text: say({ en: "No access.", es: "Sin acceso." }, ctxLang(ctx)),
						show_alert: false,
					});
					return;
				}
				// Only message-shaped events have .text/.chat for our notification.
				if (!ctx.is("message") && !gatedPost) return;

				if (ctx.chat?.type !== "private") {
					// Under the group gate an unknown room's first activity seeds a
					// pending request (throttled DM) — this is how rooms the bot
					// already sat in when the gate turned on surface for review
					// (my_chat_member never fires for them).
					if (gateGroups) {
						const chat = gatedChatOf(
							ctx as { chat?: { id?: number; type?: string; title?: string } },
						);
						if (chat) {
							await requestGroupAccess(ctx, chat, undefined);
						}
					}
					// Without it, access stays a private-DM concern: group messages
					// from unapproved users drop silently — seeding a request per
					// posting member would spam the admin.
					return;
				}
				// Only real messages remain (channel posts always took the branch
				// above — a channel is never private); narrow for TS and for safety.
				if (!ctx.is("message")) return;

				const userId = ctx.from.id;
				const existing = ctx.session.access;
				const now = Date.now();
				const isFirstRequest = !existing || existing.status === "unknown";
				// Always refresh user metadata from the current update (names
				// change). Used both to seed a fresh record and to backfill
				// when cloning an older record that might lack it.
				const user: AccessUser = {
					id: userId,
					firstName: ctx.from.firstName,
					lastName: ctx.from.lastName,
					username: ctx.from.username,
				};
				const rec: AccessRecord =
					existing && existing.status !== "unknown"
						? { ...existing, user }
						: {
								status: "pending",
								user,
								chatId: ctx.chat.id,
								requestedAt: now,
								firstMessage: ctx.text?.slice(0, FIRST_MSG_LIMIT),
								messageCount: 0,
								rejectedAttempts: 0,
							};

				if (isFirstRequest) {
					await indexAdd(storage, indexKey(ctx), "pending", userId);
				} else {
					rec.rejectedAttempts = (rec.rejectedAttempts ?? 0) + 1;
				}

				const shouldNotify =
					isFirstRequest || now - (rec.lastNotifiedAt ?? 0) > throttleMs;
				if (shouldNotify) {
					rec.lastNotifiedAt = now;
					try {
						const adminLang = await langOfUser(storage, ctx, ctx.adminId);
						await ctx.bot.api.sendMessage({
							chat_id: ctx.adminId,
							text: requestNotificationText(
								userId,
								rec,
								!isFirstRequest,
								adminLang,
							),
							reply_markup: requestKeyboard(userId, adminLang),
						});
					} catch (e) {
						console.error(
							"[access-control] failed to notify admin (have you /started the bot from your account?)",
							e,
						);
					}
					opts.onAccessRequest?.({
						user,
						firstMessage: rec.firstMessage,
					});
				}

				// Persist the updated record to the user's session.
				ctx.session.access = rec;

				if (!silentDeny && isFirstRequest) {
					try {
						await ctx.send(
							say(
								{
									en: "This bot is private. Your request has been sent to the admin.",
									es: "Este bot es privado. Tu solicitud se ha enviado al admin.",
								},
								ctxLang(ctx),
							),
						);
					} catch {
						// user blocked the bot — irrelevant
					}
				}
				// do NOT call next — drop
			})
			// ─── admin actions ────────────────────────────────────────
			.callbackQuery(acApprove, async (ctx) => {
				const aLang = await adminGuard(ctx);
				if (aLang === null) return;
				const uid = ctx.queryData.uid;
				const rec = await loadOrNotFound(storage, ctx, aLang);
				if (!rec) return;

				const wasDenied = rec.status === "denied";
				const wasPending = rec.status === "pending";
				rec.status = "approved";
				rec.approvedAt = Date.now();
				rec.approvedBy = ctx.adminId;
				rec.deniedAt = undefined;
				rec.deniedBy = undefined;
				await saveAccess(storage, ctx, uid, rec);
				await indexMove(
					storage,
					indexKey(ctx),
					uid,
					wasPending ? "pending" : wasDenied ? "denied" : "any",
					"approved",
				);

				if (rec.chatId !== undefined) {
					try {
						const sLang = await langOfUser(storage, ctx, uid);
						await ctx.bot.api.sendMessage({
							chat_id: rec.chatId,
							text: say(
								wasDenied
									? {
											en: "✅ The admin reconsidered: you have access.",
											es: "✅ El admin reconsideró: ya tienes acceso.",
										}
									: {
											en: "✅ Access granted. You can use the bot now.",
											es: "✅ Acceso concedido. Ya puedes usar el bot.",
										},
								sLang,
							),
						});
					} catch {
						// user blocked / chat gone
					}
				}
				await ctx.answer({
					text: say({ en: "✅ Approved", es: "✅ Aprobado" }, aLang),
				});

				if (ctx.queryData.v) {
					await renderView(
						ctx,
						storage,
						defaults,
						ctx.queryData.v,
						aLang,
						gateGroups,
					);
				} else {
					try {
						await ctx.editText(
							`${say({ en: "✅ Approved", es: "✅ Aprobado" }, aLang)} · ${formatUser(rec.user, uid)}`,
						);
					} catch {
						// not always editable
					}
				}
				opts.onApprove?.({ userId: uid, approvedBy: ctx.adminId });
			})
			.callbackQuery(acDeny, async (ctx) => {
				const aLang = await adminGuard(ctx);
				if (aLang === null) return;
				const uid = ctx.queryData.uid;
				const rec = await loadOrNotFound(storage, ctx, aLang);
				if (!rec) return;

				const wasPending = rec.status === "pending";
				rec.status = "denied";
				rec.deniedAt = Date.now();
				rec.deniedBy = ctx.adminId;
				await saveAccess(storage, ctx, uid, rec);
				await indexMove(
					storage,
					indexKey(ctx),
					uid,
					wasPending ? "pending" : "any",
					"denied",
				);

				if (rec.chatId !== undefined) {
					try {
						const sLang = await langOfUser(storage, ctx, uid);
						await ctx.bot.api.sendMessage({
							chat_id: rec.chatId,
							text: say(
								{ en: "❌ Access denied.", es: "❌ Acceso denegado." },
								sLang,
							),
						});
					} catch {
						// ignore
					}
				}
				await ctx.answer({
					text: say({ en: "❌ Denied", es: "❌ Denegado" }, aLang),
				});

				if (ctx.queryData.v) {
					await renderView(
						ctx,
						storage,
						defaults,
						ctx.queryData.v,
						aLang,
						gateGroups,
					);
				} else {
					try {
						await ctx.editText(
							`${say({ en: "❌ Denied", es: "❌ Denegado" }, aLang)} · ${formatUser(rec.user, uid)}`,
						);
					} catch {
						// ignore
					}
				}
				opts.onDeny?.({ userId: uid, deniedBy: ctx.adminId });
			})
			.callbackQuery(acRevoke, async (ctx) => {
				const aLang = await adminGuard(ctx);
				if (aLang === null) return;
				const uid = ctx.queryData.uid;
				const rec = await loadOrNotFound(storage, ctx, aLang);
				if (!rec) return;

				rec.status = "denied";
				rec.deniedAt = Date.now();
				rec.deniedBy = ctx.adminId;
				await saveAccess(storage, ctx, uid, rec);
				await indexMove(storage, indexKey(ctx), uid, "approved", "denied");

				if (rec.chatId !== undefined) {
					try {
						const sLang = await langOfUser(storage, ctx, uid);
						await ctx.bot.api.sendMessage({
							chat_id: rec.chatId,
							text: say(
								{
									en: "↩️ Your bot access has been revoked.",
									es: "↩️ Tu acceso al bot ha sido revocado.",
								},
								sLang,
							),
						});
					} catch {
						// ignore
					}
				}
				await ctx.answer({
					text: say({ en: "↩️ Revoked", es: "↩️ Revocado" }, aLang),
				});
				await renderView(ctx, storage, defaults, "approved", aLang, gateGroups);
			})
			.callbackQuery(acView, async (ctx) => {
				const aLang = await adminGuard(ctx);
				if (aLang === null) return;
				await ctx.answer({});
				await renderView(
					ctx,
					storage,
					defaults,
					ctx.queryData.v,
					aLang,
					gateGroups,
				);
			})
			.callbackQuery(acClose, async (ctx) => {
				const aLang = await adminGuard(ctx);
				if (aLang === null) return;
				await ctx.answer({});
				try {
					await ctx.message?.delete();
				} catch {
					// ignore
				}
			})
			.command(
				"access",
				{
					// Admin-only; hidden from Telegram's `/` menu so it doesn't
					// tempt other users to type it. Admin still invokes via /access.
					// See https://gramio.dev/triggers/command.html#commandmeta-fields
					//
					// Note: gramio's setMyCommands publishes ONE description per
					// bot, not per language. English form used as the canonical.
					description: "Admin: access control menu",
					hide: true,
				},
				async (ctx) => {
					if (!ctx.isAdmin) return;
					const aLang = ctxLang(ctx);
					const v = mainView(
						await loadIndex(storage, indexKey(ctx)),
						defaults,
						aLang,
						gateGroups ? await loadIndex(storage, groupIndexKey(ctx)) : null,
					);
					await ctx.send(v.text, { reply_markup: v.keyboard });
				},
			);

	// The group gate's handlers register ONLY when it's on, so a DM-only bot
	// never adds my_chat_member to its allowed_updates.
	if (!gateGroups) return plugin;

	return (
		plugin
			// The add event: approve on the spot when an admin/default did the
			// adding; leave on sight when the room was denied; else go pending
			// and ask. Removal clears the record — deny memory survives.
			.on("my_chat_member", async (ctx) => {
				const c = ctx as unknown as {
					chat?: { id?: number; type?: string; title?: string };
					from?: {
						id?: number;
						firstName?: string;
						lastName?: string;
						username?: string;
					};
					oldChatMember?: { status?: string };
					newChatMember?: { status?: string };
					isAdmin: boolean;
					adminId: number;
					bot: unknown;
				};
				const chat = gatedChatOf(c);
				if (!chat) return;
				const inRoom = (s: string | undefined) =>
					s === "member" || s === "administrator" || s === "restricted";
				const wasIn = inRoom(c.oldChatMember?.status);
				const nowIn = inRoom(c.newChatMember?.status);
				const nowOut =
					c.newChatMember?.status === "left" ||
					c.newChatMember?.status === "kicked";
				const rec = await loadGroup(storage, ctx, chat.id);

				if (nowOut) {
					// A fresh add re-asks — but a denied room stays denied.
					if (rec && rec.status !== "denied") {
						await dropGroup(storage, ctx, chat.id);
						await indexRemove(storage, groupIndexKey(ctx), chat.id);
					}
					return;
				}
				if (!nowIn || wasIn) return; // a rights change, not an add

				if (rec?.status === "denied") {
					// Re-added while denied: leave on sight, tell the admin (throttled).
					await botApi(ctx)
						.leaveChat({ chat_id: chat.id })
						.catch(() => {});
					const now = Date.now();
					if (now - (rec.lastNotifiedAt ?? 0) > throttleMs) {
						await saveGroup(storage, ctx, chat.id, {
							...rec,
							chat,
							lastNotifiedAt: now,
						});
						const adminLang = await langOfUser(storage, ctx, c.adminId);
						await botApi(ctx)
							.sendMessage({
								chat_id: c.adminId,
								text: `${say(
									{
										en: "🚪 Re-added to a denied room — left again.",
										es: "🚪 Re-añadido a una sala denegada — salí de nuevo.",
									},
									adminLang,
								)}\n\n💬 ${formatGroup(rec, chat.id)}`,
								reply_markup: new InlineKeyboard().text(
									say({ en: "✅ Allow", es: "✅ Permitir" }, adminLang),
									acGroupApprove.pack({ gid: chat.id }),
									{ style: "success" },
								),
							})
							.catch(() => {});
					}
					return;
				}
				if (rec?.status === "approved") return;

				const addedBy: AccessUser | undefined =
					c.from?.id !== undefined
						? {
								id: c.from.id,
								firstName: c.from.firstName,
								lastName: c.from.lastName,
								username: c.from.username,
							}
						: undefined;
				if (c.isAdmin || (addedBy && defaults.has(addedBy.id))) {
					const now = Date.now();
					await saveGroup(storage, ctx, chat.id, {
						status: "approved",
						chat,
						addedBy,
						requestedAt: now,
						approvedAt: now,
						approvedBy: addedBy?.id,
					});
					await indexMove(
						storage,
						groupIndexKey(ctx),
						chat.id,
						"any",
						"approved",
					);
					opts.onGroupApprove?.({
						chatId: chat.id,
						approvedBy: addedBy?.id ?? 0,
					});
					return;
				}
				await requestGroupAccess(
					ctx as unknown as BotCtx & { adminId: number },
					chat,
					addedBy,
				);
			})
			.callbackQuery(acGroupApprove, async (ctx) => {
				const aLang = await adminGuard(ctx);
				if (aLang === null) return;
				const gid = ctx.queryData.gid;
				const rec = await loadGroup(storage, ctx, gid);
				if (!rec) {
					await ctx.answer({
						text: say({ en: "Not found.", es: "No encontrado." }, aLang),
					});
					return;
				}
				rec.status = "approved";
				rec.approvedAt = Date.now();
				rec.approvedBy = ctx.adminId;
				rec.deniedAt = undefined;
				rec.deniedBy = undefined;
				await saveGroup(storage, ctx, gid, rec);
				await indexMove(storage, groupIndexKey(ctx), gid, "any", "approved");
				await ctx.answer({
					text: say({ en: "✅ Approved", es: "✅ Aprobado" }, aLang),
				});
				if (ctx.queryData.v) {
					await renderView(ctx, storage, defaults, "groups", aLang, gateGroups);
				} else {
					try {
						await ctx.editText(
							`${say({ en: "✅ Approved", es: "✅ Aprobado" }, aLang)} · ${formatGroup(rec, gid)}`,
						);
					} catch {
						// not always editable
					}
				}
				opts.onGroupApprove?.({ chatId: gid, approvedBy: ctx.adminId });
			})
			.callbackQuery(acGroupLeave, async (ctx) => {
				const aLang = await adminGuard(ctx);
				if (aLang === null) return;
				const gid = ctx.queryData.gid;
				const rec = await loadGroup(storage, ctx, gid);
				if (!rec) {
					await ctx.answer({
						text: say({ en: "Not found.", es: "No encontrado." }, aLang),
					});
					return;
				}
				rec.status = "denied";
				rec.deniedAt = Date.now();
				rec.deniedBy = ctx.adminId;
				rec.approvedAt = undefined;
				rec.approvedBy = undefined;
				await saveGroup(storage, ctx, gid, rec);
				await indexMove(storage, groupIndexKey(ctx), gid, "any", "denied");
				await botApi(ctx)
					.leaveChat({ chat_id: gid })
					.catch(() => {});
				await ctx.answer({
					text: say({ en: "🚪 Left", es: "🚪 Fuera" }, aLang),
				});
				if (ctx.queryData.v) {
					await renderView(ctx, storage, defaults, "groups", aLang, gateGroups);
				} else {
					try {
						await ctx.editText(
							`${say({ en: "🚪 Left", es: "🚪 Fuera" }, aLang)} · ${formatGroup(rec, gid)}`,
						);
					} catch {
						// not always editable
					}
				}
				opts.onGroupDeny?.({ chatId: gid, deniedBy: ctx.adminId });
			})
	);
};

// ─── views ─────────────────────────────────────────────────────────

// Status bucket labels, defined once so the summary view and the list
// headers can't drift apart. Resolved via say() at each call site.
const statusLabel = {
	approved: { en: "Approved", es: "Aprobados" },
	pending: { en: "Pending", es: "Pendientes" },
	denied: { en: "Denied", es: "Denegados" },
} as const;

type ViewableCtx = BotCtx & {
	editText: (
		text: string,
		params?: { reply_markup?: InlineKeyboard },
	) => Promise<unknown>;
};

const renderView = async (
	ctx: ViewableCtx,
	storage: Storage,
	defaults: ReadonlySet<number>,
	view: string,
	lang: string,
	gateGroups = false,
): Promise<void> => {
	const idx = await loadIndex(storage, indexKey(ctx));
	const v =
		view === "approved" || view === "pending" || view === "denied"
			? await listView(storage, ctx, idx, view, defaults, lang)
			: view === "groups" && gateGroups
				? await groupsView(storage, ctx, lang)
				: mainView(
						idx,
						defaults,
						lang,
						gateGroups ? await loadIndex(storage, groupIndexKey(ctx)) : null,
					);
	try {
		await ctx.editText(v.text, { reply_markup: v.keyboard });
	} catch {
		// editText only works while message is recent enough; ignore
	}
};

const mainView = (
	idx: AccessIndex,
	defaults: ReadonlySet<number>,
	lang: string,
	groupIdx: AccessIndex | null = null,
) => {
	const approved = say(statusLabel.approved, lang);
	const pending = say(statusLabel.pending, lang);
	const denied = say(statusLabel.denied, lang);

	const lines = [
		say({ en: "🔐 Access Control", es: "🔐 Access Control" }, lang),
		"",
		`✅ ${approved}: ${idx.approved.length}`,
		`⏳ ${pending}: ${idx.pending.length}`,
		`❌ ${denied}: ${idx.denied.length}`,
		`👑 ${say({ en: "Defaults", es: "Defaults" }, lang)}: ${defaults.size} (hardcoded)`,
	];
	if (groupIdx) {
		lines.push(
			`👥 ${say({ en: "Groups", es: "Grupos" }, lang)}: ${groupIdx.approved.length} ✅ · ${groupIdx.pending.length} ⏳ · ${groupIdx.denied.length} 🚪`,
		);
	}
	const text = lines.join("\n");

	const keyboard = new InlineKeyboard()
		.text(
			`✅ ${approved} (${idx.approved.length})`,
			acView.pack({ v: "approved" }),
		)
		.text(
			`⏳ ${pending} (${idx.pending.length})`,
			acView.pack({ v: "pending" }),
		)
		.row()
		.text(`❌ ${denied} (${idx.denied.length})`, acView.pack({ v: "denied" }));
	if (groupIdx) {
		keyboard.text(
			`👥 ${say({ en: "Groups", es: "Grupos" }, lang)} (${groupIdx.approved.length + groupIdx.pending.length})`,
			acView.pack({ v: "groups" }),
		);
	}
	keyboard
		.row()
		.text(
			say({ en: "🔄 Refresh", es: "🔄 Refresh" }, lang),
			acView.pack({ v: "main" }),
		)
		.text(say({ en: "✖️ Close", es: "✖️ Cerrar" }, lang), acClose.pack({}));

	return { text, keyboard };
};

const listView = async (
	storage: Storage,
	ctx: BotCtx,
	idx: AccessIndex,
	filter: "pending" | "approved" | "denied",
	defaults: ReadonlySet<number>,
	lang: string,
) => {
	const ids = idx[filter];
	// Cap at 20 to keep callback_data + rendering sane.
	const shownIds = ids.slice(0, 20);
	const records = await Promise.all(
		shownIds.map(async (id) => ({
			id,
			rec: await loadAccess(storage, ctx, id),
		})),
	);

	const headerEmoji =
		filter === "approved" ? "✅" : filter === "pending" ? "⏳" : "❌";
	const headerLabel = say(statusLabel[filter], lang);

	const back = say({ en: "⬅️ Back", es: "⬅️ Volver" }, lang);

	if (ids.length === 0) {
		const text =
			`${headerEmoji} ${headerLabel} (0)\n\n` +
			say({ en: "(empty)", es: "(vacío)" }, lang);
		const keyboard = new InlineKeyboard().text(
			back,
			acView.pack({ v: "main" }),
		);
		return { text, keyboard };
	}

	const lines: string[] = [`${headerEmoji} ${headerLabel} (${ids.length})`, ""];
	const keyboard = new InlineKeyboard();

	for (let i = 0; i < records.length; i++) {
		const { id, rec } = records[i];
		if (!rec) {
			// index referenced a missing record — show as placeholder
			lines.push(
				`${i + 1}. id ${id} ${say({ en: "(data lost)", es: "(datos perdidos)" }, lang)}`,
			);
			continue;
		}
		const ageRef =
			rec.approvedAt ?? rec.deniedAt ?? rec.requestedAt ?? Date.now();
		lines.push(
			`${i + 1}. ${formatUser(rec.user, id)} · ${say({ en: "ago", es: "hace" }, lang)} ${fmtAge(Date.now() - ageRef)}` +
				(rec.messageCount ? ` · ${rec.messageCount} msgs` : ""),
		);
		if (filter === "pending") {
			keyboard
				.text(`✅ ${i + 1}`, acApprove.pack({ uid: id, v: "pending" }), {
					style: "success",
				})
				.text(`❌ ${i + 1}`, acDeny.pack({ uid: id, v: "pending" }), {
					style: "danger",
				})
				.row();
		} else if (filter === "approved") {
			keyboard
				.text(
					`${say({ en: "↩️ Revoke", es: "↩️ Revocar" }, lang)} #${i + 1}`,
					acRevoke.pack({ uid: id }),
					{ style: "danger" },
				)
				.row();
		} else if (filter === "denied") {
			keyboard
				.text(
					`${say({ en: "✅ Reapprove", es: "✅ Reaprobar" }, lang)} #${i + 1}`,
					acApprove.pack({ uid: id, v: "denied" }),
					{ style: "success" },
				)
				.row();
		}
	}

	if (ids.length > shownIds.length) {
		lines.push(
			"",
			`(+${ids.length - shownIds.length} ${say({ en: "more, not shown", es: "más, no mostrados" }, lang)})`,
		);
	}
	if (filter === "approved" && defaults.size > 0) {
		lines.push("", `+ ${defaults.size} hardcoded defaults`);
	}

	keyboard.text(back, acView.pack({ v: "main" }));
	return { text: lines.join("\n"), keyboard };
};

// One combined rooms view (group counts stay small): approved rooms can be
// left, pending ones approved or left, denied ones re-allowed (the bot has
// already left those — re-allowing just welcomes the next add).
const groupsView = async (storage: Storage, ctx: BotCtx, lang: string) => {
	const idx = await loadIndex(storage, groupIndexKey(ctx));
	const back = say({ en: "⬅️ Back", es: "⬅️ Volver" }, lang);
	const lines: string[] = [say({ en: "👥 Groups", es: "👥 Grupos" }, lang)];
	const keyboard = new InlineKeyboard();
	let n = 0;

	const buckets: Array<{
		filter: keyof AccessIndex;
		header: string;
	}> = [
		{ filter: "approved", header: `✅ ${say(statusLabel.approved, lang)}` },
		{ filter: "pending", header: `⏳ ${say(statusLabel.pending, lang)}` },
		{
			filter: "denied",
			header: `🚪 ${say({ en: "Left/denied", es: "Fuera/denegados" }, lang)}`,
		},
	];
	for (const { filter, header } of buckets) {
		const ids = idx[filter].slice(0, 20);
		if (ids.length === 0) continue;
		lines.push("", `${header} (${idx[filter].length})`);
		for (const id of ids) {
			n += 1;
			const rec = await loadGroup(storage, ctx, id);
			const ageRef =
				rec?.approvedAt ?? rec?.deniedAt ?? rec?.requestedAt ?? Date.now();
			lines.push(
				`${n}. ${formatGroup(rec, id)} · ${say({ en: "ago", es: "hace" }, lang)} ${fmtAge(Date.now() - ageRef)}`,
			);
			if (filter === "approved") {
				keyboard
					.text(
						`${say({ en: "🚪 Leave", es: "🚪 Salir" }, lang)} #${n}`,
						acGroupLeave.pack({ gid: id, v: "groups" }),
						{ style: "danger" },
					)
					.row();
			} else if (filter === "pending") {
				keyboard
					.text(`✅ ${n}`, acGroupApprove.pack({ gid: id, v: "groups" }), {
						style: "success",
					})
					.text(`🚪 ${n}`, acGroupLeave.pack({ gid: id, v: "groups" }), {
						style: "danger",
					})
					.row();
			} else {
				keyboard
					.text(
						`${say({ en: "✅ Allow", es: "✅ Permitir" }, lang)} #${n}`,
						acGroupApprove.pack({ gid: id, v: "groups" }),
						{ style: "success" },
					)
					.row();
			}
		}
	}
	if (n === 0) lines.push("", say({ en: "(empty)", es: "(vacío)" }, lang));

	keyboard.text(back, acView.pack({ v: "main" }));
	return { text: lines.join("\n"), keyboard };
};

// ─── test helper ───────────────────────────────────────────────────

/**
 * Inject a synthetic access request — for tests/demos when you can't
 * easily spin up a second Telegram account. Writes a `pending` record
 * to storage at the same key the plugin's session would, updates the
 * index, then DMs the admin with the real
 * `[✅ Approve][❌ Deny]` keyboard. Tapping those buttons exercises
 * the real callback handlers end-to-end.
 *
 * Pass the SAME `storage` instance you passed to `accessControl({ storage })`.
 */
export const simulateAccessRequest = async (
	bot: AnyBot,
	storage: Storage,
	adminId: number,
	fakeUser: AccessUser,
	message?: string,
): Promise<void> => {
	const now = Date.now();
	const rec: AccessRecord = {
		status: "pending",
		user: fakeUser,
		chatId: fakeUser.id,
		requestedAt: now,
		firstMessage: message?.slice(0, FIRST_MSG_LIMIT),
		messageCount: 0,
		rejectedAttempts: 0,
		lastNotifiedAt: now,
	};
	// `BotCtx` shape (`{ bot: { info } }`) — `bot` here is the Bot
	// instance itself, which exposes `info` directly after `bot.start`.
	const botCtx: BotCtx = { bot: { info: bot.info } };
	await saveAccess(storage, botCtx, fakeUser.id, rec);
	await indexAdd(storage, indexKey(botCtx), "pending", fakeUser.id);

	const adminLang = await langOfUser(storage, botCtx, adminId);

	await bot.api.sendMessage({
		chat_id: adminId,
		text: requestNotificationText(fakeUser.id, rec, false, adminLang),
		reply_markup: requestKeyboard(fakeUser.id, adminLang),
	});
};
