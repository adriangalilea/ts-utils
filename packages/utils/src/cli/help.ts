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
 *  start at one edge. The column leaves the words 40 columns of a reading
 *  measure (80 at most), never under 20: a long usage puts its words on the
 *  next line, under the column, rather than pushing every row's words right. */
function aligned(groups: [string, [string, string][]][]): string[] {
	const widest =
		Math.max(0, ...groups.flatMap(([, rows]) => rows.map(([l]) => width(l)))) +
		6;
	const columns = Math.min(80, process.stdout.columns || 80);
	const column = Math.min(widest, Math.max(columns - 40, 20));
	return groups.flatMap(([title, rows]) => [
		"",
		heading(title),
		...rows.map(([l, r]) => {
			const cell = `    ${l}`;
			return width(cell) + 2 <= column
				? hang(cell, column, r)
				: `${cell}\n${wrap(r, column)}`;
		}),
	]);
}

/** Markdown of the small subset a guide is written in, for a terminal:
 *  paragraphs folded, bullets folded under their marker, fenced blocks kept as
 *  written. */
function markdown(text: string, indent: number): string {
	const lead = " ".repeat(indent);
	const out: string[] = [];
	let paragraph: string[] = [];
	let fenced = false;
	const flush = () => {
		if (!paragraph.length) return;
		const joined = paragraph.join(" ");
		out.push(
			joined.startsWith("- ")
				? hang(`${lead}- `, indent + 2, joined.slice(2))
				: wrap(joined, indent),
		);
		paragraph = [];
	};
	for (const line of text.split("\n")) {
		if (line.startsWith("```")) {
			flush();
			fenced = !fenced;
			continue;
		}
		if (fenced) {
			out.push(`${lead}  ${ui.muted(line)}`);
			continue;
		}
		if (!line.trim()) {
			flush();
			if (out.at(-1) !== "") out.push("");
			continue;
		}
		if (line.startsWith("- ")) flush();
		paragraph.push(line.trim());
	}
	flush();
	while (out.at(-1) === "") out.pop();
	return out.join("\n");
}

/** The program as the help reads it: its spec, every command (`help` among
 *  them), its global flags and its sections, all checked by `program`. */
export type HelpModel = {
	spec: ProgramSpec;
	commands: Readonly<Record<string, CommandSpec>>;
	global: FlagSpecs;
	sections: readonly (readonly [string, readonly string[]])[];
	/** Every status it ends with, the built-in three among them, by code. */
	exits: Readonly<Record<number, string>>;
};

/** A command's tail as typed after its name: its arguments, then `-- <its
 *  passthrough>`. */
const tailOf = (c: CommandSpec | undefined): string =>
	[c?.args, c?.passthrough === undefined ? undefined : `-- ${c.passthrough}`]
		.filter(Boolean)
		.join(" ");

/** The exits as rows, by code. */
export const exitRows = (
	exits: Readonly<Record<number, string>>,
): [string, string][] =>
	Object.entries(exits)
		.map(([code, says]): [number, string] => [Number(code), says])
		.sort(([a], [b]) => a - b)
		.map(([code, says]) => [String(code), says]);

export function helpOf({ spec, commands, global, sections, exits }: HelpModel) {
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
		const tail = tailOf(c);
		return `${ui.muted(spec.name)} ${said}${tail ? ` ${ui.muted(tail)}` : ""}`;
	};
	/** A command as plain text, for the words of a refusal and the skill. */
	const typed = (name: string) => {
		const tail = tailOf(commands[name]);
		return `${spec.name} ${name}${tail ? ` ${tail}` : ""}`;
	};
	/** The built-in skill commands, shown in a group of their own. */
	const agentCommands = Object.keys(commands).filter(
		(n) => n === "skill" || n.startsWith("skill "),
	);

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
		const guides: [string, string][] = Object.entries(spec.guides ?? {}).map(
			([n, g]) => [n, g.says],
		);
		const agents: [string, string][] = agentCommands.map((n) => [
			usageOf(n),
			commands[n]?.says ?? "",
		]);
		const groups: [string, [string, string][]][] = [
			...rows,
			...(guides.length ? [["guides", guides] as const] : []),
			...(agents.length ? [["for agents", agents] as const] : []),
			...(always.length ? [["on every command", always] as const] : []),
			...(env.length ? [["environment", env] as const] : []),
			["exits", exitRows(exits)] as const,
		].map(([t, r]) => [t, [...r]]);
		const skill = spec.skill
			? [
					"",
					hang(
						`  ${ui.muted("use it for")}`,
						14,
						spec.skill.useWhen.join("; "),
					),
					...(spec.skill.never?.length
						? [hang(`  ${ui.muted("never")}`, 14, spec.skill.never.join("; "))]
						: []),
				]
			: [];
		const foot = [
			`${spec.name} help <command> for one in full`,
			...(guides.length ? [`${spec.name} help <guide> to read one`] : []),
			spec.foot,
		];
		return [
			"",
			`  ${ui.head(spec.name)}${spec.version === undefined ? "" : ` ${ui.muted(spec.version)}`}  ${spec.says}`,
			...(spec.about ?? []).map((l) => ui.muted(wrap(l, 2))),
			...skill,
			...aligned(groups),
			"",
			`  ${ui.muted(foot.filter(Boolean).join(" · "))}`,
			"",
		].join("\n");
	}

	/** One guide, as `help <guide>` prints it. */
	function guide(name: string): string {
		const g = spec.guides?.[name];
		if (!g) throw new Error(`cli: guide "${name}", which ${spec.name} lacks`);
		return ["", `  ${ui.head(g.title)}`, "", markdown(g.body, 2), ""].join(
			"\n",
		);
	}

	function detail(name: string): string {
		const c = commands[name];
		if (!c)
			throw new Error(`cli: detail of "${name}", which ${spec.name} lacks`);
		const flags = Object.entries(c.flags ?? {});
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
				? aligned([
						[
							"flags",
							flags.map(([n, f]): [string, string] => [
								flagText(n, f),
								`${f.says}${
									// choices a placeholder hides are said after the words
									f.choices && f.value
										? ui.muted(` (${f.choices.join(", ")})`)
										: ""
								}${f.required ? ui.muted(" (required)") : ""}`,
							]),
						],
					])
				: []),
			...(c.passthrough === undefined
				? []
				: [
						"",
						heading("after --"),
						wrap(
							`${c.passthrough}: handed to the command as it is typed; --help and --json there are its own`,
							4,
						),
					]),
			...(c.examples?.length
				? [
						"",
						heading("examples"),
						...c.examples.map((e) => `    ${ui.muted("$")} ${e}`),
					]
				: []),
			...(c.json ? ["", heading("--json"), wrap(c.json, 4)] : []),
			...(c.exits?.length
				? aligned([
						[
							"exits",
							c.exits.map((code): [string, string] => [
								String(code),
								exits[code] ?? "",
							]),
						],
					])
				: []),
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
				...(c.passthrough !== undefined && { passthrough: c.passthrough }),
				...(c.exits?.length && { exits: c.exits }),
			})),
			global: flagsData(global),
			exits: exitRows(exits).map(([code, says]) => ({
				code: Number(code),
				says,
			})),
			...(spec.guides && {
				guides: Object.entries(spec.guides).map(([name, g]) => ({
					name,
					...g,
				})),
			}),
			...(spec.skill && { skill: spec.skill }),
		};
	}

	return { usageOf, typed, overview, detail, guide, describe };
}
