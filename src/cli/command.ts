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
	/** The value as the help shows it: `<path>`. Words with bars, `<asc|desc>`,
	 *  are the only values a string flag takes. */
	readonly value?: string;
	readonly says: string;
	/** Given again, every value kept in order (a flag with a value only). */
	readonly multiple?: boolean;
	/** The command refuses to run without it, and its value is never undefined
	 *  (a flag with a value only). */
	readonly required?: boolean;
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
	/** Shorter names it answers to (`msg` for `message`), shown beside it. */
	readonly aliases?: readonly string[];
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

type One<S extends FlagSpec> = S["type"] extends "boolean"
	? boolean
	: S["type"] extends "integer"
		? number
		: string;
type ValueOf<S extends FlagSpec> = S["multiple"] extends true
	? One<S>[]
	: One<S>;

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
	`${f.short ? `-${f.short}, ` : ""}--${name}${
		f.type === "boolean"
			? ""
			: ` ${f.value ?? (f.type === "integer" ? "<n>" : "<value>")}`
	}`;

/** The only values a string flag takes, where its `value` names them: `<a|b>`. */
const choicesOf = (f: FlagSpec): string[] | null => {
	const m = f.type === "string" ? f.value?.match(/^<([^<>]+\|[^<>]+)>$/) : null;
	return m ? (m[1] as string).split("|") : null;
};

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

	// Every word a command answers to, its name and its aliases, each meaning one.
	const canonical = new Map<string, string>();
	for (const [name, c] of Object.entries(commands))
		for (const word of [name, ...(c.aliases ?? [])]) {
			const had = canonical.get(word);
			if (had)
				throw new Error(
					`cli: ${spec.name}: "${word}" names both ${had} and ${name}`,
				);
			canonical.set(word, name);
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
			if (f.multiple && f.type === "boolean")
				throw new Error(
					`cli: --${name}: only a flag with a value is given again`,
				);
			if (f.type === "boolean" && f.value !== undefined)
				throw new Error(`cli: --${name}: a boolean flag takes no value`);
			if (f.type === "boolean" && f.required)
				throw new Error(`cli: --${name}: a boolean flag is never required`);
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

	// A command as typed: `discord message|msg <ref>`, its aliases quiet beside it.
	const usageOf = (name: string) => {
		const c = commands[name];
		const aliases = c?.aliases?.length
			? ui.muted(`|${c.aliases.join("|")}`)
			: "";
		return `${ui.muted(spec.name)} ${ui.head(name)}${aliases}${c?.args ? ` ${ui.muted(c.args)}` : ""}`;
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
							([n, f]) =>
								`    ${padEndV(flagText(n, f), column)}${f.says}${f.required ? ui.muted(" (required)") : ""}`,
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
				...(c.aliases?.length && { aliases: c.aliases }),
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

		// An integer reaches parseArgs as a string and is read as a number after.
		const options = (flags: FlagSpecs) =>
			Object.fromEntries(
				Object.entries(flags).map(([n, f]) => [
					n,
					{
						type:
							f.type === "boolean" ? ("boolean" as const) : ("string" as const),
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
		// A word no command answers: the nearest spelling where one is near, else
		// where the list is.
		const noCommand = (word: string) => {
			const guess = nearest(word, Object.keys(commands));
			return new CliError(
				`No command "${word}": ${guess ? `${spec.name} ${guess}?` : `${spec.name} help`}`,
				"usage",
			);
		};
		const [named, ...rest] = loose.positionals.map(stand);
		const name = canonical.get(named ?? "help");
		if (name === undefined) throw noCommand(named as string);

		const allowed = flagsOf(name);
		for (const t of loose.tokens) {
			if (t.kind !== "option" || t.name in allowed) continue;
			const said = t.rawName;
			const whose = owners[t.name];
			throw new CliError(
				whose
					? `${said} is not a flag of ${spec.name} ${name}: it is ${whose.map((w) => `${spec.name} ${w}`).join(", ")}'s`
					: `${said} is no flag of ${spec.name} ${name}: ${(() => {
							const guess = nearest(t.name, Object.keys(allowed));
							return guess ? `--${guess}?` : `${spec.name} help ${name}`;
						})()}`,
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
			const choices = choicesOf(f);
			if (choices && !choices.includes(s))
				throw new CliError(
					`--${flag}: "${s}" is not ${choices.join(", ")}`,
					"usage",
				);
			return s;
		};
		// The command's own flags, the built-in ones answered here and left out.
		const values = Object.fromEntries(
			Object.entries(strict.values)
				.filter(([k]) => !(k in BUILT_IN))
				.map(([k, v]) => [
					k,
					Array.isArray(v)
						? v.map((x) => read(k, x as string | boolean))
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
			const asking = asked.help && name !== "help" ? name : rest[0];
			if (asking === undefined)
				return { kind: "print", text: overview(), data: describe() };
			const about = canonical.get(asking);
			if (about === undefined) throw noCommand(asking);
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
		for (const [flag, f] of Object.entries(allowed))
			if (f.required && !(flag in values))
				throw new CliError(
					`${spec.name} ${name} needs ${flagText(flag, f)}: ${f.says}`,
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
