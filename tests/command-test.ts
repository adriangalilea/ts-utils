/**
 * Assert-based checks for `cli/command` and the time vocabulary under
 * `cli/watch`: what a person types, read the way every CLI built on it reads it.
 *
 *   pnpm test:command
 */
import { strict as assert } from "node:assert";
import { CliError, program } from "../src/cli/index.js";
import { stripAnsi } from "../src/universal/ansi.js";
import { localDay, parseDeadline, parseWhen } from "../src/universal/time.js";

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
	},
	sections: [
		["files", ["send", "inbox"]],
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
refused(["inbox", "--wach"], /--wach is no flag of eid inbox: --watch\?/);
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
refused(["vouches", "maybe"], /"maybe" is not on, off/);
assert.deepEqual(run("vouches", "off").args, ["off"]);

// a command that does not exist, with a guess
refused(["sned"], /No command "sned": eid send\?/);

// a dash and a digit is an argument unless a flag spells it
{
	const c = run("bday", "ada", "--09-29");
	assert.deepEqual(c.args, ["ada", "--09-29"]);
	const d = run("bday", "ada", "2026-01-01", "-1");
	if (d.command === "bday") assert.equal(d.values.one, true);
	const e = run("set", "balance", "-5");
	assert.deepEqual(e.args, ["balance", "-5"]);
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
	refused(["help", "nope"], /No command "nope"/);
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
			"eid help [command]",
		],
	);
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

console.log("command: ok");
