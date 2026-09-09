/**
 * Callback-query handler bodies — extracted from `plugin.ts` per the
 * `bot/CLAUDE.md` plugin file convention (callbacks.ts owns the
 * `.callbackQuery()` handler bodies; plugin.ts is wiring only).
 *
 * The CallbackData schemas themselves live with their owning feature
 * (waiver.ts, refund.ts) — those modules also export `buildXxxHandler`
 * factories for handlers that need richer dependencies (refund's flow
 * needs `stores + storage + cfg`). This file holds the simpler
 * inline-style handlers that didn't justify their own factory.
 *
 *   - `buildWaiverConsentHandler({ cfg, catalog })`
 *       persists consent, deletes the prompt message, re-enters the
 *       invoice flow for the carried productKey.
 *   - `buildWaiverCancelHandler()`
 *       acknowledges the tap and edits the prompt to a "canceled"
 *       message.
 *   - `buildRefundCloseHandler()`
 *       admin-only: deletes the DM notification on the close button.
 */

import { say } from "../../say/index.js";
import { type BotCallbackCtx, narrow } from "../ctx.js";
import { ctxLang } from "../lang.js";
import { presentInvoice } from "./invoice.js";
import type {
	BotPaymentsConfig,
	PaymentsSession,
	ProductCatalog,
	SessionLike,
} from "./types.js";
import { persistWaiverOnSession } from "./waiver.js";

// ─── waiver consent ───────────────────────────────────────────────

export const buildWaiverConsentHandler =
	(args: { cfg: BotPaymentsConfig<string>; catalog: ProductCatalog }) =>
	async (ctx: unknown): Promise<void> => {
		const c = narrow<BotCallbackCtx<SessionLike, { pk: string }>>(ctx);
		const lang = ctxLang(c);
		const userId = c.from?.id;
		if (!userId) {
			await c.answer({
				text: say(
					{
						en: "Could not identify you.",
						es: "No se pudo identificarte.",
					},
					lang,
				),
			});
			return;
		}
		const product = args.catalog.byKey.get(c.queryData.pk);
		if (!product) {
			await c.answer({
				text: say(
					{ en: "Unknown product.", es: "Producto desconocido." },
					lang,
				),
			});
			return;
		}

		// Persist consent on the user's session (cur ctx IS the user
		// since they're tapping their own message).
		persistWaiverOnSession(
			narrow<{ session: { pay?: PaymentsSession } }>(c),
			args.cfg.waiver.version,
			lang,
		);

		// Acknowledge the tap with a toast, then DELETE the consent prompt
		// entirely. Editing its body instead leaves a message that goes
		// stale the moment the payment sheet opens underneath, and stays
		// in the chat history forever. The toast confirms what happened;
		// the next thing the user sees is the payment sheet itself.
		await c.answer({
			text: say(
				{ en: "✅ Consent recorded.", es: "✅ Consentimiento registrado." },
				lang,
			),
		});
		try {
			await c.message?.delete?.();
		} catch {
			/* message too old to delete — ignore */
		}

		// Re-enter the invoice flow now that consent is fresh.
		await presentInvoice(
			narrow<Parameters<typeof presentInvoice>[0]>(c),
			args.cfg,
			args.catalog,
			product.id,
		);
	};

// ─── waiver cancel ────────────────────────────────────────────────

export const buildWaiverCancelHandler =
	() =>
	async (ctx: unknown): Promise<void> => {
		const c = narrow<BotCallbackCtx<SessionLike>>(ctx);
		const lang = ctxLang(c);
		await c.answer({
			text: say({ en: "Canceled.", es: "Cancelado." }, lang),
		});
		try {
			await c.editText(
				say({ en: "❌ Purchase canceled.", es: "❌ Compra cancelada." }, lang),
			);
		} catch {
			/* ignore — message too old to edit */
		}
	};

// ─── refund close (admin-only) ────────────────────────────────────

export const buildRefundCloseHandler =
	() =>
	async (ctx: unknown): Promise<void> => {
		const c = narrow<BotCallbackCtx<SessionLike> & { isAdmin: boolean }>(ctx);
		const lang = ctxLang(c);
		if (!c.isAdmin) {
			await c.answer({
				text: say({ en: "Admin only.", es: "Solo admin." }, lang),
				show_alert: true,
			});
			return;
		}
		await c.answer({});
		try {
			await c.message?.delete?.();
		} catch {
			/* ignore — message too old to delete */
		}
	};
