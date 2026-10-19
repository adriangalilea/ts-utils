/**
 * The per-user language every bot surface reads, and the session record
 * it is read from. Both are shared: a plugin that redeclares either one
 * gets to disagree with the rest of the library about what a user speaks
 * and about which fields survive a write.
 *
 * Pure except for the storage handle it is handed — Worker-safe, guarded
 * by test:worker-safe.
 */

import type { Storage } from "@gramio/storage";

import { botStorageKey } from "./keys.js";

/** BCP-47 tag as stored on a session, e.g. `"en"`, `"pt-BR"`. */
export type Lang = string;

/** Spoken when a user has expressed no preference. */
export const FALLBACK_LANG: Lang = "en";

/** The one session field every plugin reads, whatever else it owns. */
export type LangSession = { language?: Lang };

/** The acting user's language, off any ctx carrying a session. */
export const ctxLang = (ctx: { session?: LangSession }): Lang =>
	ctx.session?.language ?? FALLBACK_LANG;

/**
 * A whole `@gramio/session` record. `Fields` names the slice the caller
 * owns; the index signature carries every other plugin's fields through
 * a read-modify-write untouched.
 */
export type FullSessionRecord<Fields> = Fields &
	LangSession &
	Record<string, unknown>;

/**
 * Read another user's session record straight from storage, under the
 * calling bot's namespace.
 *
 * gramio's session plugin only ever exposes the CURRENT ctx's record, so
 * a plugin acting on someone else (an admin approving a stranger, a
 * refund crediting the buyer) has to address the row itself. Write it
 * back whole: the record is shared, and a partial `storage.set` drops
 * the fields other plugins own.
 */
export const loadFullRecord = async <Fields>(
	storage: Storage,
	ctx: { bot: unknown },
	userId: number,
): Promise<FullSessionRecord<Fields>> =>
	((await storage.get(botStorageKey(ctx, userId))) as
		| FullSessionRecord<Fields>
		| undefined) ?? ({} as FullSessionRecord<Fields>);

/** The language to address another user in, read from their stored record. */
export const langOfUser = async (
	storage: Storage,
	ctx: { bot: unknown },
	userId: number,
): Promise<Lang> =>
	(await loadFullRecord<unknown>(storage, ctx, userId)).language ??
	FALLBACK_LANG;
