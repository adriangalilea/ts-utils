/**
 * Canonical structural ctx types every plugin in this package imports.
 *
 * gramio's real `MessageContext` / `CallbackQueryContext` /
 * `SuccessfulPaymentContext` / etc. are fully-typed classes, but to
 * keep this library's handler signatures decoupled from gramio's exact
 * import chain (and to let action callbacks in `bot/menu` stay
 * plugin-agnostic), we declare the **minimum structural shape** each
 * plugin handler needs. Real gramio ctxs satisfy these shapes by duck
 * typing; the `narrow<T>(ctx)` helper documents the unavoidable cast.
 *
 * ## Why this exists
 *
 * Before this file, every plugin repeated the same dozen-line cast at
 * the top of every callback / derive / handler:
 *
 *     const c = ctx as unknown as {
 *       session: SessionLike; bot: { api: BotApi };
 *       from?: { id: number }; answer: (p: { text?: string }) => Promise<unknown>;
 *       editText: (text: string) => Promise<unknown>;
 *       queryData: { cid: string };
 *     };
 *
 * Same shape, redefined in 5 files, drifts independently. This module
 * collects every shape we use into ~5 reusable structural types so the
 * cast becomes `narrow<BotCallbackCtx<MySession, { cid: string }>>(ctx)`.
 *
 * ## What goes here vs the plugin
 *
 * - `bot/ctx.ts` (this file): structural ctx types that match
 *   gramio's, plus the `narrow` cast helper. Plugin-agnostic.
 * - Each plugin's own types module: the specific *derives* that plugin
 *   adds to ctx (`{ payments: PaymentsApi }`, `{ access: AccessInfo }`,
 *   `{ adminId: number; isAdmin: boolean }`). Composed with the
 *   canonical ctx via TS intersection.
 */

import type { Storage } from "@gramio/storage";

// ─── baseline ─────────────────────────────────────────────────────

/** Minimum ctx shape needed by storage helpers (`bot/storage.ts`) —
 *  carries the bot's identity for namespacing. */
export type BotIdCtx = {
	bot: { info: { id: number } };
};

/**
 * Bot API surface — deliberately loose **as a default**. Plugins
 * usually want strict per-method typing (so a typo on
 * `bot.api.refundStarPayment` is a compile error, and the params get
 * type-checked). The canonical ctx types are generic over `Api`, so
 * each plugin specializes:
 *
 *   type PaymentBotApi = {
 *     answerPreCheckoutQuery: (p: {...}) => Promise<unknown>
 *     refundStarPayment:      (p: {...}) => Promise<unknown>
 *     editUserStarSubscription: (p: {...}) => Promise<unknown>
 *   }
 *   const c = narrow<BotPaymentCtx<MySession, PaymentBotApi>>(ctx)
 *
 * Default is this loose `BotApi` (any method-name + any params) so
 * places that don't care about strict typing don't have to spell out
 * a full API shape.
 */
// `never[]` for args isn't a typo — it's the trick that lets a strict
// concrete `Api` extend this loose default. Contravariance: a function
// with specific param types IS assignable to one taking `never[]`
// (because `never` is the bottom type — anything is wider than never).
// With `unknown[]` we'd get the opposite, blocking strict APIs from
// satisfying `extends BotApi`.
export type BotApi = Record<string, (...args: never[]) => Promise<unknown>>;

// ─── Telegram user / chat / message shapes ────────────────────────

export type BotUser = {
	id: number;
	firstName?: string;
	lastName?: string;
	username?: string;
	languageCode?: string;
	isPremium?: boolean;
};

export type BotChat = {
	id: number;
	type: string;
	title?: string;
	username?: string;
	firstName?: string;
	lastName?: string;
};

/** Minimum shape we read from a `Message` payload. Includes everything
 *  needed for cross-event ctx access (e.g. callback ctx → originating
 *  message → chat / thread). */
export type BotMessage = {
	id?: number;
	chat?: BotChat;
	threadId?: number;
	text?: string;
	delete?: () => Promise<unknown>;
};

// ─── send / reply / answer / edit shapes ──────────────────────────

type SendParams = Record<string, unknown>;

export type Sender = (
	text: string | { toString(): string },
	params?: SendParams,
) => Promise<{ message_id: number }>;

export type Replier = (
	text: string | { toString(): string },
	params?: SendParams,
) => Promise<{ message_id: number }>;

export type CallbackAnswerer = (params: {
	text?: string;
	show_alert?: boolean;
	url?: string;
	cache_time?: number;
}) => Promise<unknown>;

export type TextEditor = (
	text: string | { toString(): string },
	params?: SendParams,
) => Promise<unknown>;

// ─── event-class ctx shapes ────────────────────────────────────────

/**
 * Generic message-event ctx. `Session` is the shape of the shared
 * session record across all plugins (`{ access?, language?, llm?, pay?,
 * ... }`); pass it as the type parameter at each handler site.
 *
 * Matches gramio's `MessageContext` structurally — a real
 * `MessageContext` is assignable here via duck typing.
 */
export type BotMessageCtx<
	Session = Record<string, unknown>,
	Api extends BotApi = BotApi,
> = BotIdCtx & {
	bot: { info: { id: number }; api: Api };
	from: BotUser;
	chat: BotChat;
	threadId?: number;
	text?: string;
	session: Session;
	send: Sender;
	reply: Replier;
};

/**
 * Callback-query ctx. `QueryData` is the unpacked shape of whichever
 * `CallbackData` schema matched (typically `{ cid: string }`,
 * `{ uid: number }`, etc.).
 */
export type BotCallbackCtx<
	Session = Record<string, unknown>,
	QueryData = Record<string, unknown>,
	Api extends BotApi = BotApi,
> = BotIdCtx & {
	bot: { info: { id: number }; api: Api };
	from: BotUser;
	chat?: BotChat;
	message?: BotMessage;
	threadId?: number;
	session: Session;
	queryData: QueryData;
	answer: CallbackAnswerer;
	editText: TextEditor;
	send: Sender;
};

/**
 * `pre_checkout_query` ctx. Different shape from message/callback —
 * the query payload is mixed onto the ctx directly. We expose `bot`
 * for `answerPreCheckoutQuery` calls.
 */
export type BotPreCheckoutCtx<Api extends BotApi = BotApi> = BotIdCtx & {
	bot: { info: { id: number }; api: Api };
	id: string;
	from: BotUser;
	currency: string;
	totalAmount: number;
	invoicePayload: string;
};

/**
 * `successful_payment` ctx. Inherits the message-event surface plus
 * gramio's `eventPayment` wrapper. We read `.payload` to get the raw
 * snake_case `TelegramSuccessfulPayment` because every downstream
 * consumer in this package speaks snake_case end-to-end.
 *
 * gramio's `SuccessfulPayment` wrapper is documented in
 * `@gramio/contexts/dist/index.d.ts` around line 2705. The camelCase
 * getters on the wrapper (`telegramPaymentChargeId`, `totalAmount`,
 * `invoicePayload`) are NOT used by this library by convention —
 * stick to one shape (raw snake_case via `.payload`) across all
 * payment handlers to avoid the bug where it's easy to read
 * `payment.telegram_payment_charge_id` on the wrapper and get
 * `undefined`.
 */
export type BotPaymentCtx<
	Session = Record<string, unknown>,
	Api extends BotApi = BotApi,
> = BotMessageCtx<Session, Api> & {
	eventPayment: {
		payload: {
			currency: string;
			total_amount: number;
			invoice_payload: string;
			telegram_payment_charge_id: string;
			provider_payment_charge_id?: string;
			subscription_expiration_date?: number;
			is_recurring?: true;
			is_first_recurring?: true;
		};
	};
};

// ─── narrowing helper ──────────────────────────────────────────────

/**
 * Casts an opaque `unknown` ctx to the structural shape `T` your
 * handler needs. Documents the unavoidable cast that bridges gramio's
 * exact ctx classes to this library's structural shapes.
 *
 * Use over `as unknown as T` so the intent is searchable and reviewers
 * see WHY the cast exists (gramio's MenuCtx / Plugin-derive typing has
 * limits that don't survive cross-plugin composition).
 *
 *   const c = narrow<BotCallbackCtx<MySession, { cid: string }>>(ctx)
 *
 * At runtime this is a no-op identity function.
 */
export const narrow = <T>(ctx: unknown): T => ctx as T;

// ─── re-export for ergonomic consumer typing ──────────────────────

export type { Storage };
