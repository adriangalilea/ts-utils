/**
 * Art. 103(m) TRLGDCU waiver flow.
 *
 * Three things have to happen together (see CLAUDE.md §5):
 *
 *   1. The user expresses *prior express consent* to begin execution.
 *   2. They acknowledge they thereby lose the 14-day right of withdrawal.
 *   3. The contract is confirmed on a durable medium.
 *
 * This module owns #1 and #2 via a separate, unbundled consent prompt
 * — one inline message with the waiver text plus a single affirmative
 * button. Bundling this into ToS acceptance voids the waiver under
 * Spanish consumer law. #3 is satisfied implicitly by Telegram: every
 * outgoing message the bot sends is preserved in the chat (durable).
 *
 * The bot author supplies the wording (Polyglot text + version string).
 * Bumping `waiver.version` forces re-consent on the next purchase
 * attempt; old consents stay attached to old charges for audit (see
 * `ChargeRecord.waiverSnapshot`).
 */

import type { Storage } from "@gramio/storage";
import { InlineKeyboard } from "gramio";

import { say } from "../../say/index.js";
import { createLogger } from "../../universal/log.js";
import { callbackNs } from "../callbacks.js";
import { botStorageKey } from "../kit.js";
import {
	type BotPaymentsConfig,
	DEFAULT_PRIVACY_URL,
	type PaymentsSession,
	type WaiverRecord,
} from "./types.js";

const FALLBACK_LANG = "en";
const log = createLogger("bot/payments");

const cb = callbackNs("pay");

/**
 * Callback fired when the user taps "✅ Consiento y comprendo" in the
 * waiver consent prompt. Carries the productKey of the in-flight
 * purchase so we can resume after persisting consent.
 *
 * `pk` (productKey) follows the shape validated by `payload.ts` —
 * `vip.N` / `credits.N` / `perks.X` — all ASCII-safe.
 */
export const waiverConsentCb = cb.data("waiver:consent", { pk: "string" });

/** Fired when the user taps "❌ Cancelar" in the consent prompt. */
export const waiverCancelCb = cb.data("waiver:cancel", {});

// ─── pure helpers ──────────────────────────────────────────────────

/**
 * Returns true when the stored consent matches the current waiver
 * version — i.e. no re-consent needed before a purchase.
 */
export const isWaiverFresh = (
	stored: WaiverRecord | undefined,
	currentVersion: string,
): boolean => {
	if (!stored) return false;
	return stored.version === currentVersion;
};

/**
 * Resolve the waiver text Polyglot to a single string for the recipient's
 * locale, with `'en'` fallback. Matches `say()`'s semantics for the
 * dynamic-string escape hatch.
 */
const resolveWaiverText = (
	cfg: BotPaymentsConfig<string>,
	lang: string,
): string => {
	const text = cfg.waiver.text as Record<string, string>;
	return text[lang] ?? text[FALLBACK_LANG] ?? Object.values(text)[0] ?? "";
};

// ─── consent prompt rendering ──────────────────────────────────────

/**
 * Build the inline keyboard that accompanies the consent prompt. Three
 * buttons:
 *
 *   📖 Términos — URL to `legal.termsUrl` (informational, not the
 *                  affirmative action)
 *   🔒 Privacidad — URL to `legal.privacyUrl` (same)
 *   ✅ Consiento y comprendo — the single affirmative action
 *   ❌ Cancelar — back out without consenting
 *
 * The "✅" button carries the productKey the user was about to buy, so
 * the consent handler can resume the invoice flow on tap.
 */
export const waiverKeyboard = (
	cfg: BotPaymentsConfig<string>,
	productKey: string,
	lang: string,
): InlineKeyboard => {
	const kb = new InlineKeyboard();
	const termsUrl = cfg.legal.termsUrl;
	const privacyUrl = cfg.legal.privacyUrl ?? DEFAULT_PRIVACY_URL;
	// Terms button only renders if the bot configured a termsUrl —
	// there's no Telegram-side standard ToS to default to. Privacy
	// always renders; it falls back to Telegram's Standard Bot Privacy
	// Policy when unset (covers what this library retains by default).
	if (termsUrl) {
		kb.url(say({ en: "📖 Terms", es: "📖 Términos" }, lang), termsUrl);
	}
	kb.url(say({ en: "🔒 Privacy", es: "🔒 Privacidad" }, lang), privacyUrl);
	kb.row();
	kb.text(
		say(
			{
				en: "✅ I consent and understand",
				es: "✅ Consiento y comprendo",
			},
			lang,
		),
		waiverConsentCb.pack({ pk: productKey }),
		{ style: "primary" },
	);
	kb.row();
	kb.text(
		say({ en: "❌ Cancel", es: "❌ Cancelar" }, lang),
		waiverCancelCb.pack({}),
	);
	return kb;
};

/**
 * Render the consent body the user sees. Includes a short, neutral
 * header above the wording supplied by the bot author. The header is
 * separated by a blank line so reading order matches what consumer
 * authorities expect (waiver text is unambiguous and prominent).
 */
export const renderConsentBody = (
	cfg: BotPaymentsConfig<string>,
	lang: string,
): string =>
	[
		say(
			{
				en: "Before continuing, please read and consent:",
				es: "Antes de continuar, lee y consiente:",
			},
			lang,
		),
		"",
		resolveWaiverText(cfg, lang),
	].join("\n");

// ─── persistence ───────────────────────────────────────────────────

/**
 * Persist a fresh waiver record onto the current ctx's session. Callers
 * own the session shape via a structural narrow — this avoids a generic
 * type bloom across the plugin.
 */
export const persistWaiverOnSession = (
	ctx: { session: { pay?: PaymentsSession } },
	version: string,
	locale: string,
): WaiverRecord => {
	const record: WaiverRecord = {
		at: Date.now(),
		version,
		locale,
	};
	ctx.session.pay ??= {};
	ctx.session.pay.waiver = record;
	log.success(`waiver consent persisted: version=${version} locale=${locale}`);
	return record;
};

/**
 * Persist a waiver record onto a SPECIFIC user's stored session (used
 * when the consent tap arrives on a different ctx than the original
 * `invoice()` call — rare, but possible if the user wedges multiple
 * flows). The cross-user write is via storage directly, mirroring the
 * pattern in `access-control.ts`.
 */
export const persistWaiverForUser = async (
	storage: Storage,
	ctx: { bot: unknown },
	userId: number,
	version: string,
	locale: string,
): Promise<WaiverRecord> => {
	const key = botStorageKey(ctx, userId);
	const full = ((await storage.get(key)) ?? {}) as {
		pay?: PaymentsSession;
	} & Record<string, unknown>;
	const record: WaiverRecord = {
		at: Date.now(),
		version,
		locale,
	};
	full.pay = { ...(full.pay ?? {}), waiver: record };
	await storage.set(key, full);
	return record;
};
