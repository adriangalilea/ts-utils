/**
 * User identity formatting — the "[name] [@username] [id]" composition every bot
 * re-rolls for admin DMs, logs, and access panels. Worker-safe (no env, no OS,
 * zero deps).
 *
 * A Telegram user MAY have a username and MAY expose a name; the honest label
 * shows what exists and never pads what doesn't:
 *
 *   name + username →  Ada Lovelace (@ada · 42)
 *   name only       →  Ada Lovelace (42)
 *   username only   →  @ada (42)
 *   id only         →  id 42
 *   nothing         →  unknown
 *
 * Both gramio spellings are read (wrapper camelCase `firstName`, raw payload
 * `first_name`), so contexts, payloads, and stored rows all format alike. Plain
 * text by design: these lines land in admin DMs and logs sent without a
 * parse_mode, where a name containing `<` or `&` must stay literal.
 *
 * @example
 * await notifyAdmins(bot, ids, `👥 ${userLabel(ctx.from)} added me to ${title}`)
 */

/** The fields a user label is built from. Every field optional — pass any of a
 *  gramio `from`, a raw Telegram payload user, or your own stored row. */
export type UserRef = {
	id?: number;
	username?: string;
	firstName?: string;
	lastName?: string;
	first_name?: string;
	last_name?: string;
};

/** One line naming a user by whatever identity they actually have. */
export function userLabel(u: UserRef): string {
	const name = [u.firstName ?? u.first_name, u.lastName ?? u.last_name]
		.filter(Boolean)
		.join(" ")
		.trim();
	const at = u.username ? `@${u.username}` : "";
	const id = u.id !== undefined ? String(u.id) : "";
	if (name) {
		const detail = [at, id].filter(Boolean).join(" · ");
		return detail ? `${name} (${detail})` : name;
	}
	if (at) return id ? `${at} (${id})` : at;
	return id ? `id ${id}` : "unknown";
}
