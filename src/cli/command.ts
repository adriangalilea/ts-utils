/**
 * `cli/command`: a command-line program described once, as data, and everything
 * a person meets read from that one table: the parse (node's `parseArgs`, so
 * `-wo` groups, `--dir=x` and `--` work), the refusals (a flag the command does
 * not take, an argument too few or too many, counted from its `args`), the
 * values' types, and the help (`--help`, `help <command>`, `help --json`). A
 * flag cannot exist without its words, nor its words without the flag.
 *
 * @example
 * const eid = program({
 *   name: "eid",
 *   version: "1.0.0",
 *   says: "your e-ID from a terminal",
 *   global: { json: { type: "boolean", says: "the answer as JSON" } },
 *   commands: {
 *     get: {
 *       args: "<address>",
 *       says: "get what someone is sending you",
 *       flags: { dir: { type: "string", short: "d", value: "<path>", says: "where to put it" } },
 *     },
 *   },
 * })
 * const call = eid.parse()
 * if (call.kind === "print") process.stdout.write(call.text)
 * else if (call.command === "get") get(call.args[0], call.values.dir)
 */

import { parseArgs } from "node:util";
import { CliError } from "./run.js";
import { padEndV, ui, width } from "./text.js";

export interface FlagSpec {
	readonly type: "boolean" | "string";
	/** One character: `-d` for `--dir`. Grouped as typed: `-wo`, `-wd ~/x`. */
	readonly short?: string;
	/** A string flag's value as the help shows it: `<path>`. */
	readonly value?: string;
	readonly says: string;
	/** Given again, every value kept in order (a string flag only). */
	readonly multiple?: boolean;
}

export type FlagSpecs = { readonly [name: string]: FlagSpec };

export interface CommandSpec {
	/**
	 * Its arguments as typed after its name: `<path> [name]`, `<words...>`,
	 * `<on|off>`. Each `<x>` must be given and each `[x]` may be; a last one
	 * ending in `...` takes the rest; `a|b` words are the only answers taken.
	 */
	readonly args?: string;
	/** One line: what it does, in the person's words. */
	readonly says: string;
	readonly flags?: FlagSpecs;
	/** What `help <command>` adds: how it behaves, what it refuses. */
	readonly more?: string;
	readonly examples?: readonly string[];
	/** What `--json` prints. */
	readonly json?: string;
}

export interface ProgramSpec {
	readonly name: string;
	readonly version: string;
	/** One line, beside the name atop the overview. */
	readonly says: string;
	/** Quieter lines under it. */
	readonly about?: readonly string[];
	readonly commands: { readonly [name: string]: CommandSpec };
	/** The overview's sections in order, each command in one (`help` may be
	 *  placed too). None: one list, in the order declared. */
	readonly sections?: readonly (readonly [string, readonly string[]])[];
	/** Taken by every command. */
	readonly global?: FlagSpecs;
	/** Environment variables it reads, as the overview lists them. */
	readonly env?: readonly (readonly [string, string])[];
	/** Said after "<name> help <command> for one in full". */
	readonly foot?: string;
}

type ValueOf<S extends FlagSpec> = S["type"] extends "boolean"
	? boolean
	: S["multiple"] extends true
		? string[]
		: string;

/** A flag absent is `undefined`, never a default: the command says what absent means. */
export type ValuesOf<F extends FlagSpecs> = {
	-readonly [K in keyof F]?: ValueOf<F[K]>;
};

/** No flags: an object no key is ever read from. */
type NoFlags = Record<never, FlagSpec>;
type FlagsOf<T> = T extends { readonly flags: infer F extends FlagSpecs }
	? F
	: NoFlags;
type GlobalOf<P extends ProgramSpec> = P extends {
	readonly global: infer G extends FlagSpecs;
}
	? G
	: NoFlags;
type Named<P extends ProgramSpec> = keyof P["commands"] & string;

/** One command asked for: its name, its arguments and its flags, typed by its own spec. */
export type Call<P extends ProgramSpec> = {
	[K in Named<P>]: {
		kind: "run";
		command: K;
		args: string[];
		values: ValuesOf<FlagsOf<P["commands"][K]> & GlobalOf<P>>;
	};
}[Named<P>];

/** Something to print and nothing to run: the help, or the version. `data` is
 *  the same as JSON, for `--json`. */
export type Print = { kind: "print"; text: string; data: unknown };

export interface Program<P extends ProgramSpec> {
	readonly spec: P;
	/** `argv` read: the command asked for, or what to print instead. A mistake in
	 *  it throws `CliError` (code "usage") saying what to type. */
	parse(argv?: readonly string[]): Call<P> | Print;
	/** The overview: every command on a line, by section. */
	overview(): string;
	/** One command in full. */
	detail(name: Named<P> | "help"): string;
	/** Every command as data: what `help --json` prints. */
	describe(): unknown;
}

const HELP: CommandSpec = {
	args: "[command]",
	says: "these words, or one command's in full",
	more: "With --json, every command as data: its arguments, flags, words and what its --json prints.",
};
const BUILT_IN: FlagSpecs = {
	help: { type: "boolean", short: "h", says: "this help" },
	version: { type: "boolean", says: "the version" },
};

type Arg = {
	name: string;
	needed: boolean;
	rest: boolean;
	choices: string[] | null;
};

/** `args` as the parse counts them. */
function argsOf(args: string | undefined): Arg[] {
	const words = args ? args.split(/\s+/).filter(Boolean) : [];
	return words.map((w, i) => {
		const m = w.match(/^([<[])([^>\]]+?)(\.\.\.)?([>\]])$/);
		if (!m || (m[1] === "<") !== (m[4] === ">"))
			throw new Error(`cli: args "${args}": "${w}" is not <x>, [x] or <x...>`);
		const rest = m[3] !== undefined;
		if (rest && i !== words.length - 1)
			throw new Error(`cli: args "${args}": only the last may take the rest`);
		const name = m[2] as string;
		return {
			name,
			needed: m[1] === "<",
			rest,
			choices: name.includes("|") ? name.split("|") : null,
		};
	});
}

/** A flag as the help shows it: `-d, --dir <path>`. */
const flagText = (name: string, f: FlagSpec) =>
	`${f.short ? `-${f.short}, ` : ""}--${name}${f.type === "string" ? ` ${f.value ?? "<value>"}` : ""}`;

/** `text` folded to the terminal's width (80 at most, a reading measure), each
 *  line after `indent` spaces. */
function wrap(text: string, indent: number): string {
	const room = Math.min(80, process.stdout.columns || 80) - indent;
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/)) {
		if (line && width(line) + 1 + width(word) > room) {
			lines.push(line);
			line = word;
		} else line = line ? `${line} ${word}` : word;
	}
	if (line) lines.push(line);
	return lines.map((l) => `${" ".repeat(indent)}${l}`).join("\n");
}

const heading = (s: string) => `  ${ui.accent(s)}`;

/** Rows in one column whatever group they stand in, so every group's words
 *  start at one edge. */
function aligned(groups: [string, [string, string][]][]): string[] {
	const column =
		Math.max(0, ...groups.flatMap(([, rows]) => rows.map(([l]) => width(l)))) +
		2;
	return groups.flatMap(([title, rows]) => [
		"",
		heading(title),
		...rows.map(([l, r]) => `    ${padEndV(l, column)}${r}`.trimEnd()),
	]);
}

/** The edits from `a` to `b`, for "did you mean". */
function distance(a: string, b: string): number {
	let row = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const next = [i];
		for (let j = 1; j <= b.length; j++)
			next[j] = Math.min(
				(row[j] as number) + 1,
				(next[j - 1] as number) + 1,
				(row[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		row = next;
	}
	return row[b.length] as number;
}

const nearest = (word: string, among: readonly string[]) =>
	among
		.map((w) => [w, distance(word, w)] as const)
		.filter(([, d]) => d <= 2)
		.sort((a, b) => a[1] - b[1])[0]?.[0];

/** A token a dash starts and a digit follows (`-1`, `--09-29`, `-5`), when no flag
 *  of that spelling exists: an argument, never a flag. */
const NUMBERLIKE = /^--?\d/;
/** Such a token while it is held aside: a private-use character no one types. */
const STAND_IN = /^(\d+)$/;

/**
 * The program, its spec checked: a short letter used twice, a flag named twice
 * with two types, a section that misses a command or names one that does not
 * exist, `args` that cannot be counted. Each throws here, the first time the
 * program runs, never when a person types the one command that trips it.
 */
export function program<const P extends ProgramSpec>(spec: P): Program<P> {
	const commands: Record<string, CommandSpec> = {
		...spec.commands,
		help: HELP,
	};
	if ("help" in spec.commands)
		throw new Error(`cli: "help" is built in, ${spec.name} cannot declare it`);
	const global = spec.global ?? {};
	for (const name of Object.keys(BUILT_IN))
		if (
			name in global ||
			Object.values(spec.commands).some((c) => c.flags && name in c.flags)
		)
			throw new Error(
				`cli: --${name} is built in, ${spec.name} cannot declare it`,
			);

	const flagsOf = (command: string): FlagSpecs => ({
		...BUILT_IN,
		...global,
		...commands[command]?.flags,
	});
	// Every flag of every command, one spelling each: the first reading of argv
	// cannot know the command yet, so it reads them all.
	const every: Record<string, FlagSpec> = {};
	const owners: Record<string, string[]> = {};
	for (const [command, c] of Object.entries(commands)) {
		argsOf(c.args);
		const shorts = new Map<string, string>();
		for (const [name, f] of Object.entries(flagsOf(command))) {
			if (!/^[a-z][a-z0-9-]*$/.test(name))
				throw new Error(`cli: --${name}: lower case, digits and hyphens`);
			if (f.short !== undefined) {
				if (f.short.length !== 1)
					throw new Error(
						`cli: --${name}: a short flag is one character, not "${f.short}"`,
					);
				const had = shorts.get(f.short);
				if (had)
					throw new Error(
						`cli: ${spec.name} ${command}: -${f.short} is both --${had} and --${name}`,
					);
				shorts.set(f.short, name);
			}
			if (f.multiple && f.type !== "string")
				throw new Error(`cli: --${name}: only a string flag is given again`);
			const seen = every[name];
			if (
				seen &&
				(seen.type !== f.type ||
					seen.short !== f.short ||
					seen.multiple !== f.multiple)
			)
				throw new Error(
					`cli: --${name} is spelled two ways (${command} and another): one type, one short letter`,
				);
			every[name] = f;
			if (!(name in BUILT_IN) && !(name in global))
				owners[name] = [...(owners[name] ?? []), command];
		}
	}
	// One letter, one flag, across the program: `-d` means the same in every
	// command, so the first reading of argv never has to guess.
	const shortOf = new Map<string, string>();
	for (const [name, f] of Object.entries(every)) {
		if (!f.short) continue;
		const had = shortOf.get(f.short);
		if (had)
			throw new Error(
				`cli: ${spec.name}: -${f.short} is both --${had} and --${name}`,
			);
		shortOf.set(f.short, name);
	}

	const sections: (readonly [string, readonly string[]])[] = spec.sections
		? [...spec.sections]
		: [["commands", [...Object.keys(spec.commands), "help"]]];
	{
		const placed = sections.flatMap(([, names]) => names);
		for (const name of placed)
			if (!(name in commands))
				throw new Error(
					`cli: section names "${name}", which ${spec.name} lacks`,
				);
		const twice = placed.filter((n, i) => placed.indexOf(n) !== i);
		if (twice.length)
			throw new Error(`cli: ${twice.join(", ")} in two sections`);
		const missing = Object.keys(spec.commands).filter(
			(n) => !placed.includes(n),
		);
		if (missing.length)
			throw new Error(`cli: ${missing.join(", ")} in no section`);
	}

	const usageOf = (name: string) => {
		const args = commands[name]?.args;
		return `${ui.muted(spec.name)} ${ui.head(name)}${args ? ` ${ui.muted(args)}` : ""}`;
	};
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
			["--version", `this ${spec.name}'s version`],
			...(spec.env ?? []).map(([n, says]): [string, string] => [n, says]),
		];
		return [
			"",
			`  ${ui.head(spec.name)} ${ui.muted(spec.version)}  ${spec.says}`,
			...(spec.about ?? []).map((l) => `  ${ui.muted(l)}`),
			...aligned([...rows, ["on every command", always]]),
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
		return [
			"",
			`  ${usageOf(name)}`,
			`  ${c.says}`,
			...(c.more ? ["", wrap(c.more, 2)] : []),
			...(flags.length
				? [
						"",
						heading("flags"),
						...flags.map(
							([n, f]) => `    ${padEndV(flagText(n, f), column)}${f.says}`,
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
			commands: Object.entries(commands).map(([name, c]) => ({
				name,
				usage: typed(name),
				says: c.says,
				flags: flagsData(c.flags),
				...(c.more && { more: c.more }),
				...(c.examples && { examples: c.examples }),
				...(c.json && { json: c.json }),
			})),
			global: flagsData(global),
		};
	}

	function parse(
		argv: readonly string[] = process.argv.slice(2),
	): Call<P> | Print {
		// A number after a dash that no flag spells is an argument: held aside as a
		// stand-in through the parse, given back where it stood.
		const held: string[] = [];
		const stand = (s: string) => {
			const m = s.match(STAND_IN);
			return m ? (held[Number(m[1])] as string) : s;
		};
		const args = argv.map((a) => {
			const spelled = a.startsWith("--")
				? a.slice(2).split("=")[0]
				: a.slice(1, 2);
			const known = a.startsWith("--")
				? spelled !== undefined && spelled in every
				: shortOf.has(spelled ?? "");
			if (!NUMBERLIKE.test(a) || known) return a;
			held.push(a);
			return `${held.length - 1}`;
		});

		const options = (flags: FlagSpecs) =>
			Object.fromEntries(
				Object.entries(flags).map(([n, f]) => [
					n,
					{
						type: f.type,
						...(f.short && { short: f.short }),
						...(f.multiple && { multiple: true }),
					},
				]),
			);
		const loose = parseArgs({
			args,
			options: options(every),
			strict: false,
			allowPositionals: true,
			tokens: true,
		});
		const [named, ...rest] = loose.positionals.map(stand);
		const name = named ?? "help";
		if (!(name in commands)) {
			const guess = nearest(name, Object.keys(commands));
			throw new CliError(
				`No command "${name}"${guess ? `: ${spec.name} ${guess}?` : ""}. ${spec.name} help`,
				"usage",
			);
		}

		const allowed = flagsOf(name);
		for (const t of loose.tokens) {
			if (t.kind !== "option" || t.name in allowed) continue;
			const said = t.rawName;
			const whose = owners[t.name];
			throw new CliError(
				whose
					? `${said} is not a flag of ${spec.name} ${name}: it is ${whose.map((w) => `${spec.name} ${w}`).join(", ")}'s`
					: `${said} is no flag of ${spec.name} ${name}${(() => {
							const guess = nearest(t.name, Object.keys(allowed));
							return guess ? `: --${guess}?` : "";
						})()}. ${spec.name} help ${name}`,
				"usage",
			);
		}

		let strict: ReturnType<typeof parseArgs>;
		try {
			strict = parseArgs({
				args,
				options: options(allowed),
				strict: true,
				allowPositionals: true,
			});
		} catch (error) {
			const said = (error as Error).message;
			const flag = said.match(/'(?:-\w, )?--([\w-]+)/)?.[1];
			const f = flag ? allowed[flag] : undefined;
			throw new CliError(
				f && f.type === "string"
					? `--${flag} needs a value: ${flagText(flag as string, f)}`
					: f
						? `--${flag} takes no value`
						: said,
				"usage",
			);
		}
		// The command's own flags, the built-in ones answered here and left out.
		const values = Object.fromEntries(
			Object.entries(strict.values)
				.filter(([k]) => !(k in BUILT_IN))
				.map(([k, v]) => [
					k,
					typeof v === "string"
						? stand(v)
						: Array.isArray(v)
							? v.map((x) => (typeof x === "string" ? stand(x) : x))
							: v,
				]),
		);
		const asked = {
			help: strict.values.help === true,
			version: strict.values.version === true,
		};

		if (asked.version)
			return {
				kind: "print",
				text: `${spec.version}\n`,
				data: { version: spec.version },
			};
		if (asked.help || name === "help") {
			const about = asked.help && name !== "help" ? name : rest[0];
			if (about === undefined)
				return { kind: "print", text: overview(), data: describe() };
			if (!(about in commands)) {
				const guess = nearest(about, Object.keys(commands));
				throw new CliError(
					`No command "${about}"${guess ? `: ${guess}?` : ""}. ${spec.name} help`,
					"usage",
				);
			}
			const data = (describe().commands as { name: string }[]).find(
				(c) => c.name === about,
			);
			return { kind: "print", text: detail(about), data };
		}

		const shape = argsOf(commands[name]?.args);
		const most = shape.at(-1)?.rest ? Number.POSITIVE_INFINITY : shape.length;
		const least = shape.filter((a) => a.needed).length;
		if (rest.length < least)
			throw new CliError(
				`${spec.name} ${name} needs ${shape
					.slice(rest.length)
					.filter((a) => a.needed)
					.map((a) => `<${a.name}>`)
					.join(" ")}: ${typed(name)}`,
				"usage",
			);
		if (rest.length > most)
			throw new CliError(
				shape.length
					? `${spec.name} ${name} takes ${commands[name]?.args}; "${rest[shape.length]}" is one too many`
					: `${spec.name} ${name} takes no arguments; "${rest[0]}" is one too many`,
				"usage",
			);
		shape.forEach((a, i) => {
			const given = a.rest ? rest.slice(i) : rest.slice(i, i + 1);
			for (const g of given)
				if (a.choices && !a.choices.includes(g))
					throw new CliError(
						`${spec.name} ${name}: "${g}" is not ${a.choices.join(", ")}`,
						"usage",
					);
		});

		return { kind: "run", command: name, args: rest, values } as Call<P>;
	}

	return {
		spec,
		parse,
		overview,
		detail: detail as Program<P>["detail"],
		describe,
	};
}
