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
import { CliError, emit } from "./run.js";
import { padEndV, ui, width } from "./text.js";

export interface FlagSpec {
	/** `integer` is a whole number, refused otherwise, its value a `number`. */
	readonly type: "boolean" | "string" | "integer";
	/** One character: `-d` for `--dir`. Grouped as typed: `-wo`, `-wd ~/x`. */
	readonly short?: string;
	/** The value as the help shows it, and nothing more: `<path>`. Absent, it is
	 *  the choices (`<credit|debit>`), `<n>` for an integer, else `<value>`. */
	readonly value?: string;
	readonly says: string;
	/** The only values a string flag takes, its type narrowed to them: pass the
	 *  domain's own array (`choices: FOLDERS`), so the flag cannot drift from it. */
	readonly choices?: readonly string[];
	/** Comma-separated (`--to a,b`), trimmed, empties dropped, each item checked
	 *  against `choices`; given again, it adds to the list. Typed as an array. */
	readonly list?: boolean;
	/** The command refuses to run without it, and its value is never undefined
	 *  (a flag with a value only). */
	readonly required?: boolean;
}

export type FlagSpecs = { readonly [name: string]: FlagSpec };

export interface CommandSpec {
	/**
	 * Its arguments as typed after its name, a usage grammar the parse counts:
	 * `<path> [name]`, `<words...>`. Each `<x>` must be given and each `[x]` may
	 * be; a last one ending in `...` takes the rest; `<on|off>` takes only those
	 * words. The handler's `args` is typed from it: `<x> [y]` is `[string,
	 * string?]`.
	 */
	readonly args?: string;
	/**
	 * The only values an argument takes, by its name in `args`, its type narrowed
	 * to them: pass the domain's own array (`choices: { light: LIGHTS }`) so the
	 * argument cannot drift from it. The parse refuses anything else, naming the
	 * nearest; the help lists them. `<on|off>` is the same, for fixed words.
	 */
	readonly choices?: { readonly [arg: string]: readonly string[] };
	/** One line: what it does, in the person's words. */
	readonly says: string;
	readonly flags?: FlagSpecs;
	/** What `help <command>` adds: how it behaves, what it refuses. */
	readonly more?: string;
	readonly examples?: readonly string[];
	/** What `--json` prints. */
	readonly json?: string;
	/**
	 * Other words it answers to (`msg` for `message`), shown beside it. Input only:
	 * the handler, the help, the JSON and every message name the command itself.
	 * Their cost is two spellings in scripts and docs, so examples and skills use
	 * the name; a shell alias or a fish abbr is often the better tool, as it
	 * expands to the name and history never sees the short one.
	 */
	readonly aliases?: readonly string[];
}

export interface ProgramSpec {
	readonly name: string;
	/**
	 * What a release is called, for a program that has releases: it answers
	 * `--version` and stands beside the name. A program run from its source has
	 * none to say, so it gives none and has no `--version`.
	 */
	readonly version?: string;
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
	/**
	 * The command a first word no command spells is given to, as its first
	 * argument, when `claims` holds for it: `hf-get owner/repo` runs `hf-get pull
	 * owner/repo`. A word it does not claim is a command misspelt, and so is a
	 * word it claims that is a slip of a command's name (`lss`): `claims` says
	 * what the default may take, never which mistakes it hides. The command keeps
	 * its name, the spelling for scripts and for a word the guard refuses.
	 */
	readonly default?: {
		readonly command: string;
		readonly claims: (word: string) => boolean;
	};
}

type One<S extends FlagSpec> = S["type"] extends "boolean"
	? boolean
	: S["type"] extends "integer"
		? number
		: S extends { readonly choices: infer C extends readonly string[] }
			? C[number]
			: string;
type ValueOf<S extends FlagSpec> = S["list"] extends true ? One<S>[] : One<S>;

type RequiredOf<F extends FlagSpecs> = {
	[K in keyof F]: F[K]["required"] extends true ? K : never;
}[keyof F];

/** A flag absent is `undefined`, never a default: the command says what absent
 *  means. A required flag is always there. */
export type ValuesOf<F extends FlagSpecs> = {
	-readonly [K in Exclude<keyof F, RequiredOf<F>>]?: ValueOf<F[K]>;
} & {
	-readonly [K in RequiredOf<F>]: ValueOf<F[K]>;
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

// `args` read at the type level the way argsOf reads it at run time: words split
// on spaces, `<x>` a value, `[x]` one that may be missing, a last `...` the rest,
// `a|b` and `choices` the value's words.
type Words<S extends string> = S extends `${infer A} ${infer B}`
	? A extends ""
		? Words<B>
		: [A, ...Words<B>]
	: S extends ""
		? []
		: [S];
type Bar<N extends string> = N extends `${infer A}|${infer B}` ? A | Bar<B> : N;
type ChoicesOf<C> = C extends {
	readonly choices: infer M extends {
		readonly [arg: string]: readonly string[];
	};
}
	? M
	: Record<never, never>;
type ArgValue<N extends string, M> = N extends keyof M
	? M[N] extends readonly (infer V extends string)[]
		? V
		: string
	: N extends `${string}|${string}`
		? Bar<N>
		: string;
// Every length the parse can hand over, one tuple each: `<x> [y]` is `[X] |
// [X, Y]`, which destructures with `y` possibly undefined and still passes as a
// `string[]` (an optional element `[Y?]` would not). Needed words first.
type Needed<W extends string[], M, Acc extends unknown[]> = W extends [
	infer H extends string,
	...infer T extends string[],
]
	? H extends `<${infer N}...>`
		? [...Acc, ArgValue<N, M>, ...ArgValue<N, M>[]]
		: H extends `[${infer N}...]`
			? [...Acc, ...ArgValue<N, M>[]]
			: H extends `<${infer N}>`
				? Needed<T, M, [...Acc, ArgValue<N, M>]>
				: H extends `[${infer N}]`
					? Optional<T, M, Acc, [...Acc, ArgValue<N, M>]>
					: string[]
	: Acc;
// Then words that may be missing, each length one more tuple. A needed word
// after one of them leaves the positions to the handler (`[who] <msgId>`: one
// word is the id), so the honest type is `string[]`.
type Optional<
	W extends string[],
	M,
	Shorter,
	Acc extends unknown[],
> = W extends [infer H extends string, ...infer T extends string[]]
	? H extends `[${infer N}...]`
		? Shorter | [...Acc, ...ArgValue<N, M>[]]
		: H extends `[${infer N}]`
			? Optional<T, M, Shorter | Acc, [...Acc, ArgValue<N, M>]>
			: string[]
	: Shorter | Acc;
/** A command's arguments as its `args` spells them: `<x> [y]` is `[string] | [string, string]`. */
export type ArgsOf<C> = C extends { readonly args: infer S extends string }
	? string extends S
		? string[]
		: Needed<Words<S>, ChoicesOf<C>, []>
	: [];

/** One command asked for: its name, its arguments and its flags, typed by its own spec. */
export type Call<P extends ProgramSpec> = {
	[K in Named<P>]: {
		kind: "run";
		command: K;
		args: ArgsOf<P["commands"][K]>;
		values: ValuesOf<FlagsOf<P["commands"][K]> & GlobalOf<P>>;
	};
}[Named<P>];

/** Something to print and nothing to run: the help, or the version. `data` is
 *  the same as JSON, for `--json`. */
export type Print = { kind: "print"; text: string; data: unknown };

/** One command's call, by its name. */
export type CallOf<P extends ProgramSpec, K extends Named<P>> = Extract<
	Call<P>,
	{ command: K }
>;

/** What runs each command: one handler per command, no more, each given its own
 *  call (its flags typed by its spec) and what `context` built for them all. */
export type Handlers<P extends ProgramSpec, Ctx = undefined> = {
	[K in Named<P>]: (call: CallOf<P, K>, ctx: Ctx) => void | Promise<void>;
};

export interface Program<P extends ProgramSpec> {
	readonly spec: P;
	/** `argv` read: the command asked for, or what to print instead. A mistake in
	 *  it throws `CliError` (code "usage") saying what to type. */
	parse(argv?: readonly string[]): Call<P> | Print;
	/**
	 * `argv` read and answered: help and the version printed (their data as JSON
	 * under `--json`), any other command given to its handler.
	 */
	run(handlers: Handlers<P>, argv?: readonly string[]): Promise<void>;
	/**
	 * What every handler shares (a session, a client), built once from the call
	 * and given to each as its second argument; never built for help or the
	 * version. A step of its own so its type is known before any handler is
	 * read.
	 */
	context<Ctx>(build: (call: Call<P>) => Ctx | Promise<Ctx>): {
		run(handlers: Handlers<P, Ctx>, argv?: readonly string[]): Promise<void>;
	};
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
const HELP_FLAG: FlagSpecs = {
	help: { type: "boolean", short: "h", says: "this help" },
};
const VERSION_FLAG: FlagSpecs = {
	version: { type: "boolean", says: "the version" },
};

type Arg = {
	name: string;
	needed: boolean;
	rest: boolean;
	/** The only words it takes: its `a|b` spelling, or the command's `choices`. */
	choices?: readonly string[];
};

/** `args` as the parse counts them, each with the words it takes. */
function argsOf(c: CommandSpec | undefined): Arg[] {
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

/** A flag's value as the help shows it: its `value`, else its choices, else its type's. */
const placeholderOf = (f: FlagSpec): string =>
	f.value ??
	(f.choices
		? `<${f.choices.join("|")}>`
		: f.type === "integer"
			? "<n>"
			: "<value>");

/** A flag as the help shows it: `-d, --dir <path>`, a list `--to <value>,…`. */
const flagText = (name: string, f: FlagSpec) =>
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

/** The edits from `a` to `b`, for "did you mean": a letter added, dropped or
 *  changed, or two neighbours swapped (`sned` → `send` is one edit, as a hand
 *  makes it). */
function distance(a: string, b: string): number {
	const d = Array.from({ length: a.length + 1 }, (_, i) =>
		Array.from({ length: b.length + 1 }, (_, j) =>
			i === 0 ? j : j === 0 ? i : 0,
		),
	);
	for (let i = 1; i <= a.length; i++)
		for (let j = 1; j <= b.length; j++) {
			const row = d[i] as number[];
			const up = d[i - 1] as number[];
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			row[j] = Math.min(
				(up[j] as number) + 1,
				(row[j - 1] as number) + 1,
				(up[j - 1] as number) + cost,
			);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
				row[j] = Math.min(
					row[j] as number,
					((d[i - 2] as number[])[j - 2] as number) + 1,
				);
		}
	return (d[a.length] as number[])[b.length] as number;
}

/** The word meant, where one is near enough to be a slip: one edit for a word of
 *  four letters or fewer, two for a longer one. A guess further off is noise
 *  (`-x` is two edits from `--on`). */
const nearest = (word: string, among: readonly string[]) =>
	among
		.map((w) => [w, distance(word, w)] as const)
		.filter(([, d]) => d <= (word.length <= 4 ? 1 : 2))
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
	const BUILT_IN: FlagSpecs =
		spec.version === undefined ? HELP_FLAG : { ...HELP_FLAG, ...VERSION_FLAG };
	for (const name of Object.keys(BUILT_IN))
		if (
			name in global ||
			Object.values(spec.commands).some((c) => c.flags && name in c.flags)
		)
			throw new Error(
				`cli: --${name} is built in, ${spec.name} cannot declare it`,
			);

	// Every word a command answers to, its name and its aliases, each meaning one.
	const canonical = new Map<string, string>();
	for (const [name, c] of Object.entries(commands)) {
		if (!/^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$/.test(name))
			throw new Error(
				`cli: command "${name}": words of lower case, digits and hyphens, one space apart`,
			);
		for (const word of [name, ...(c.aliases ?? [])]) {
			const had = canonical.get(word);
			if (had)
				throw new Error(
					`cli: ${spec.name}: "${word}" names both ${had} and ${name}`,
				);
			canonical.set(word, name);
		}
	}
	// A name may be words (`invoice create`): the leading words of argv spell the
	// longest one they can, so `invoice create` wins over `invoice` with an argument.
	const mostWords = Math.max(
		...[...canonical.keys()].map((k) => k.split(" ").length),
	);
	const spelled = (words: readonly string[]) => {
		for (let k = Math.min(words.length, mostWords); k >= 1; k--) {
			const name = canonical.get(words.slice(0, k).join(" "));
			if (name) return { name, rest: words.slice(k) };
		}
		return null;
	};

	if (spec.default) {
		const d = commands[spec.default.command];
		if (!d || spec.default.command === "help")
			throw new Error(
				`cli: ${spec.name}'s default is "${spec.default.command}", which it does not declare`,
			);
		if (argsOf(d).length === 0)
			throw new Error(
				`cli: ${spec.name} ${spec.default.command} is the default, so it takes the word as an argument: give it args`,
			);
	}

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
		argsOf(c);
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
			if (
				f.type === "boolean" &&
				(f.value || f.list || f.required || f.choices)
			)
				throw new Error(
					`cli: --${name}: a boolean flag takes no value, list, choices or required`,
				);
			if (f.choices && f.type !== "string")
				throw new Error(`cli: --${name}: only a string flag has choices`);
			if (f.choices?.length === 0)
				throw new Error(`cli: --${name}: choices names nothing`);
			// The first reading of argv must know, for any command, whether a flag
			// takes a value and which letter it is; whether that value is a list, or
			// which words it takes, is each command's own (`ls --to` one address,
			// `send --to` the recipients).
			const seen = every[name];
			if (seen && (seen.type !== f.type || seen.short !== f.short))
				throw new Error(
					`cli: --${name} is spelled two ways (${command} and another): one type, one short letter`,
				);
			every[name] = seen?.list ? seen : f;
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
		// Words an argument takes that its usage does not show (`<light>`, not `<a|b>`).
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

		// An integer reaches parseArgs as a string and is read as a number after.
		const options = (flags: FlagSpecs) =>
			Object.fromEntries(
				Object.entries(flags).map(([n, f]) => [
					n,
					{
						type:
							f.type === "boolean" ? ("boolean" as const) : ("string" as const),
						...(f.short && { short: f.short }),
						...(f.list && { multiple: true }),
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
		// A word no command answers: the nearest spelling where one is near, with
		// the default's reading when it claims the word too; else what the word
		// is not, the default's argument named, and where the list is.
		const noCommand = (word: string) => {
			const guess = nearest(word, Object.keys(commands));
			const d = spec.default;
			if (guess)
				return new CliError(
					`No command "${word}": ${spec.name} ${guess}?${d?.claims(word) ? `, or ${spec.name} ${d.command} ${word}` : ""}`,
					"usage",
				);
			const takes = d && argsOf(commands[d.command])[0]?.name;
			return new CliError(
				takes
					? `"${word}" is no command and no <${takes}>: ${spec.name} help`
					: `No command "${word}": ${spec.name} help`,
				"usage",
			);
		};
		const words = loose.positionals.map(stand);
		const first = words[0];
		const found =
			spelled(words.length ? words : ["help"]) ??
			(spec.default &&
			first !== undefined &&
			spec.default.claims(first) &&
			!nearest(first, Object.keys(commands))
				? { name: spec.default.command, rest: words }
				: null);
		if (!found) throw noCommand(first as string);
		const { name, rest } = found;
		// Under a command with actions (`invoice create`), an argument a typo away
		// from an action is the action misspelt, never a value: run as one, `bank
		// invoice crate` looked up an invoice named "crate" and asked for credentials.
		const actions = Object.keys(commands)
			.filter(
				(n) =>
					n.startsWith(`${name} `) && !n.slice(name.length + 1).includes(" "),
			)
			.map((n) => n.slice(name.length + 1));
		const meant = rest[0] === undefined ? undefined : nearest(rest[0], actions);
		if (meant)
			throw new CliError(
				`${spec.name} ${name} ${rest[0]}: no such action — ${spec.name} ${name} ${meant}?`,
				"usage",
			);

		const allowed = flagsOf(name);
		// No command typed reads as `help`, which the person never said: a flag
		// is then refused by the program, and the list is `help`.
		const typedName = words.length ? `${spec.name} ${name}` : spec.name;
		const list = words.length
			? `${spec.name} help ${name}`
			: `${spec.name} help`;
		for (const t of loose.tokens) {
			if (t.kind !== "option" || t.name in allowed) continue;
			const said = t.rawName;
			const whose = owners[t.name];
			if (whose)
				throw new CliError(
					`${said} is not a flag of ${typedName}: it is ${whose.map((w) => `${spec.name} ${w}`).join(", ")}'s`,
					"usage",
				);
			if (t.name === "version" && spec.version === undefined)
				throw new CliError(
					`${spec.name} has no version: it runs from its source, never released`,
					"usage",
				);
			const guess = nearest(t.name, Object.keys(allowed));
			throw new CliError(
				`${said} is no flag of ${typedName}: ${guess ? `--${guess}?` : list}`,
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
				f && f.type !== "boolean"
					? `--${flag} needs a value: ${flagText(flag as string, f)}`
					: f
						? `--${flag} takes no value`
						: said,
				"usage",
			);
		}
		// One value as its spec reads it: a whole number for an integer, one of
		// its words where a string flag names them.
		const read = (flag: string, raw: string | boolean): unknown => {
			if (typeof raw === "boolean") return raw;
			const s = stand(raw);
			const f = allowed[flag] as FlagSpec;
			if (f.type === "integer") {
				if (!/^-?\d+$/.test(s))
					throw new CliError(
						`--${flag} takes a whole number, not "${s}"`,
						"usage",
					);
				return Number(s);
			}
			if (f.choices && !f.choices.includes(s))
				throw new CliError(
					`--${flag}: "${s}" is not ${f.choices.join(", ")}`,
					"usage",
				);
			return s;
		};
		// A list's every item, from each time it was given: `--to a,b --to c`.
		const items = (given: unknown[]) =>
			given.flatMap((g) =>
				String(g)
					.split(",")
					.map((x) => x.trim())
					.filter(Boolean),
			);
		// The command's own flags, the built-in ones answered here and left out.
		const values = Object.fromEntries(
			Object.entries(strict.values)
				.filter(([k]) => !(k in BUILT_IN))
				.map(([k, v]) => [
					k,
					Array.isArray(v)
						? items(v).map((x) => read(k, x))
						: read(k, v as string | boolean),
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
			if (!(asked.help && name !== "help") && rest.length === 0)
				return { kind: "print", text: overview(), data: describe() };
			const about = asked.help && name !== "help" ? name : spelled(rest)?.name;
			if (about === undefined) throw noCommand(rest[0] as string);
			const data = (describe().commands as { name: string }[]).find(
				(c) => c.name === about,
			);
			return { kind: "print", text: detail(about), data };
		}

		const shape = argsOf(commands[name]);
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
		// Each value against the words its argument takes; the rest argument's
		// words hold for every value it collects.
		rest.forEach((value, i) => {
			const a = shape[Math.min(i, shape.length - 1)];
			if (!a?.choices || a.choices.includes(value)) return;
			const guess = nearest(value, a.choices);
			throw new CliError(
				`"${value}" is no <${a.name}> of ${spec.name} ${name}: ${guess ? `${guess}?` : a.choices.join(", ")}`,
				"usage",
			);
		});
		for (const [flag, f] of Object.entries(allowed))
			if (f.required && !(flag in values))
				throw new CliError(
					`${spec.name} ${name} needs ${flagText(flag, f)}: ${f.says}`,
					"usage",
				);
		return { kind: "run", command: name, args: rest, values } as Call<P>;
	}

	/** The one dispatch `run` and `context(…).run` share. */
	async function answer(
		handlers: object,
		argv: readonly string[],
		build: ((call: Call<P>) => unknown) | undefined,
	): Promise<void> {
		// The handlers are the commands: one each, none for a command that is not.
		const named = Object.keys(spec.commands);
		const given = Object.keys(handlers);
		const missing = named.filter((n) => !given.includes(n));
		const extra = given.filter((n) => !named.includes(n));
		if (missing.length || extra.length)
			throw new Error(
				`cli: ${spec.name}'s handlers: ${[
					missing.length && `none for ${missing.join(", ")}`,
					extra.length && `${extra.join(", ")} is no command`,
				]
					.filter(Boolean)
					.join("; ")}`,
			);
		const call = parse(argv);
		if (call.kind === "print")
			return emit(argv.includes("--json"), call.data, () =>
				process.stdout.write(call.text),
			);
		const ctx = build ? await build(call) : undefined;
		// A call and its handler name one command; TypeScript cannot follow a
		// union through an index, so the pairing is this one line's.
		const handler = (handlers as Record<string, unknown>)[call.command] as (
			c: Call<P>,
			x: unknown,
		) => void | Promise<void>;
		await handler(call, ctx);
	}

	const argvOf = (argv: readonly string[] | undefined) =>
		argv ?? process.argv.slice(2);

	return {
		spec,
		parse,
		run: (handlers, argv) => answer(handlers, argvOf(argv), undefined),
		context: (build) => ({
			run: (handlers, argv) => answer(handlers, argvOf(argv), build),
		}),
		overview,
		detail: detail as Program<P>["detail"],
		describe,
	};
}
