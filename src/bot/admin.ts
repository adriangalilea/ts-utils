/**
 * Admin identity — the `adminContext` plugin. Worker-safe (no env, no OS).
 *
 * Every context gets `ctx.adminId` (the PRIMARY admin: the single approve/deny + notification
 * target) and `ctx.isAdmin` (true for ANY admin). `accessControl` and the payments refund flow
 * declare a gramio dependency on this plugin's name (`@adriangalilea/utils/bot/admin`), so they
 * inherit whatever this derives.
 *
 * The admin ids are a SOURCE, not a snapshot. Pass a live resolver (a function) and it is consulted
 * PER UPDATE, so changing where the ids come from — a db row a console writes, a runtime toggle —
 * is effective on the very next update with NO restart. Static id(s) work too. This reads no env and
 * touches no OS: the caller owns where the ids come from. That is what keeps it Worker-safe, and it
 * is why env is a *fallback the caller composes into the source*, never a coupling in here (a Node
 * bot passes `kev.int("TELEGRAM_ADMIN_ID", fallback)`; a Worker bot passes a db-backed resolver that
 * falls back to its own env).
 *
 * Peer dep: `gramio`.
 *
 * @example
 * // Worker bot: live from the db — the console writes it, effective next update, no redeploy.
 * bot.extend(adminContext(() => store.readAdminIds()))
 * // Node bot: env with a hardcoded fallback, resolved at the call site.
 * bot.extend(adminContext(kev.int("TELEGRAM_ADMIN_ID", 123456789)))
 * // Static, one or many.
 * bot.extend(adminContext(123456789))
 * bot.extend(adminContext([123456789, 42]))
 */
import { Plugin } from "gramio";

type MaybePromise<T> = T | Promise<T>;

/**
 * Where admin ids come from. A number or array is static; a function is a LIVE resolver, consulted
 * per update. The FIRST id is primary (`ctx.adminId`); `ctx.isAdmin` is true for any id in the set.
 */
export type Admins =
	| number
	| readonly number[]
	| (() => MaybePromise<number | readonly number[]>);

/** Coerce any source value to a clean, positive-integer id array (junk writes screamed out). */
const toIds = (v: number | readonly number[]): number[] =>
	(typeof v === "number" ? [v] : v).filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0);

export const adminContext = (admins: Admins) => {
	// Normalize every source shape to ONE async resolver. A static source resolves the array once;
	// a function is called on each update — that liveness is the whole point of the plugin.
	const resolve: () => Promise<number[]> =
		typeof admins === "function"
			? async () => toIds(await admins())
			: (() => {
					const ids = toIds(admins);
					return async () => ids;
				})();

	return new Plugin("@adriangalilea/utils/bot/admin").derive(async (ctx) => {
		const ids = await resolve();
		// `senderId` is provided by gramio's SenderMixin; `undefined` on actor-less service events,
		// which correctly yields `isAdmin: false`.
		const senderId = "senderId" in ctx ? (ctx as { senderId?: number }).senderId : undefined;
		return {
			adminId: ids[0] ?? 0,
			isAdmin: typeof senderId === "number" && ids.includes(senderId),
		};
	});
};
