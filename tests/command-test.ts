/**
 * Assert-based checks for `cli/command` and the time vocabulary under
 * `cli/watch`: what a person types, read the way every CLI built on it reads it.
 *
 *   pnpm test:command
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { CliError, program } from "../src/cli/index.js";
import { stripAnsi } from "../src/universal/ansi.js";
import { localDay, parseDeadline, parseWhen } from "../src/universal/time.js";

/** A domain's own words, as a consumer keeps them. */
const FOLDERS = ["inbox", "junk", "trash"] as const;

const eid = program({
	name: "eid",
	version: "1.2.3",
	says: "your e-ID from a terminal",
	about: ["also 👤"],
	global: { json: { type: "boolean", says: "the answer as JSON" } },
	commands: {
		send: {
			args: "<path> [name]",
			says: "send a file",
			flags: {
				to: {
					type: "string",
					short: "t",
					value: "<people>",
					says: "only for them",
				},
				self: { type: "boolean", short: "s", says: "for you" },
			},
			examples: ["eid send notes.zip"],
			json: "SendMade",
		},
		inbox: {
			says: "what is waiting",
			flags: {
				watch: { type: "boolean", short: "w", says: "wait for sends" },
				once: { type: "boolean", short: "o", says: "end at the first" },
				dir: { type: "string", short: "d", value: "<path>", says: "where" },
			},
		},
		set: { args: "<what> <value...>", says: "change your card" },
		vouches: { args: "<on|off>", says: "let people vouch" },
		bday: {
			args: "<who> <day>",
			says: "a birthday",
			flags: { one: { type: "boolean", short: "1", says: "best only" } },
		},
		ls: {
			says: "your links",
			flags: {
				limit: { type: "integer", says: "at most" },
				order: { type: "string", choices: ["new", "old"], says: "which first" },
				tag: { type: "string", value: "<t>", list: true, says: "tagged" },
				days: { type: "integer", list: true, says: "days" },
				folder: {
					type: "string",
					value: "<folder>",
					choices: FOLDERS,
					list: true,
					says: "only these",
				},
			},
		},
	},
	sections: [
		["files", ["send", "inbox", "ls"]],
		["card", ["set", "vouches", "bday", "help"]],
	],
	env: [["EID_URL", "another e-ID"]],
	foot: "the API: e-id.to/api",
});

const run = (...argv: string[]) => {
	const call = eid.parse(argv);
	assert.equal(call.kind, "run", `${argv.join(" ")} should run`);
	return call as Exclude<typeof call, { kind: "print" }>;
};
const refused = (argv: string[], like: RegExp) =>
	assert.throws(
		() => eid.parse(argv),
		(e: unknown) =>
			e instanceof CliError && e.code === "usage" && like.test(e.message),
		`${argv.join(" ")} should be refused like ${like}`,
	);
/** The same refusal, for any program. */
const refused2 = (
	p: { parse(a: string[]): unknown },
	argv: string[],
	like: RegExp,
) =>
	assert.throws(
		() => p.parse(argv),
		(e: unknown) =>
			e instanceof CliError && e.code === "usage" && like.test(e.message),
		`${argv.join(" ")} should be refused like ${like}`,
	);

// grouping, values glued or spaced, --x=v, flags anywhere, -- ends the flags
{
	const c = run("inbox", "-wo");
	assert.equal(c.command, "inbox");
	if (c.command === "inbox")
		assert.deepEqual(c.values, { watch: true, once: true });
	const d = run("inbox", "-wod", "/x");
	if (d.command === "inbox")
		assert.deepEqual(d.values, { watch: true, once: true, dir: "/x" });
	const e = run("inbox", "-wd/x");
	if (e.command === "inbox") assert.equal(e.values.dir, "/x");
	const f = run("send", "a.txt", "--to=ada,bob", "--json");
	if (f.command === "send")
		assert.deepEqual(f.values, { to: "ada,bob", json: true });
	assert.deepEqual(f.args, ["a.txt"]);
	const g = run("--json", "send", "a.txt", "-s");
	if (g.command === "send")
		assert.deepEqual(g.values, { json: true, self: true });
	assert.deepEqual(run("send", "--", "--odd").args, ["--odd"]);
	// each command's values are its own flags and the global ones, typed
	if (g.command === "send") {
		const to: string | undefined = g.values.to;
		const json: boolean | undefined = g.values.json;
		// @ts-expect-error --watch is inbox's, never send's
		g.values.watch;
		void [to, json];
	}
}

// a flag of another command, a flag of none (with a guess), a value missing
refused(
	["send", "x", "--watch"],
	/--watch is not a flag of eid send: it is eid inbox's/,
);
refused(["inbox", "--wach"], /^--wach is no flag of eid inbox: --watch\?$/);
refused(
	["inbox", "--zzzzzz"],
	/^--zzzzzz is no flag of eid inbox: eid help inbox$/,
);
// a guess only for a slip: one edit in a short word, a swap counting as one
refused(["inbox", "-x"], /^-x is no flag of eid inbox: eid help inbox$/);
refused(["sned"], /^No command "sned": eid send\?$/);
refused(["inbox", "--wacth"], /--watch\?$/);
refused(["inbox", "--dir"], /--dir needs a value: -d, --dir <path>/);
refused(["inbox", "--watch=yes"], /--watch takes no value/);

// arguments counted from `args`
refused(["send"], /eid send needs <path>: eid send <path> \[name\]/);
refused(
	["send", "a", "b", "c"],
	/eid send takes <path> \[name\]; "c" is one too many/,
);
refused(["inbox", "x"], /eid inbox takes no arguments; "x" is one too many/);
assert.deepEqual(run("set", "bio", "hello", "there").args, [
	"bio",
	"hello",
	"there",
]);
// args are shape only: what a value may be is the handler's
assert.deepEqual(run("vouches", "maybe").args, ["maybe"]);

// a command that does not exist, with a guess
refused(["sned"], /^No command "sned": eid send\?$/);
refused(["zzzzzz"], /^No command "zzzzzz": eid help$/);

// a dash and a digit is an argument unless a flag spells it
{
	const c = run("bday", "ada", "--09-29");
	assert.deepEqual(c.args, ["ada", "--09-29"]);
	const d = run("bday", "ada", "2026-01-01", "-1");
	if (d.command === "bday") assert.equal(d.values.one, true);
	const e = run("set", "balance", "-5");
	assert.deepEqual(e.args, ["balance", "-5"]);
}

// integers are numbers, a flag's named words are its only values, repeated
// flags keep every value in order
{
	const c = run(
		"ls",
		"--limit",
		"20",
		"--order=old",
		"--tag",
		"a",
		"--tag",
		"b",
	);
	if (c.command === "ls") {
		assert.deepEqual(c.values, { limit: 20, order: "old", tag: ["a", "b"] });
		const n: number | undefined = c.values.limit;
		const tags: string[] | undefined = c.values.tag;
		void [n, tags];
	}
	const d = run("ls", "--limit", "-5", "--days", "3,4", "--days", "7");
	if (d.command === "ls")
		assert.deepEqual(d.values, { limit: -5, days: [3, 4, 7] });
	// a list is commas and repeats alike, trimmed, empties dropped, each checked
	const e = run("ls", "--folder", "inbox, junk,", "--folder", "trash");
	if (e.command === "ls") {
		assert.deepEqual(e.values.folder, ["inbox", "junk", "trash"]);
		// the type is the domain's own words
		const f: ("inbox" | "junk" | "trash")[] | undefined = e.values.folder;
		const o: "new" | "old" | undefined = e.values.order;
		void [f, o];
	}
	refused(
		["ls", "--folder", "inbox,spam"],
		/^--folder: "spam" is not inbox, junk, trash$/,
	);
	refused(
		["ls", "--limit", "lots"],
		/^--limit takes a whole number, not "lots"$/,
	);
	refused(
		["ls", "--limit", "2.5"],
		/^--limit takes a whole number, not "2\.5"$/,
	);
	refused(["ls", "--order", "mid"], /^--order: "mid" is not new, old$/);
	refused(["ls", "--limit"], /^--limit needs a value: --limit <n>$/);
}

// help and version print, in every spelling
{
	const all = eid.parse([]);
	assert.equal(all.kind, "print");
	const text = stripAnsi((all as { text: string }).text);
	assert.match(text, /eid 1\.2\.3 {2}your e-ID from a terminal/);
	assert.match(text, /files\n {4}eid send <path> \[name\] {2,}send a file/);
	assert.match(text, /on every command\n {4}--json {2,}the answer as JSON/);
	assert.match(text, /EID_URL {2,}another e-ID/);
	assert.match(
		text,
		/eid help <command> for one in full · the API: e-id\.to\/api/,
	);
	// one column across every section
	const starts = text
		.split("\n")
		.filter((l) => /^ {4}\S/.test(l))
		.map(
			(l) => l.search(/ {2,}\S/) + l.slice(l.search(/ {2,}\S/)).search(/\S/),
		);
	assert.equal(
		new Set(starts).size,
		1,
		`one column, got ${[...new Set(starts)]}`,
	);
	for (const argv of [
		["help", "send"],
		["send", "--help"],
		["send", "-h"],
		["-h", "send"],
	]) {
		const one = eid.parse(argv);
		assert.equal(one.kind, "print", argv.join(" "));
		const t = stripAnsi((one as { text: string }).text);
		assert.match(
			t,
			/eid send <path> \[name\]\n {2}send a file/,
			argv.join(" "),
		);
		assert.match(t, /-t, --to <people> {2}only for them/);
		assert.match(t, /\$ eid send notes\.zip/);
		assert.match(t, /--json\n {4}SendMade/);
	}
	const v = eid.parse(["--version"]);
	assert.deepEqual(v, {
		kind: "print",
		text: "1.2.3\n",
		data: { version: "1.2.3" },
	});
	refused(["help", "nope"], /^No command "nope": eid help$/);
	const data = eid.describe() as {
		commands: { name: string; usage: string }[];
	};
	assert.deepEqual(
		data.commands.map((c) => c.usage),
		[
			"eid send <path> [name]",
			"eid inbox",
			"eid set <what> <value...>",
			"eid vouches <on|off>",
			"eid bday <who> <day>",
			"eid ls",
			"eid help [command]",
		],
	);
	const ls = stripAnsi((eid.parse(["help", "ls"]) as { text: string }).text);
	// choices shown as the placeholder, or after the words where one hides them
	assert.match(
		ls,
		/--limit <n> {2,}at most\n {4}--order <new\|old> {2,}which first/,
	);
	assert.match(ls, /--tag <t>,… {2,}tagged/);
	assert.match(ls, /--folder <folder>,… {2,}only these \(inbox, junk, trash\)/);
}

// a spec that cannot work throws as the program starts
const bad = (spec: Parameters<typeof program>[0], like: RegExp) =>
	assert.throws(() => program(spec), like);
const base = { name: "x", version: "1", says: "x" };
bad(
	{ ...base, commands: { a: { says: "a" } }, sections: [["s", []]] },
	/a in no section/,
);
bad(
	{ ...base, commands: { a: { says: "a" } }, sections: [["s", ["a", "b"]]] },
	/names "b"/,
);
bad(
	{
		...base,
		commands: {
			a: {
				says: "a",
				flags: { dir: { type: "string", short: "d", says: "" } },
			},
			b: {
				says: "b",
				flags: { days: { type: "string", short: "d", says: "" } },
			},
		},
	},
	/-d is both --dir and --days/,
);
bad(
	{
		...base,
		commands: {
			a: { says: "a", flags: { to: { type: "string", says: "" } } },
			b: { says: "b", flags: { to: { type: "boolean", says: "" } } },
		},
	},
	/--to is spelled two ways/,
);
// one name, a list in one command and one value in another: each reads its own
{
	const mail = program({
		...base,
		commands: {
			ls: {
				says: "ls",
				flags: { to: { type: "string", says: "one address" } },
			},
			send: {
				says: "send",
				flags: { to: { type: "string", list: true, says: "recipients" } },
			},
		},
	});
	assert.deepEqual(
		(mail.parse(["ls", "--to", "a,b"]) as { values: unknown }).values,
		{
			to: "a,b",
		},
	);
	assert.deepEqual(
		(mail.parse(["send", "--to", "a,b", "--to", "c"]) as { values: unknown })
			.values,
		{ to: ["a", "b", "c"] },
	);
}
bad(
	{ ...base, commands: { a: { args: "<x> [y...] <z>", says: "a" } } },
	/only the last may take the rest/,
);
bad({ ...base, commands: { a: { args: "x", says: "a" } } }, /"x" is not <x>/);
bad(
	{
		...base,
		commands: {
			a: { says: "a", flags: { help: { type: "boolean", says: "" } } },
		},
	},
	/--help is built in/,
);

// the time vocabulary: back for --since, forward for a deadline, a day a span
{
	const now = new Date(2026, 9, 17, 12, 30);
	assert.equal(
		parseWhen("2h", "start", now).getTime(),
		now.getTime() - 2 * 3_600_000,
	);
	assert.equal(
		parseDeadline("2h", now).getTime(),
		now.getTime() + 2 * 3_600_000,
	);
	assert.equal(
		parseWhen("today", "start", now).getTime(),
		new Date(2026, 9, 17).getTime(),
	);
	assert.equal(
		parseWhen("today", "end", now).getTime(),
		new Date(2026, 9, 17, 23, 59, 59, 999).getTime(),
	);
	assert.equal(
		parseWhen("yesterday", "start", now).getTime(),
		new Date(2026, 9, 16).getTime(),
	);
	assert.equal(
		parseWhen("2026-10-05", "start", now).getTime(),
		new Date(2026, 9, 5).getTime(),
	);
	assert.equal(
		parseWhen("2026-10-05", "end", now).getTime(),
		new Date(2026, 9, 5, 23, 59, 59, 999).getTime(),
	);
	assert.equal(
		parseDeadline("2026-10-20", now).getTime(),
		new Date(2026, 9, 20, 23, 59, 59, 999).getTime(),
	);
	assert.equal(
		parseWhen("20:00", "start", now).getTime(),
		new Date(2026, 9, 17, 20).getTime(),
	);
	assert.equal(
		parseWhen("2026-10-05T10:00:00Z").toISOString(),
		"2026-10-05T10:00:00.000Z",
	);
	assert.equal(localDay(parseWhen("2026-10-05", "end", now)), "2026-10-05");
	assert.throws(() => parseWhen("soon"), /can't read time "soon"/);
	assert.throws(() => parseWhen("25:00"), /no time of day/);
	assert.throws(() => parseWhen("2026-02-30"), /no day/);
}

// a name of words: the longest the leading words spell, each its own flags
{
	const bank = program({
		name: "bank",
		version: "1",
		says: "b",
		commands: {
			invoice: {
				args: "<number>",
				says: "one invoice",
				flags: { json: { type: "boolean", says: "j" } },
			},
			"invoice create": {
				says: "a draft",
				flags: { amount: { type: "string", required: true, says: "how much" } },
			},
			"invoice cancel": {
				args: "<number>",
				says: "burn it",
				flags: { confirm: { type: "boolean", says: "c" } },
			},
		},
	});
	const show = bank.parse(["invoice", "F-12", "--json"]);
	assert.deepEqual(show.kind === "run" && [show.command, show.args], [
		"invoice",
		["F-12"],
	]);
	const make = bank.parse(["invoice", "create", "--amount", "100"]);
	assert.deepEqual(make.kind === "run" && [make.command, make.values], [
		"invoice create",
		{ amount: "100" },
	]);
	const burn = bank.parse(["invoice", "--confirm", "cancel", "F-12"]);
	assert.deepEqual(burn.kind === "run" && [burn.command, burn.args], [
		"invoice cancel",
		["F-12"],
	]);
	refused2(
		bank,
		["invoice", "create", "--json"],
		/--json is not a flag of bank invoice create: it is bank invoice's/,
	);
	refused2(
		bank,
		["invoice", "create"],
		/bank invoice create needs --amount <value>: how much/,
	);
	// an action misspelt is refused, never run as the parent with an argument
	refused2(
		bank,
		["invoice", "crate", "--amount", "1"],
		/^bank invoice crate: no such action — bank invoice create\?$/,
	);
	refused2(bank, ["invoice", "cancle", "F-12"], /bank invoice cancel\?$/);
	const real = bank.parse(["invoice", "F-2026-005"]);
	assert.deepEqual(real.kind === "run" && real.args, ["F-2026-005"]);
	// help of a name lists what is under it; help of a two-word name is that one
	const h = stripAnsi(
		(bank.parse(["help", "invoice"]) as { text: string }).text,
	);
	assert.match(
		h,
		/commands\n {4}bank invoice create {2,}a draft\n {4}bank invoice cancel <number> {2,}burn it/,
	);
	const h2 = stripAnsi(
		(bank.parse(["invoice", "cancel", "--help"]) as { text: string }).text,
	);
	assert.match(h2, /bank invoice cancel <number>\n {2}burn it/);
	const h3 = stripAnsi(
		(bank.parse(["help", "invoice", "cancel"]) as { text: string }).text,
	);
	assert.equal(h3, h2);
	assert.throws(
		() => program({ ...base, commands: { "a  b": { says: "a" } } }),
		/one space apart/,
	);
}

// aliases: answered as the command itself, shown beside it, each word one command
{
	const dc = program({
		name: "discord",
		version: "1",
		says: "d",
		commands: {
			message: { args: "<ref>", says: "one message", aliases: ["msg"] },
			attachment: { args: "<ref>", says: "a file", aliases: ["att"] },
		},
	});
	const c = dc.parse(["msg", "123"]);
	assert.equal(c.kind === "run" && c.command, "message");
	const h = dc.parse(["help", "att"]);
	assert.match(
		stripAnsi((h as { text: string }).text),
		/discord attachment\|att <ref>/,
	);
	assert.match(
		stripAnsi(dc.overview()),
		/discord message\|msg <ref> {2,}one message/,
	);
	assert.throws(
		() =>
			program({
				...base,
				commands: { a: { says: "a", aliases: ["b"] }, b: { says: "b" } },
			}),
		/"b" names both a and b/,
	);
}

// a default: a word no command spells, given to it when it claims the word; a
// slip of a command's name refused all the same, naming both readings
{
	const hf = program({
		name: "hf-get",
		version: "1",
		says: "h",
		commands: {
			pull: {
				args: "<repo>",
				says: "fetch a repo",
				flags: { rev: { type: "string", says: "a revision" } },
			},
			ls: { says: "every repo" },
		},
		default: { command: "pull", claims: (w) => w.includes("/") },
	});
	const c = hf.parse(["owner/repo", "--rev", "v2"]);
	assert.deepEqual(c, {
		kind: "run",
		command: "pull",
		args: ["owner/repo"],
		values: { rev: "v2" },
	});
	const named = hf.parse(["pull", "owner/repo"]);
	assert.equal(named.kind === "run" && named.args[0], "owner/repo");
	assert.equal(hf.parse(["ls"]).kind === "run" && "ls", "ls");
	assert.throws(
		() => hf.parse(["lss"]),
		(e) =>
			e instanceof CliError && e.message === 'No command "lss": hf-get ls?',
	);
	assert.throws(
		() => hf.parse(["repo"]),
		(e) =>
			e instanceof CliError &&
			e.message === '"repo" is no command and no <repo>: hf-get help',
	);
	const anything = program({
		name: "notify",
		version: "1",
		says: "n",
		commands: {
			send: { args: "<words...>", says: "send it" },
			stop: { args: "<name>", says: "stop one" },
		},
		default: { command: "send", claims: () => true },
	});
	const sent = anything.parse(["build", "done"]);
	assert.equal(sent.kind === "run" && sent.args.join(" "), "build done");
	assert.throws(
		() => anything.parse(["stpo"]),
		(e) =>
			e instanceof CliError &&
			e.message === 'No command "stpo": notify stop?, or notify send stpo',
	);
	const over = stripAnsi(hf.overview());
	assert.match(over, /hf-get \[pull\] <repo> {2,}fetch a repo/);
	assert.equal((hf.describe() as { default: string }).default, "pull");
	assert.throws(
		() =>
			program({
				...base,
				commands: { a: { args: "<x>", says: "a" } },
				default: { command: "nope", claims: () => true },
			}),
		/default is "nope", which it does not declare/,
	);
	assert.throws(
		() =>
			program({
				...base,
				commands: { a: { says: "a" } },
				default: { command: "a", claims: () => true },
			}),
		/give it args/,
	);
}

// no version: none shown, no --version; the environment its own group; a long
// description folded under its own column
{
	const src = program({
		name: "cal",
		says: "the calendar",
		commands: {
			agenda: {
				says: "what is coming",
				flags: {
					days: {
						type: "integer",
						says: "how many days ahead to read, counted from today, with every recurring event expanded into each of its days",
					},
				},
			},
		},
		env: [["CAL_ACCOUNT", "the account"]],
	});
	const over = stripAnsi(src.overview());
	assert.match(over, /^ {2}cal {2}the calendar$/m);
	assert.doesNotMatch(over, /--version/);
	assert.match(over, /environment\n {4}CAL_ACCOUNT +the account/);
	assert.throws(
		() => src.parse(["--version"]),
		(e) => e instanceof CliError && /--version is no flag/.test(e.message),
	);
	const lines = stripAnsi(src.detail("agenda"))
		.split("\n")
		.filter((l) => l.includes("--days") || /^ {10,}\S/.test(l));
	assert.ok(lines.length >= 2, lines.join("\n"));
	const column = (lines[0] as string).indexOf("how");
	for (const l of lines.slice(1))
		assert.equal(l.length - l.trimStart().length, column, l);
	assert.ok(lines.every((l) => l.length <= 80));
}

// a required flag: refused when absent, saying what it is for; typed as there
{
	const mail = program({
		name: "smail",
		version: "1",
		says: "mail",
		commands: {
			send: {
				says: "send",
				flags: {
					from: {
						type: "string",
						value: "<addr>",
						required: true,
						says: "the address to send as, never picked for you",
					},
					cc: { type: "string", says: "copy" },
				},
			},
		},
	});
	assert.throws(
		() => mail.parse(["send", "--cc", "x"]),
		/^CliError: smail send needs --from <addr>: the address to send as, never picked for you$/,
	);
	const c = mail.parse(["send", "--from", "a@b.c"]);
	if (c.kind === "run") {
		const from: string = c.values.from;
		const cc: string | undefined = c.values.cc;
		void [from, cc];
		assert.equal(from, "a@b.c");
	}
	assert.match(
		stripAnsi(mail.detail("send")),
		/--from <addr> {2}the address to send as, never picked for you \(required\)/,
	);
	assert.throws(
		() =>
			program({
				...base,
				commands: {
					a: {
						says: "a",
						flags: { x: { type: "boolean", required: true, says: "" } },
					},
				},
			}),
		/a boolean flag takes no value, list, choices or required/,
	);
}

// run: each command to its own handler, typed by its spec, with one context
{
	const tiny = program({
		name: "t",
		version: "1",
		says: "t",
		global: { json: { type: "boolean", says: "json" } },
		commands: {
			get: {
				args: "<x>",
				says: "get",
				flags: { dir: { type: "string", says: "dir" } },
			},
			ls: { says: "ls", flags: { limit: { type: "integer", says: "n" } } },
		},
	});
	const seen: string[] = [];
	const handlers = {
		get: (c: { args: string[]; values: { dir?: string } }, ctx: string) => {
			seen.push(`get ${c.args[0]} ${c.values.dir} ${ctx}`);
		},
		ls: async (c: { values: { limit?: number } }, ctx: string) => {
			seen.push(`ls ${c.values.limit} ${ctx}`);
		},
	};
	const shared = tiny.context((c) => `ctx:${c.command}`);
	await shared.run(handlers, ["get", "a", "--dir", "/x"]);
	await shared.run(handlers, ["ls", "--limit", "3"]);
	assert.deepEqual(seen, ["get a /x ctx:get", "ls 3 ctx:ls"]);

	// handlers written inline take their call and the context typed, with a
	// context that reads the call
	await tiny
		.context(({ values }) => ({ json: values.json === true }))
		.run(
			{
				get({ args, values }, { json }) {
					const dir: string | undefined = values.dir;
					seen.push(`inline get ${args[0]} ${dir} ${json}`);
				},
				ls({ values }, { json }) {
					const n: number | undefined = values.limit;
					seen.push(`inline ls ${n} ${json}`);
				},
			},
			["get", "b", "--json"],
		);
	assert.equal(seen.at(-1), "inline get b undefined true");
	await tiny.run({ get: () => void seen.push("bare get"), ls: () => {} }, [
		"get",
		"c",
	]);
	assert.equal(seen.at(-1), "bare get");

	// help is printed, never run: its text, or its data under --json
	const out: string[] = [];
	const write = process.stdout.write.bind(process.stdout);
	const log = console.log;
	process.stdout.write = ((s: string) => out.push(s) > 0) as typeof write;
	console.log = (s: string) => void out.push(s);
	await shared.run(handlers, ["help", "get"]);
	await shared.run(handlers, ["--version", "--json"]);
	process.stdout.write = write;
	console.log = log;
	assert.match(stripAnsi(out[0] ?? ""), /t get <x>\n {2}get/);
	assert.deepEqual(JSON.parse(out[1] ?? ""), { version: "1" });
	assert.equal(seen.length, 4);

	// one handler per command, checked as it runs
	await assert.rejects(
		// @ts-expect-error ls has no handler
		shared.run({ get: handlers.get }, ["get", "a"]),
		/t's handlers: none for ls/,
	);
}

// the watch contract: under --once a batch delivered at once yields exactly one
// match and exit 0; at a deadline with nothing, exit 2. The clock ends the
// process, so each runs in a child.
{
	const watch = (script: string) =>
		spawnSync(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", script],
			{ encoding: "utf8", cwd: import.meta.dirname },
		);
	const once = watch(`
		import { WatchClock } from "../src/cli/watch.ts";
		const clock = new WatchClock({ once: true, cleanup: () => {} });
		for (const m of ["a", "b", "c"]) clock.hit(() => console.log(m));
		await new Promise(() => {});
	`);
	assert.equal(once.status, 0, once.stderr);
	assert.equal(once.stdout, "a\n");
	const none = watch(`
		import { WatchClock } from "../src/cli/watch.ts";
		new WatchClock({ once: true, until: new Date(Date.now() + 300), cleanup: () => {} });
		await new Promise(() => {});
	`);
	assert.equal(none.status, 2, none.stderr);
	assert.match(none.stderr, /deadline reached: no match/);
}

console.log("command: ok");
