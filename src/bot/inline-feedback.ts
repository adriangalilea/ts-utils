/**
 * Inline-feedback tripwire — behavioral detection for a BotFather setting the
 * Bot API cannot see.
 *
 * `chosen_inline_result` delivery is gated by BotFather's inline FEEDBACK
 * probability, which defaults to 0% and silently RESETS on bot transfer and
 * on inline-mode toggling. At 0%, taps post the placeholder client-side but
 * the bot never hears about them, so nothing ever fills in — and `getMe`
 * reports nothing (the profile `expects` drift-check is blind here). The
 * asymmetry IS measurable though: results keep getting served while a chosen
 * event never arrives.
 *
 * Storage is injected as three atomic-ish ops (wire to D1/Redis/anything);
 * this module owns the thresholds, the throttle, and the operator message.
 * Thresholds are deliberately lazy — this is a drift alarm, not a metric.
 *
 * @example
 * const probe = inlineFeedbackProbe({
 *   bump: () => store.bumpInlineServed(ctx),
 *   reset: () => store.recordInlineChosen(ctx, Date.now()),
 *   markAlerted: () => store.markInlineAlerted(ctx, Date.now()),
 *   adminIds: () => deps.adminIds(),
 * })
 * bot.inlineQuery(async (ctx) => { …answer with results…; await probe.onServed(ctx.bot) })
 * bot.chosenInlineResult(() => true, async (ctx) => { await probe.onChosen(); … })
 */

import type { Bot } from "gramio";
import { notifyAdmins } from "./notify.js";

export interface InlineFeedbackProbeOptions {
	/** Increment the served counter, returning the new count + when the last alert fired. */
	bump: () => Promise<{ served: number; lastAlertAt: number | null }>;
	/** A chosen event arrived: feedback works, the counter starts over. */
	reset: () => Promise<void>;
	/** Persist that the alert fired (also zeroes the counter downstream). */
	markAlerted: () => Promise<void>;
	adminIds: () => Promise<readonly number[]> | readonly number[];
	/** Served results (WITH content — empty answers prove nothing) before the alarm. Default 25. */
	threshold?: number;
	/** Minimum ms between alerts. Default 24h. */
	alertEveryMs?: number;
	/** Called with the alarm line before the DM goes out (wire your logger). */
	onTrip?: (message: string) => void;
}

export interface InlineFeedbackProbe {
	/** Call after answering an inline query WITH results. Never throws. */
	onServed(bot: Bot): Promise<void>;
	/** Call from the chosen_inline_result handler. Never throws. */
	onChosen(): Promise<void>;
}

const DEFAULT_THRESHOLD = 25;
const DEFAULT_ALERT_EVERY_MS = 24 * 60 * 60 * 1000;

export function inlineFeedbackProbe(
	opts: InlineFeedbackProbeOptions,
): InlineFeedbackProbe {
	const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
	const alertEveryMs = opts.alertEveryMs ?? DEFAULT_ALERT_EVERY_MS;
	return {
		async onServed(bot) {
			try {
				const { served, lastAlertAt } = await opts.bump();
				if (served < threshold) return;
				const now = Date.now();
				if (lastAlertAt !== null && now - lastAlertAt < alertEveryMs) return;
				await opts.markAlerted();
				const line = `inline feedback looks DISABLED: ${served} inline results served since the last chosen_inline_result`;
				opts.onTrip?.(line);
				const ids = await opts.adminIds();
				await notifyAdmins(
					bot as Parameters<typeof notifyAdmins>[0],
					ids,
					`⚠️ ${line}.\n` +
						"Taps post the placeholder but the bot never hears about them, so nothing ever fills in.\n" +
						"@BotFather → /setinlinefeedback → this bot → 100%. (It resets to 0% on bot TRANSFER and on inline-mode toggling.)",
				);
			} catch {
				// best-effort: the probe must never break the inline answer path
			}
		},
		async onChosen() {
			await opts.reset().catch(() => {});
		},
	};
}
