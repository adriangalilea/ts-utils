/**
 * `cli/grammar`: a command's `args` as the parse counts them, read once from
 * the spec. The type-level twin, which types a handler's `args`, is
 * `ArgsOf` in `cli/command`.
 */

import type { CommandSpec } from "./command.js";

export type Arg = {
	name: string;
	needed: boolean;
	rest: boolean;
	/** The only words it takes: its `a|b` spelling, or the command's `choices`. */
	choices?: readonly string[];
};

/** `args` as the parse counts them, each with the words it takes. Throws on a
 *  grammar that cannot be counted, as the program starts. */
export function argsOf(c: CommandSpec | undefined): Arg[] {
	const args = c?.args;
	const words = args ? args.split(/\s+/).filter(Boolean) : [];
	const shape = words.map((w, i): Arg => {
		const m = w.match(/^([<[])([^>\]]+?)(\.\.\.)?([>\]])$/);
		if (!m || (m[1] === "<") !== (m[4] === ">"))
			throw new Error(`cli: args "${args}": "${w}" is not <x>, [x] or <x...>`);
		const rest = m[3] !== undefined;
		if (rest && i !== words.length - 1)
			throw new Error(`cli: args "${args}": only the last may take the rest`);
		const name = m[2] as string;
		const listed = c?.choices?.[name];
		if (listed && name.includes("|"))
			throw new Error(
				`cli: args "${args}": <${name}> spells its words and has choices too: one`,
			);
		if (listed?.length === 0)
			throw new Error(
				`cli: args "${args}": choices for <${name}> name nothing`,
			);
		const own = name.includes("|") ? name.split("|") : listed;
		return {
			name,
			needed: m[1] === "<",
			rest,
			...(own && { choices: own }),
		};
	});
	// `[who] <msgId>` is a real shape (the handler decides whether the first word
	// is a who), but its positions are the handler's: with one word the parse
	// cannot say which argument it is, so it cannot check that word's choices.
	const firstOptional = shape.findIndex((a) => !a.needed);
	const positional =
		firstOptional === -1 || !shape.slice(firstOptional).some((a) => a.needed);
	if (!positional && shape.some((a) => a.choices))
		throw new Error(
			`cli: args "${args}": choices need positions the parse can tell, and a needed argument after one that may be missing leaves them to the handler`,
		);
	for (const name of Object.keys(c?.choices ?? {}))
		if (!shape.some((a) => a.name === name))
			throw new Error(
				`cli: args "${args ?? ""}": choices for <${name}>, which it does not take`,
			);
	return shape;
}
