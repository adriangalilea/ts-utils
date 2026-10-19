/**
 * `cli/help`: what a person reads about a program, from the same table the
 * parse reads: the overview, one command in full, and both as data for
 * `help --json`. Folded to the terminal, never past 80 columns.
 */

import type {
	CommandSpec,
	FlagSpec,
	FlagSpecs,
	ProgramSpec,
} from "./command.js";
import { argsOf } from "./grammar.js";
import { padEndV, ui, width } from "./text.js";

/** A flag's value as the help shows it: its `value`, else its choices, else its type's. */
const placeholderOf = (f: FlagSpec): string =>
	f.value ??
	(f.choices
		? `<${f.choices.join("|")}>`
		: f.type === "integer"
			? "<n>"
			: "<value>");

/** A flag as the help shows it: `-d, --dir <path>`, a list `--to <value>,…`. */
export const flagText = (name: string, f: FlagSpec) =>
	`${f.short ? `-${f.short}, ` : ""}--${name}${
		f.type === "boolean" ? "" : ` ${placeholderOf(f)}${f.list ? ",…" : ""}`
	}`;

/** `text` as lines that end by the terminal's width (80 at most, a reading
 *  measure) when they start at `column`; never under 30 a line, so a narrow
 *  terminal folds words rather than letters. */
function fold(text: string, column: number): string[] {
	const room = Math.max(
		30,
		Math.min(80, process.stdout.columns || 80) - column,
	);
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/)) {
		if (line && width(line) + 1 + width(word) > room) {
			lines.push(line);
			line = word;
		} else line = line ? `${line} ${word}` : word;
	}
	if (line) lines.push(line);
	return lines;
}

/** `text` folded, each line after `indent` spaces. */
const wrap = (text: string, indent: number): string =>
	fold(text, indent)
		.map((l) => `${" ".repeat(indent)}${l}`)
		.join("\n");

/** `left` padded to `column`, then `text` folded so its later lines start under
 *  its first: a description stays in its column however long. */
const hang = (left: string, column: number, text: string): string =>
	`${padEndV(left, column)}${fold(text, column).join(`\n${" ".repeat(column)}`)}`.trimEnd();

const heading = (s: string) => `  ${ui.accent(s)}`;

/** Rows in one column whatever group they stand in, so every group's words
 *  start at one edge. */
function aligned(groups: [string, [string, string][]][]): string[] {
	const column =
		Math.max(0, ...groups.flatMap(([, rows]) => rows.map(([l]) => width(l)))) +
		6;
	return groups.flatMap(([title, rows]) => [
		"",
		heading(title),
		...rows.map(([l, r]) => hang(`    ${l}`, column, r)),
	]);
}

/** The program as the help reads it: its spec, every command (`help` among
 *  them), its global flags and its sections, all checked by `program`. */
export type HelpModel = {
	spec: ProgramSpec;
	commands: Readonly<Record<string, CommandSpec>>;
	global: FlagSpecs;
	sections: readonly (readonly [string, readonly string[]])[];
};

export function helpOf({ spec, commands, global, sections }: HelpModel) {
	// A command as typed: `discord message|msg <ref>`, its aliases quiet beside it;
	// the default's name in brackets, as it may go unsaid: `hf-get [pull] <repo>`.
	const usageOf = (name: string) => {
		const c = commands[name];
		const aliases = c?.aliases?.length
			? ui.muted(`|${c.aliases.join("|")}`)
			: "";
		const said =
			name === spec.default?.command
				? `${ui.muted("[")}${ui.head(name)}${aliases}${ui.muted("]")}`
				: `${ui.head(name)}${aliases}`;
		return `${ui.muted(spec.name)} ${said}${c?.args ? ` ${ui.muted(c.args)}` : ""}`;
	};
	/** A command as plain text, for the words of a refusal. */
	const typed = (name: string) =>
		`${spec.name} ${name}${commands[name]?.args ? ` ${commands[name]?.args}` : ""}`;

	function overview(): string {
		const rows = sections.map(
			([title, names]): [string, [string, string][]] => [
				title,
				names.map((n): [string, string] => [
					usageOf(n),
					commands[n]?.says ?? "",
				]),
			],
		);
		const always: [string, string][] = [
			...Object.entries(global).map(([n, f]): [string, string] => [
				flagText(n, f),
				f.says,
			]),
			...(spec.version === undefined
				? []
				: [["--version", `this ${spec.name}'s version`] as [string, string]]),
		];
		const env: [string, string][] = (spec.env ?? []).map(([n, says]) => [
			n,
			says,
		]);
		const groups: [string, [string, string][]][] = [
			...rows,
			...(always.length ? [["on every command", always] as const] : []),
			...(env.length ? [["environment", env] as const] : []),
		].map(([t, r]) => [t, [...r]]);
		return [
			"",
			`  ${ui.head(spec.name)}${spec.version === undefined ? "" : ` ${ui.muted(spec.version)}`}  ${spec.says}`,
			...(spec.about ?? []).map((l) => ui.muted(wrap(l, 2))),
			...aligned(groups),
			"",
			`  ${ui.muted([`${spec.name} help <command> for one in full`, spec.foot].filter(Boolean).join(" · "))}`,
			"",
		].join("\n");
	}

	function detail(name: string): string {
		const c = commands[name];
		if (!c)
			throw new Error(`cli: detail of "${name}", which ${spec.name} lacks`);
		const flags = Object.entries(c.flags ?? {});
		const column =
			Math.max(0, ...flags.map(([n, f]) => width(flagText(n, f)))) + 2;
		// Words an argument takes that its usage does not show (`<env>`, not `<a|b>`).
		const listed = argsOf(c).filter((a) => a.choices && !a.name.includes("|"));
		// The commands whose name begins with this one's: `invoice create` under `invoice`.
		const under = Object.keys(commands).filter((n) => n.startsWith(`${name} `));
		return [
			"",
			`  ${usageOf(name)}`,
			`  ${c.says}`,
			...(c.more ? ["", wrap(c.more, 2)] : []),
			...(under.length
				? aligned([
						[
							"commands",
							under.map((n): [string, string] => [
								usageOf(n),
								commands[n]?.says ?? "",
							]),
						],
					])
				: []),
			...(listed.length
				? aligned([
						[
							"arguments",
							listed.map((a): [string, string] => [
								`<${a.name}>`,
								(a.choices ?? []).join(", "),
							]),
						],
					])
				: []),
			...(flags.length
				? [
						"",
						heading("flags"),
						...flags.map(([n, f]) =>
							hang(
								`    ${flagText(n, f)}`,
								column + 4,
								`${f.says}${
									// choices a placeholder hides are said after the words
									f.choices && f.value
										? ui.muted(` (${f.choices.join(", ")})`)
										: ""
								}${f.required ? ui.muted(" (required)") : ""}`,
							),
						),
					]
				: []),
			...(c.examples?.length
				? [
						"",
						heading("examples"),
						...c.examples.map((e) => `    ${ui.muted("$")} ${e}`),
					]
				: []),
			...(c.json ? ["", heading("--json"), wrap(c.json, 4)] : []),
			"",
		].join("\n");
	}

	function describe() {
		const flagsData = (flags: FlagSpecs = {}) =>
			Object.entries(flags).map(([n, f]) => ({
				flag: flagText(n, f),
				says: f.says,
			}));
		return {
			name: spec.name,
			version: spec.version,
			...(spec.default && { default: spec.default.command }),
			commands: Object.entries(commands).map(([name, c]) => ({
				name,
				usage: typed(name),
				...(c.aliases?.length && { aliases: c.aliases }),
				says: c.says,
				...(c.choices && { choices: c.choices }),
				flags: flagsData(c.flags),
				...(c.more && { more: c.more }),
				...(c.examples && { examples: c.examples }),
				...(c.json && { json: c.json }),
			})),
			global: flagsData(global),
		};
	}

	return { usageOf, typed, overview, detail, describe };
}
