/**
 * `cli/tokens`: argv read once, in one pass, against the program's flag table.
 *
 * The table is program-wide (`program` refuses one flag name with two types or
 * two short letters), so whether a flag takes a value is known before the
 * command is: `-wd ~/x` and `--limit -5` read the same whichever command they
 * belong to. What a flag may do in THIS command (whether it is its flag at
 * all, whether its value is missing) is decided by the parse once the command
 * is known, so the token only records it.
 *
 * Read as people type: `--dir=x` and `--dir x`, short letters grouped (`-wo`,
 * a value-taking one last with its value glued or next: `-wd ~/x`, `-wd~/x`),
 * `--` ends the flags, a lone `-` is a word, and a dash before a digit that no
 * flag spells (`-5`, `--09-29`) is a word, never a flag.
 */

import type { FlagSpec } from "./command.js";

/** One piece of argv as the program reads it. */
export type Token =
	| { kind: "word"; value: string }
	| {
			kind: "flag";
			/** The long name, or the letter itself for a letter no flag has. */
			name: string;
			/** As typed: `--dir`, `-d`. */
			said: string;
			/** Its value, for a flag that takes one and got one. */
			value?: string;
			/** A value-taking flag at the end, or before another flag. */
			missing?: true;
			/** A boolean flag given a value (`--watch=yes`). */
			extra?: true;
	  };

const NUMBERLIKE = /^--?\d/;

export function tokenize(
	argv: readonly string[],
	flags: Readonly<Record<string, FlagSpec>>,
	shortOf: ReadonlyMap<string, string>,
): Token[] {
	const takesValue = (name: string) =>
		flags[name] !== undefined && flags[name].type !== "boolean";
	const spellsFlag = (a: string) =>
		a.startsWith("--")
			? (a.slice(2).split("=")[0] ?? "") in flags
			: shortOf.has(a.slice(1, 2));
	// A word: no dash, a lone dash, or a number no flag spells.
	const isWord = (a: string) =>
		!a.startsWith("-") || a === "-" || (NUMBERLIKE.test(a) && !spellsFlag(a));

	const out: Token[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] as string;
		if (a === "--") {
			for (const w of argv.slice(i + 1)) out.push({ kind: "word", value: w });
			break;
		}
		if (isWord(a)) {
			out.push({ kind: "word", value: a });
			continue;
		}
		// The value after a flag: the next argv word, unless it is a flag or `--`.
		const valueAfter = (name: string, said: string) => {
			const next = argv[i + 1];
			if (next === undefined || next === "--" || !isWord(next))
				out.push({ kind: "flag", name, said, missing: true });
			else {
				out.push({ kind: "flag", name, said, value: next });
				i++;
			}
		};
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
			const inline = eq === -1 ? undefined : a.slice(eq + 1);
			const said = `--${name}`;
			if (!(name in flags)) out.push({ kind: "flag", name, said });
			else if (!takesValue(name))
				out.push({
					kind: "flag",
					name,
					said,
					...(inline !== undefined && { extra: true as const }),
				});
			else if (inline !== undefined)
				out.push({ kind: "flag", name, said, value: inline });
			else valueAfter(name, said);
			continue;
		}
		// Letters: each a flag; a value-taking one takes the rest of the group,
		// or the next word when it ends the group.
		for (let j = 1; j < a.length; j++) {
			const letter = a[j] as string;
			const said = `-${letter}`;
			const name = shortOf.get(letter);
			if (name === undefined) {
				out.push({ kind: "flag", name: letter, said });
				continue;
			}
			if (!takesValue(name)) {
				out.push({ kind: "flag", name, said });
				continue;
			}
			const glued = a.slice(j + 1);
			if (glued) out.push({ kind: "flag", name, said, value: glued });
			else valueAfter(name, said);
			break;
		}
	}
	return out;
}
