/**
 * Demo (not a test — it renders, it doesn't assert) of the `cli` layer:
 * a `contacts who`-style view built from table/kv/tree/ui. All data is fake.
 *
 *   FORCE_COLOR=1 pnpm tsx tests/cli-demo.ts
 */
import { indent, kv, table, ui } from "../src/cli/index.js";

type H = {
	label?: string;
	kind: string;
	value: string;
	pref?: boolean;
	sent?: number;
	recv?: number;
};
type P = {
	name: string;
	golden: boolean;
	sources: string[];
	handles: H[];
	whisper?: string;
};

const people: P[] = [
	{
		name: "Sam Carter",
		golden: true,
		sources: ["apple", "mail"],
		handles: [
			{ label: "work", kind: "email", value: "sam@acme.example" },
			{ label: "home", kind: "email", value: "sam.carter@example.com" },
			{ kind: "phone", value: "+10000000000", pref: true },
			{ kind: "telegram", value: "samc" },
		],
	},
	{
		name: "Sam Okonkwo",
		golden: false,
		sources: ["mail"],
		handles: [
			{ kind: "email", value: "s.okonkwo@example.org", sent: 5, recv: 4 },
		],
		whisper:
			'maybe: Sam Carter  —  contacts link "Sam Carter" email s.okonkwo@example.org',
	},
];

function renderPerson(p: P): string {
	const dot = p.golden ? ui.ok("●") : ui.muted("○");
	const tag = p.golden ? ui.ok("golden") : ui.muted("floating");
	const header = `${dot} ${ui.head(p.name)}  ${ui.ref(`[${p.sources.join(",")}]`)}  ${tag}`;
	const rows = p.handles.map((h) => [
		h.pref ? ui.warn("★") : ui.muted(h.label ?? ""),
		ui.accent(h.kind),
		h.value,
		h.sent || h.recv ? ui.ref(`↑${h.sent ?? 0} ↓${h.recv ?? 0}`) : "",
	]);
	const body = indent(table(rows, { gap: 2 }), 4);
	return p.whisper
		? `${header}\n${body}\n${indent(ui.muted(`↳ ${p.whisper}`), 4)}`
		: `${header}\n${body}`;
}

console.log(`${ui.head("contacts who sam")}\n`);
console.log(people.map(renderPerson).join("\n\n"));

console.log(`\n${ui.head("contacts show sam")}\n`);
console.log(
	kv(
		[
			["name", "Sam Carter"],
			["status", ui.ok("golden / Apple")],
			["work", "sam@acme.example"],
			["home", "sam.carter@example.com"],
			["phone", `+10000000000 ${ui.warn("★")}`],
			["telegram", "samc"],
		],
		{ indent: 2 },
	),
);

console.log(`\n${ui.head("plain table (--head, right-align counts)")}\n`);
console.log(
	table(
		[
			["Acme Newsletter", "news@acme.example", ui.ref("15246")],
			["Shopwave", "hello@shopwave.example", ui.ref("871")],
			["Chris Doe", "chris.doe@example.com", ui.ref("114")],
		],
		{ head: ["who", "email", "msgs"], align: ["l", "l", "r"] },
	),
);
