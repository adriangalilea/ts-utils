/**
 * `cli/command`: a command-line program described once, as data, and everything
 * a person meets read from that one table: the parse (one pass over argv, so
 * `-wo` groups, `--dir=x` and `--` work), the refusals (a flag the command does
 * not take, an argument too few or too many, counted from its `args`), the
 * values' types, and the help (`--help`, `help <command>`, `help --json`). A
 * flag cannot exist without its words, nor its words without the flag.
 *
 * The pieces are their own modules: `tokens` reads argv, `grammar` reads
 * `args`, `help` writes what a person reads, `words` guesses what they meant.
 * This one holds the spec's types, checks the spec as the program starts, and
 * turns tokens into a call.
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

import { argsOf } from "./grammar.js";
import { flagText, helpOf } from "./help.js";
import { beforeDash, CliError, emit, USAGE_EXIT } from "./run.js";
import { skillOf } from "./skill.js";
import { tokenize } from "./tokens.js";
import { nearest } from "./words.js";

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
	 * words. The handler's `args` is typed from it: `<x> [y]` is `[string] |
	 * [string, string]`.
	 */
	readonly args?: string;
	/**
	 * The only values an argument takes, by its name in `args`, its type narrowed
	 * to them: pass the domain's own array (`choices: { env: ENVS }`) so the
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
	 * What follows `--` is the command's own, handed over untouched as
	 * `call.passthrough` (`--help` and `--json` in it never read), and the usage
	 * shows it: `"command [args…]"` reads `ship run -- command [args…]`. A
	 * command without it takes what follows `--` as arguments.
	 */
	readonly passthrough?: string;
	/** The program's declared exits (`ProgramSpec.exits`) this command can end
	 *  with, by code; its help lists them. 0, 1 and 64 go without saying. */
	readonly exits?: readonly number[];
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
	/**
	 * The statuses it ends with beyond the three every program has (0 done, 1
	 * anything else, 64 a wrong call), by code: `{ 77: "you refused" }`. A
	 * handler returns one, a `CliError` carries one (`exit`); the overview, each
	 * command's help and the skill say them all.
	 */
	readonly exits?: { readonly [code: number]: string };
	/** Prose a person reads on request, `help <name>`, listed in the overview and
	 *  inlined in the skill. */
	readonly guides?: { readonly [name: string]: Guide };
	/**
	 * The program offering itself to agents: `skill` says whether Claude Code's
	 * and Codex's copy is current, `skill show` prints it (rendered from this
	 * spec, so it says nothing the help does not), `skill install` writes it,
	 * `skill remove` takes it out. `useWhen` and `never` lead its description and
	 * stand under the overview's title.
	 */
	readonly skill?: {
		readonly useWhen: readonly string[];
		readonly never?: readonly string[];
	};
}

/**
 * A guide: a title, one line for the overview, and a body in Markdown of a
 * small subset (paragraphs, `- ` bullets, inline code, fenced blocks), folded
 * for a terminal and inlined as written in the skill.
 */
export interface Guide {
	readonly title: string;
	readonly says: string;
	readonly body: string;
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

/** What follows `--`, for a command that passes it through: nothing for one that does not. */
export type PassthroughOf<C> = C extends { readonly passthrough: string }
	? string[]
	: [];

/** One command asked for: its name, its arguments, what follows `--` (its
 *  `passthrough`) and its flags, typed by its own spec. */
export type Call<P extends ProgramSpec> = {
	[K in Named<P>]: {
		kind: "run";
		command: K;
		args: ArgsOf<P["commands"][K]>;
		passthrough: PassthroughOf<P["commands"][K]>;
		values: ValuesOf<FlagsOf<P["commands"][K]> & GlobalOf<P>>;
	};
}[Named<P>];

/** Something to print and nothing to run: the help, a guide, or the version.
 *  `data` is the same as JSON, for `--json`. */
export type Print = { kind: "print"; text: string; data: unknown };

/** The skill asked for (a program with `skill`): `run` answers it with
 *  `skill(action)`; a program that routes its own calls does the same. */
export type SkillCall = {
	kind: "skill";
	action: "status" | "show" | "install" | "remove";
};

/** A skill call, for a program with a `skill`; none for one without. */
export type SkillOf<P extends ProgramSpec> = P extends {
	readonly skill: object;
}
	? SkillCall
	: never;

/** One command's call, by its name. */
export type CallOf<P extends ProgramSpec, K extends Named<P>> = Extract<
	Call<P>,
	{ command: K }
>;

/** What runs each command: one handler per command, no more, each given its own
 *  call (its flags typed by its spec) and what `context` built for them all. A
 *  handler may return the status it ends with: 0, or one of its `exits`. */
export type Handlers<P extends ProgramSpec, Ctx = undefined> = {
	[K in Named<P>]: Handler<CallOf<P, K>, Ctx>;
};

/** One handler: it ends the command with nothing to say (status 0) or with a
 *  status, now or once it resolves. */
export type Handler<C, Ctx> =
	| ((call: C, ctx: Ctx) => void)
	| ((call: C, ctx: Ctx) => Promise<void>)
	| ((call: C, ctx: Ctx) => number)
	| ((call: C, ctx: Ctx) => Promise<number>);

export interface Program<P extends ProgramSpec> {
	readonly spec: P;
	/** `argv` read: the command asked for, what to print instead, or the skill.
	 *  A mistake in it throws `CliError` (code "usage", exit 64) saying what to
	 *  type. */
	parse(argv?: readonly string[]): Call<P> | Print | SkillOf<P>;
	/**
	 * `argv` read and answered: help, guides and the version printed (their data
	 * as JSON under `--json`), the skill answered, any other command given to its
	 * handler, the status it returns the program's.
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
	/** One guide, as `help <guide>` prints it. */
	guide(name: string): string;
	/** Every command as data: what `help --json` prints. */
	describe(): unknown;
	/** The skill as agents read it (a program with `skill`). */
	skillMarkdown(): string;
	/** A skill call answered: what to print. Throws `CliError` when a file could
	 *  not be written or removed. */
	skill(action: SkillCall["action"]): string;
}

const HELP: CommandSpec = {
	args: "[command]",
	says: "these words, one command's in full, or a guide",
	more: "With --json, every command as data: its arguments, flags, words and what its --json prints.",
};
const SKILL: { readonly [name: string]: CommandSpec } = {
	skill: { says: "whether Claude Code's and Codex's skill is this program's" },
	"skill show": { says: "the skill, as agents read it" },
	"skill install": { says: "write the skill for Claude Code and Codex" },
	"skill remove": { says: "take the skill out of Claude Code and Codex" },
};
const BUILT_IN_EXITS: { readonly [code: number]: string } = {
	0: "done",
	1: "anything else",
	[USAGE_EXIT]: "a wrong call",
};
const HELP_FLAG: FlagSpecs = {
	help: { type: "boolean", short: "h", says: "this help" },
};
const VERSION_FLAG: FlagSpecs = {
	version: { type: "boolean", says: "the version" },
};

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
		...(spec.skill ? SKILL : {}),
	};
	for (const name of ["help", ...(spec.skill ? Object.keys(SKILL) : [])])
		if (name in spec.commands)
			throw new Error(
				`cli: "${name}" is built in, ${spec.name} cannot declare it`,
			);

	// The exits: declared beyond the three every program has, each with its
	// words, and a command ends only with the program's.
	const exits: Record<number, string> = { ...BUILT_IN_EXITS };
	for (const [key, says] of Object.entries(spec.exits ?? {})) {
		const code = Number(key);
		if (
			!Number.isInteger(code) ||
			code < 2 ||
			code > 255 ||
			code === USAGE_EXIT
		)
			throw new Error(
				`cli: ${spec.name}'s exit ${key}: a status from 2 to 255, never 64 (a wrong call, built in)`,
			);
		if (!says) throw new Error(`cli: ${spec.name}'s exit ${code} says nothing`);
		exits[code] = says;
	}
	for (const [name, c] of Object.entries(spec.commands))
		for (const code of c.exits ?? [])
			if (!(code in exits) || code in BUILT_IN_EXITS)
				throw new Error(
					`cli: ${spec.name} ${name} exits ${code}, which ${spec.name}'s exits do not declare`,
				);
	for (const [name, g] of Object.entries(spec.guides ?? {})) {
		if (!/^[a-z][a-z0-9-]*$/.test(name))
			throw new Error(`cli: guide "${name}": lower case, digits and hyphens`);
		if (
			name in commands ||
			Object.values(commands).some((c) => c.aliases?.includes(name))
		)
			throw new Error(
				`cli: guide "${name}" is also a command: help ${name} would mean both`,
			);
		if (!g.title || !g.says || !g.body)
			throw new Error(`cli: guide "${name}" needs a title, a line and a body`);
	}
	if (spec.skill && spec.skill.useWhen.length === 0)
		throw new Error(
			`cli: ${spec.name}'s skill says nothing it is for (useWhen)`,
		);
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
	// Every flag of every command, one spelling each: argv is read before the
	// command is known, so it is read against them all.
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
			// Reading argv must know, for any command, whether a flag takes a value
			// and which letter it is; whether that value is a list, or which words
			// it takes, is each command's own (`ls --to` one address, `send --to`
			// the recipients).
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
	// command, so reading argv never has to guess.
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

	const { typed, overview, detail, guide, describe } = helpOf({
		spec,
		commands,
		global,
		sections,
		exits,
	});
	const skill = skillOf({ spec, commands, global, sections, exits });

	function parse(
		argv: readonly string[] = process.argv.slice(2),
	): Call<P> | Print | SkillOf<P> {
		const tokens = tokenize(argv, every, shortOf);

		// A word no command answers: a guide's name said where `help` belongs; the
		// nearest spelling where one is near, with the default's reading when it
		// claims the word too; else what the word is not, the default's argument
		// named, and where the list is.
		const noCommand = (word: string) => {
			if (spec.guides && word in spec.guides)
				return new CliError(
					`"${word}" is a guide: ${spec.name} help ${word}`,
					"usage",
				);
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
		// The command is named before `--`; what follows is its passthrough when
		// it has one, else more of its arguments. Named only after it, every word
		// is a word.
		const said = tokens.flatMap((t) =>
			t.kind === "word" && !t.passed ? [t.value] : [],
		);
		const passed = tokens.flatMap((t) =>
			t.kind === "word" && t.passed ? [t.value] : [],
		);
		const words = said.length ? said : passed;
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
		const { name } = found;
		const passthrough: string[] = [];
		const rest = [...found.rest];
		if (said.length) {
			if (commands[name]?.passthrough !== undefined)
				passthrough.push(...passed);
			else rest.push(...passed);
		}
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
		const flags = tokens.flatMap((t) => (t.kind === "flag" ? [t] : []));
		// No command typed reads as `help`, which the person never said: a flag
		// is then refused by the program, and the list is `help`.
		const typedName = words.length ? `${spec.name} ${name}` : spec.name;
		const list = words.length
			? `${spec.name} help ${name}`
			: `${spec.name} help`;
		// A flag this command does not take: whose it is, or the nearest it takes.
		for (const t of flags) {
			if (t.name in allowed) continue;
			const whose = owners[t.name];
			if (whose)
				throw new CliError(
					`${t.said} is not a flag of ${typedName}: it is ${whose.map((w) => `${spec.name} ${w}`).join(", ")}'s`,
					"usage",
				);
			if (t.name === "version" && spec.version === undefined)
				throw new CliError(
					`${spec.name} has no version: it runs from its source, never released`,
					"usage",
				);
			const guess = nearest(t.name, Object.keys(allowed));
			throw new CliError(
				`${t.said} is no flag of ${typedName}: ${guess ? `--${guess}?` : list}`,
				"usage",
			);
		}
		// Its own flags, each with what it needs: a value given or none.
		for (const t of flags) {
			const f = allowed[t.name] as FlagSpec;
			if (t.missing)
				throw new CliError(
					`--${t.name} needs a value: ${flagText(t.name, f)}`,
					"usage",
				);
			if (t.extra) throw new CliError(`--${t.name} takes no value`, "usage");
		}

		// One value as its spec reads it: a whole number for an integer, one of
		// its words where a string flag names them.
		const read = (flag: string, s: string): unknown => {
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
		// The command's own flags, the built-in ones answered here and left out. A
		// list gathers every item from each time it was given (`--to a,b --to c`);
		// any other flag given twice keeps its last value.
		const values: Record<string, unknown> = {};
		const asked = { help: false, version: false };
		for (const t of flags) {
			if (t.name === "help" || t.name === "version") {
				asked[t.name] = true;
				continue;
			}
			const f = allowed[t.name] as FlagSpec;
			if (f.type === "boolean") values[t.name] = true;
			else if (f.list)
				values[t.name] = [
					...((values[t.name] as unknown[] | undefined) ?? []),
					...(t.value ?? "")
						.split(",")
						.map((x) => x.trim())
						.filter(Boolean)
						.map((x) => read(t.name, x)),
				];
			else values[t.name] = read(t.name, t.value ?? "");
		}

		if (asked.version)
			return {
				kind: "print",
				text: `${spec.version}\n`,
				data: { version: spec.version },
			};
		if (asked.help || name === "help") {
			if (!(asked.help && name !== "help") && rest.length === 0)
				return { kind: "print", text: overview(), data: describe() };
			const topic = rest[0] as string;
			if (
				name === "help" &&
				rest.length === 1 &&
				spec.guides &&
				topic in spec.guides
			)
				return {
					kind: "print",
					text: guide(topic),
					data: { guide: topic, ...spec.guides[topic] },
				};
			const about = asked.help && name !== "help" ? name : spelled(rest)?.name;
			if (about === undefined) throw noCommand(rest[0] as string);
			const data = (describe().commands as { name: string }[]).find(
				(c) => c.name === about,
			);
			return { kind: "print", text: detail(about), data };
		}
		if (name === "skill" || name.startsWith("skill ")) {
			if (rest.length)
				throw new CliError(
					`${spec.name} ${name} takes no arguments; "${rest[0]}" is one too many`,
					"usage",
				);
			const action = name === "skill" ? "status" : name.slice("skill ".length);
			// Only a program with a skill has these commands to spell.
			return {
				kind: "skill",
				action: action as SkillCall["action"],
			} as SkillOf<P>;
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
		return {
			kind: "run",
			command: name,
			args: rest,
			passthrough,
			values,
		} as Call<P>;
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
			return emit(beforeDash(argv).includes("--json"), call.data, () =>
				process.stdout.write(call.text),
			);
		if (call.kind === "skill") {
			process.stdout.write(skill.answer(call.action));
			return;
		}
		const ctx = build ? await build(call) : undefined;
		// A call and its handler name one command; TypeScript cannot follow a
		// union through an index, so the pairing is this one line's.
		const handler = (handlers as Record<string, unknown>)[call.command] as (
			c: Call<P>,
			x: unknown,
		) => unknown;
		const status = await handler(call, ctx);
		if (status === undefined || status === 0) return;
		if (typeof status !== "number")
			throw new Error(
				`cli: ${spec.name} ${call.command}'s handler returned ${String(status)}: nothing, or a status`,
			);
		// A status the command did not declare is the program's bug, never the
		// person's: its help would have lied about how it ends.
		if (!commands[call.command]?.exits?.includes(status))
			throw new Error(
				`cli: ${spec.name} ${call.command} returned ${status}, which its exits do not list`,
			);
		process.exitCode = status;
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
		guide,
		describe,
		skillMarkdown: skill.markdown,
		skill: skill.answer,
	};
}
