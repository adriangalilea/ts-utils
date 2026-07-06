/**
 * `sendInvoice` wrappers — one per product kind, plus the high-level
 * `presentInvoice` entry that the `ctx.payments.invoice(...)` surface
 * routes to.
 *
 * Stars-only by design (see CLAUDE.md §1, §2). Every invoice goes out
 * with `currency: 'XTR'` and `provider_token: ""` — Telegram rejects
 * provider_token for XTR. The `prices` array must contain exactly one
 * `LabeledPrice` for XTR per the Bot API docs.
 *
 * The function calls `bot.api.sendInvoice` directly (not `ctx.sendInvoice`)
 * so the same path works from both message and callback_query contexts
 * — `message_thread_id` is plumbed explicitly so threaded replies land
 * in the right thread regardless of which mixin would otherwise inject it.
 *
 * https://core.telegram.org/bots/api#sendinvoice
 * https://core.telegram.org/bots/payments-stars
 */

import { panic, SourcedError } from "../../offensive.js";
import { say } from "../../say/index.js";
import { createLogger } from "../../universal/log.js";
import { encodePayload } from "./payload.js";
import type {
	BotPaymentsConfig,
	CreditsPackResolved,
	PaymentsSession,
	PerkResolved,
	ProductCatalog,
	VipRungResolved,
} from "./types.js";
import { renderConsentBody, waiverKeyboard } from "./waiver.js";

const log = createLogger("bot/payments");

// Telegram caps from the Bot API (sendInvoice §):
const TITLE_MAX = 32;
const DESCRIPTION_MAX = 255;

const FALLBACK_LANG = "en";

/**
 * Structural shape we need from the calling ctx. Matches both
 * `MessageContext` and `CallbackQueryContext` after gramio's mixins —
 * we pull `chat.id` / `threadId` from either layout via short-circuits.
 */
export type InvoiceCtx = {
	bot: {
		api: {
			sendInvoice: (params: SendInvoiceParams) => Promise<unknown>;
		};
	};
	from?: { id: number };
	chat?: { id: number };
	threadId?: number;
	message?: { threadId?: number; chat?: { id: number } };
	session?: { pay?: PaymentsSession; language?: string };
};

/** Subset of the Telegram `sendInvoice` schema this module needs. */
type SendInvoiceParams = {
	chat_id: number;
	message_thread_id?: number;
	title: string;
	description: string;
	payload: string;
	provider_token: string;
	currency: "XTR";
	prices: Array<{ label: string; amount: number }>;
	subscription_period?: number;
	start_parameter?: string;
};

// ─── small helpers ─────────────────────────────────────────────────

// Single-source the Telegram length cap so each call site can't drift.
const cap = (s: string, max: number): string =>
	s.length > max ? s.slice(0, max) : s;

const ctxLang = (ctx: InvoiceCtx): string =>
	ctx.session?.language ?? FALLBACK_LANG;

const ctxChatId = (ctx: InvoiceCtx): number => {
	const id = ctx.chat?.id ?? ctx.message?.chat?.id;
	if (id === undefined) {
		panic(
			"bot/payments/invoice: ctx is missing chat.id (neither top-level nor message.chat)",
		);
	}
	return id;
};

const ctxThreadId = (ctx: InvoiceCtx): number | undefined =>
	ctx.threadId ?? ctx.message?.threadId;

/**
 * Resolve a Polyglot to a single string with a fallback chain. Trims
 * + caps at `maxLen`.
 */
const resolveLabel = (
	value: { [k: string]: string } | undefined,
	lang: string,
	maxLen: number,
): string | undefined => {
	if (!value) return undefined;
	const v = value[lang] ?? value[FALLBACK_LANG] ?? Object.values(value)[0];
	if (typeof v !== "string") return undefined;
	const trimmed = v.trim();
	return cap(trimmed, maxLen);
};

// ─── title / description per product kind ──────────────────────────

const titleFor = (
	product: VipRungResolved | CreditsPackResolved | PerkResolved,
	cfg: BotPaymentsConfig<string>,
	lang: string,
): string => {
	if (product.id.startsWith("vip.")) {
		return (
			resolveLabel((product as VipRungResolved).name, lang, TITLE_MAX) ??
			say({ en: "VIP", es: "VIP" }, lang)
		);
	}
	if (product.id.startsWith("credits.")) {
		const p = product as CreditsPackResolved;
		const explicit = resolveLabel(p.name, lang, TITLE_MAX);
		if (explicit) return explicit;
		const unit =
			resolveLabel(cfg.credits?.unit as { [k: string]: string }, lang, 32) ??
			"credits";
		// "100 credits" / "100 mensajes" — fits in 32 chars for reasonable values.
		const base = `${p.creditsGranted} ${unit}`;
		return cap(base, TITLE_MAX);
	}
	// perk
	return (
		resolveLabel((product as PerkResolved).name, lang, TITLE_MAX) ??
		(product as PerkResolved).key
	);
};

const descriptionFor = (
	product: VipRungResolved | CreditsPackResolved | PerkResolved,
	cfg: BotPaymentsConfig<string>,
	lang: string,
): string => {
	if (product.id.startsWith("vip.")) {
		const v = product as VipRungResolved;
		const name =
			resolveLabel(v.name, lang, 24) ?? say({ en: "VIP", es: "VIP" }, lang);
		const baseEn = `30 days of ${name} access`;
		const baseEs = `30 días de acceso ${name}`;
		const base = say({ en: baseEn, es: baseEs }, lang);
		if (v.creditsGranted > 0) {
			const unit =
				resolveLabel(cfg.credits?.unit as { [k: string]: string }, lang, 24) ??
				"credits";
			const tailEn = `. Includes ${v.creditsGranted} ${unit} per month.`;
			const tailEs = `. Incluye ${v.creditsGranted} ${unit} al mes.`;
			const tail = say({ en: tailEn, es: tailEs }, lang);
			const full = base + tail;
			return cap(full, DESCRIPTION_MAX);
		}
		return cap(base, DESCRIPTION_MAX);
	}
	if (product.id.startsWith("credits.")) {
		const p = product as CreditsPackResolved;
		const unit =
			resolveLabel(cfg.credits?.unit as { [k: string]: string }, lang, 24) ??
			"credits";
		const base = say(
			{
				en: `Top up your balance by ${p.creditsGranted} ${unit}.`,
				es: `Recarga tu saldo con ${p.creditsGranted} ${unit}.`,
			},
			lang,
		);
		return cap(base, DESCRIPTION_MAX);
	}
	// perk
	const p = product as PerkResolved;
	const name = resolveLabel(p.name, lang, 24) ?? p.key;
	const base = say(
		{
			en: `Unlock ${name} — one-time.`,
			es: `Desbloquear ${name} — único pago.`,
		},
		lang,
	);
	return cap(base, DESCRIPTION_MAX);
};

// ─── core send ─────────────────────────────────────────────────────

/**
 * Issue a Telegram Stars invoice for `product`. Caller is expected to
 * have already cleared waiver consent — `presentInvoice` (the public
 * entry) handles that gate. This function does the wire call only.
 *
 * Wraps Telegram-side failures in a typed `SourcedError({ source:
 * 'telegram', operation: 'sendInvoice' })` so the catch boundary in
 * `plugin.ts` can render a localized fallback message.
 */
export const sendInvoiceForProduct = async (
	ctx: InvoiceCtx,
	cfg: BotPaymentsConfig<string>,
	product: VipRungResolved | CreditsPackResolved | PerkResolved,
	userId: number,
): Promise<void> => {
	const lang = ctxLang(ctx);
	const chatId = ctxChatId(ctx);
	const threadId = ctxThreadId(ctx);

	const title = titleFor(product, cfg, lang);
	const description = descriptionFor(product, cfg, lang);
	const payload = encodePayload(product.id, userId);

	const priceLabel =
		resolveLabel((product as VipRungResolved | PerkResolved).name, lang, 32) ??
		title;

	const params: SendInvoiceParams = {
		chat_id: chatId,
		...(threadId !== undefined && { message_thread_id: threadId }),
		title,
		description,
		payload,
		provider_token: "", // XTR — must be empty
		currency: "XTR",
		prices: [{ label: priceLabel, amount: product.xtr }],
	};

	if (product.id.startsWith("vip.")) {
		params.subscription_period = (product as VipRungResolved).periodSeconds;
	}

	log.event(
		`sendInvoice → telegram: product=${product.id} user=${userId} xtr=${product.xtr} title="${title}" subscription_period=${params.subscription_period ?? "none"}`,
	);
	try {
		await ctx.bot.api.sendInvoice(params);
		log.success(
			`sendInvoice accepted by telegram: product=${product.id} user=${userId}`,
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		log.error(`sendInvoice rejected by telegram: ${msg}`);
		// Hint on the specific subscription-export setup gotcha — there's
		// no documented fix path in gramio/telegram docs, so surface ours.
		if (msg.includes("SUBSCRIPTION_EXPORT_MISSING")) {
			log.warn(
				"hint: open BotFather → /mybots → your bot → Bot Settings → Star Subscriptions and link a Fragment payout method before sending subscription invoices",
			);
		}
		throw new SourcedError({
			source: "telegram",
			operation: "sendInvoice",
			message: msg,
			cause: e,
			context: { productKey: product.id, userId, chatId, threadId },
		});
	}
};

// ─── public entry: waiver gate + send ──────────────────────────────

/**
 * What the entry returned to mean. `'invoice_sent'` = the user got a
 * Telegram payment sheet; `'waiver_prompt_sent'` = the user got the
 * consent prompt and must tap before the invoice goes out;
 * `'unknown_product'` = the key didn't resolve and we already told the
 * user nothing happened.
 */
export type PresentInvoiceResult =
	| "invoice_sent"
	| "waiver_prompt_sent"
	| "unknown_product";

/**
 * High-level entry for `ctx.payments.invoice(productKey)`.
 *
 * Validates the productKey against the catalog, gates on waiver
 * freshness, and either:
 *
 *   - sends the consent prompt (one-tap "✅ Consiento" button carrying
 *     the productKey, so the user resumes the purchase on tap), OR
 *   - calls `sendInvoiceForProduct` directly when consent is already
 *     fresh.
 *
 * Returns a discriminated tag so callers can branch on what the user
 * saw — useful for `require()`-style helpers.
 */
export const presentInvoice = async (
	ctx: InvoiceCtx & {
		send: (text: string, params?: object) => Promise<unknown>;
	},
	cfg: BotPaymentsConfig<string>,
	catalog: ProductCatalog,
	productKey: string,
): Promise<PresentInvoiceResult> => {
	const product = catalog.byKey.get(productKey);
	if (!product) {
		log.warn(`presentInvoice unknown productKey "${productKey}"`);
		const lang = ctxLang(ctx);
		await ctx.send(
			say(
				{
					en: `❌ Unknown product "${productKey}".`,
					es: `❌ Producto desconocido "${productKey}".`,
				},
				lang,
			),
		);
		return "unknown_product";
	}
	const userId = ctx.from?.id;
	if (!userId) {
		panic("bot/payments/invoice: presentInvoice called with no ctx.from.id");
	}

	const stored = ctx.session?.pay?.waiver;
	const fresh = stored && stored.version === cfg.waiver.version;
	if (!fresh) {
		log.info(
			`presentInvoice: waiver ${stored ? `stale (${stored.version} ≠ ${cfg.waiver.version})` : "missing"} — sending consent prompt for ${product.id} user=${userId}`,
		);
		const lang = ctxLang(ctx);
		await ctx.send(renderConsentBody(cfg, lang), {
			reply_markup: waiverKeyboard(cfg, product.id, lang),
		});
		return "waiver_prompt_sent";
	}

	log.info(
		`presentInvoice: waiver fresh — going straight to sendInvoice for ${product.id} user=${userId}`,
	);
	await sendInvoiceForProduct(ctx, cfg, product, userId);
	return "invoice_sent";
};
