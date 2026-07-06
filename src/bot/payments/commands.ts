/**
 * Slash-command handlers. The `/paysupport` command is mandated by
 * Telegram Bot Developer ToS §6.5 — every bot accepting payments must
 * expose a way for users to reach support about charges.
 *
 * The actual command registration (`.command("paysupport", { … }, fn)`)
 * happens in `plugin.ts`; this module owns the body + the response
 * text so wording stays in one place.
 */

import { say } from "../../say/index.js";
import { type BotMessageCtx, narrow } from "../ctx.js";
import {
	type BotPaymentsConfig,
	FALLBACK_LANG,
	type SessionLike,
} from "./types.js";

/**
 * Mandatory `/paysupport` text. ToS §6.5 requires every bot accepting
 * payments to expose this. Brief message pointing the user to the menu
 * (where the refund flow lives) and to the human admin contact.
 *
 * Exported because tests + future admin tooling may want to render the
 * exact wording the bot uses without going through the command handler.
 */
export const buildPaysupportText = (
	cfg: BotPaymentsConfig<string>,
	lang: string,
): string => {
	// Where in THIS bot's UI the user manages their charges — the menu
	// command name is app-specific, so the line is configurable
	// (`cfg.paysupportHint`). Default names the library's own menu path.
	const hint = say(
		cfg.paysupportHint ?? {
			en: "Open /settings → 💎 VIP → 📜 History to see your charges.",
			es: "Abre /settings → 💎 VIP → 📜 Historial para ver tus cargos.",
		},
		lang,
	);
	return say(
		{
			en:
				`Need help with a payment?\n\n` +
				`• ${hint}\n` +
				`• For a refund or any charge issue, contact ${cfg.paysupport}.\n\n` +
				`Refund disputes are handled by the admin within Telegram.`,
			es:
				`¿Necesitas ayuda con un pago?\n\n` +
				`• ${hint}\n` +
				`• Para un reembolso o cualquier problema con un cargo, contacta ${cfg.paysupport}.\n\n` +
				`Las disputas las gestiona el admin dentro de Telegram.`,
		},
		lang,
	);
};

/**
 * Returns the `/paysupport` command handler. Pure factory — `plugin.ts`
 * calls this once at construction and passes the result to gramio's
 * `.command()`.
 */
export const buildPaysupportCommand =
	(cfg: BotPaymentsConfig<string>) =>
	async (ctx: unknown): Promise<void> => {
		const c = narrow<BotMessageCtx<SessionLike>>(ctx);
		const lang = c.session.language ?? FALLBACK_LANG;
		await c.send(buildPaysupportText(cfg, lang));
	};
