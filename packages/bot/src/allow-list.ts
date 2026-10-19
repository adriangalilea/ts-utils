/**
 * Static allow-list by id AND/OR username — stateless, no storage/session.
 *
 * The heavyweight counterpart is `bot/access-control` (approve/deny flow,
 * revocable store, admin menu — needs session + storage). This is the light
 * version: a hardcoded allow-list you control in code, gating by Telegram user
 * id and/or @username. Decorates every message/callback context with
 * `ctx.allowed` (boolean); you gate in your handlers (`if (!ctx.allowed) return`).
 *
 * Caveat on usernames: a @username is optional and can change, and the Bot API
 * has no way to resolve a username → id ahead of time. Prefer `ids` when you
 * know them; `usernames` is the pragmatic fallback when you only have the handle.
 *
 *   import { allowList } from '@adriangalilea/utils/bot/allow-list'
 *
 *   bot
 *     .extend(allowList({ ids: [123456789], usernames: ['mrwagecuck'] }))
 *     .on('message', (ctx) => { if (!ctx.allowed) return; ... })
 */
import { Plugin } from "gramio";

export type AllowListOptions = {
	/** Allowed Telegram user ids — exact and robust. */
	ids?: ReadonlyArray<number>;
	/** Allowed @usernames — case-insensitive, leading `@` optional. Less robust (usernames change). */
	usernames?: ReadonlyArray<string>;
};

const normalize = (u: string) => u.replace(/^@/, "").toLowerCase();

/** Returns whether a user (by id/username) is on the allow-list — pure, framework-free. */
export const makeAllowList = (opts: AllowListOptions = {}) => {
	const ids = new Set(opts.ids ?? []);
	const usernames = new Set((opts.usernames ?? []).map(normalize));
	return (user?: { id?: number; username?: string }) =>
		!!user &&
		((user.id !== undefined && ids.has(user.id)) ||
			(user.username !== undefined && usernames.has(normalize(user.username))));
};

/** gramio plugin: decorates `ctx.allowed` (boolean) for message/callback updates. */
export const allowList = (opts: AllowListOptions = {}) => {
	const isAllowed = makeAllowList(opts);
	return new Plugin("@adriangalilea/utils/bot/allow-list").derive((ctx) => {
		const id =
			"senderId" in ctx && typeof ctx.senderId === "number"
				? ctx.senderId
				: undefined;
		const username = (ctx as { from?: { username?: string } }).from?.username;
		return { allowed: isAllowed({ id, username }) };
	});
};
