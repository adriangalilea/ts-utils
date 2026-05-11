/**
 * Invoice payload codec. Telegram echoes the `invoice_payload` string
 * back on `pre_checkout_query` and `successful_payment`; we use it to
 * recover the `(productKey, userId)` pair that the in-flight purchase
 * refers to.
 *
 * Constraints from Telegram:
 *   - Max 128 bytes.
 *   - Must be a string (we use printable ASCII).
 *
 * Format: `${productKey}|${userId}`
 *
 * The `|` delimiter is unambiguous because productKey is one of:
 *   - `vip.${number}`        — only digits and `.`
 *   - `credits.${number}`    — only digits and `.`
 *   - `perks.${key}`         — key restricted to `/^[a-z][a-z0-9_]*$/i`
 *                              by `config.ts` validation
 *
 * None of those contain `|`, so the first `|` is always the delimiter.
 * Worst case length is ~`perks.${64-char-key}|${20-digit-int}` ≈ 90 bytes
 * — comfortably under the 128-byte cap. We assert the length to fail
 * loud if the cap is ever approached.
 */

import { panic } from "../../offensive.js";

const MAX_PAYLOAD_BYTES = 128;

export type DecodedPayload = {
	readonly productKey: string;
	readonly userId: number;
};

/**
 * Build the `invoice_payload` string for a `sendInvoice` call. Throws
 * `Panic` if the result would exceed Telegram's 128-byte cap — that's
 * either a bad productKey or a userId out of bounds, both of which are
 * bugs we want to scream about.
 */
export const encodePayload = (productKey: string, userId: number): string => {
	if (!productKey.length) {
		panic("bot/payments/payload: encodePayload called with empty productKey");
	}
	if (!Number.isInteger(userId) || userId <= 0) {
		panic(
			`bot/payments/payload: encodePayload userId must be positive integer (got ${userId})`,
		);
	}
	const payload = `${productKey}|${userId}`;
	// ASCII-only by construction (productKey shape + decimal digits), so
	// .length === byte length. Cheap check.
	if (payload.length > MAX_PAYLOAD_BYTES) {
		panic(
			`bot/payments/payload: encoded payload ${payload.length}B exceeds Telegram's ` +
				`${MAX_PAYLOAD_BYTES}B cap. productKey="${productKey}" userId=${userId}`,
		);
	}
	return payload;
};

/**
 * Decode the `invoice_payload` Telegram echoes back. Returns `undefined`
 * (NOT throws) on malformed input — Telegram could in principle deliver
 * a payload from a different bot version, and we want the pre_checkout
 * handler to be able to reject it gracefully rather than crashing.
 */
export const decodePayload = (payload: string): DecodedPayload | undefined => {
	if (typeof payload !== "string" || payload.length === 0) return undefined;
	const idx = payload.indexOf("|");
	if (idx <= 0 || idx === payload.length - 1) return undefined;
	const productKey = payload.slice(0, idx);
	const userIdStr = payload.slice(idx + 1);
	if (!/^\d+$/.test(userIdStr)) return undefined;
	const userId = Number.parseInt(userIdStr, 10);
	if (!Number.isInteger(userId) || userId <= 0) return undefined;
	return { productKey, userId };
};
