/**
 * `cli/skill`: the program offered to agents, rendered from the same spec as
 * its help, so the skill says nothing the help does not and the help nothing
 * the skill does not. `skill` says whether each agent's copy is this
 * program's, `skill show` prints it, `skill install` writes it into Claude
 * Code's and Codex's base skill folders (every profile links into them),
 * `skill remove` takes it out. Nothing installs it unasked.
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FlagSpec, SkillCall } from "./command.js";
import { exitRows, flagText, type HelpModel } from "./help.js";
import { CliError } from "./run.js";

/** Where each agent reads skills from: the base homes every profile of it links
 *  into, never one profile's, or the skill would reach that profile alone. */
const agents = () => [
	{ name: "Claude Code", home: join(homedir(), ".claude") },
	{ name: "Codex", home: join(homedir(), ".codex") },
];

/** A YAML scalar: JSON's string form, which YAML reads as one. */
const yaml = (s: string) => JSON.stringify(s);

/** A flag's row as the skill lists it: its spelling, its words, what binds it. */
const flagRow = (name: string, f: FlagSpec) => {
	const notes = [
		...(f.choices && f.value ? [f.choices.join(", ")] : []),
		...(f.required ? ["required"] : []),
	];
	return `- \`${flagText(name, f)}\`: ${f.says}${notes.length ? ` (${notes.join("; ")})` : ""}`;
};

export function skillOf({
	spec,
	commands,
	global,
	sections,
	exits,
}: HelpModel) {
	const typed = (name: string) => {
		const c = commands[name];
		const tail = [
			c?.args,
			c?.passthrough === undefined ? undefined : `-- ${c.passthrough}`,
		]
			.filter(Boolean)
			.join(" ");
		return `${spec.name} ${name}${tail ? ` ${tail}` : ""}`;
	};

	/** The line agents choose skills by: what the program is, what it is for,
	 *  what never to do with it. */
	const description = () => {
		const skill = spec.skill;
		if (!skill) throw new Error(`cli: ${spec.name} has no skill`);
		const capital = spec.says.charAt(0).toUpperCase() + spec.says.slice(1);
		const sentence = /[.!?]$/.test(capital) ? capital : `${capital}.`;
		const never = skill.never?.length
			? ` Never ${skill.never.join("; ")}.`
			: "";
		return `${sentence} Use it for: ${skill.useWhen.join("; ")}.${never}`;
	};

	/** The skill as agents read it: one Markdown document, unfolded and
	 *  uncoloured, every command in full and every guide inline. */
	function markdown(): string {
		const out = [
			"---",
			`name: ${spec.name}`,
			`description: ${yaml(description())}`,
			"metadata:",
			`  generated-by: ${yaml(`${spec.name} ${spec.version ?? "from source"}`)}`,
			"---",
			"",
			`# ${spec.name}`,
			"",
			spec.says,
		];
		if (spec.about?.length) out.push("", ...spec.about);
		for (const g of Object.values(spec.guides ?? {}))
			out.push("", `## ${g.title}`, "", `*${g.says}*`, "", g.body);

		const placed = sections
			.flatMap(([, names]) => names)
			.filter((n) => n !== "help");
		out.push("", "## Commands");
		for (const [title, names] of sections) {
			const own = names.filter((n) => n !== "help");
			if (!own.length) continue;
			out.push(
				"",
				`### ${title}`,
				"",
				...own.map((n) => `- \`${typed(n)}\`: ${commands[n]?.says}`),
			);
		}
		for (const name of placed) {
			const c = commands[name];
			if (!c) continue;
			out.push("", `## \`${typed(name)}\``, "", c.says);
			if (c.more) out.push("", c.more);
			const listed = Object.entries(c.choices ?? {});
			if (listed.length)
				out.push(
					"",
					...listed.map(([a, words]) => `- \`<${a}>\`: ${words.join(", ")}`),
				);
			const flags = Object.entries(c.flags ?? {});
			if (flags.length)
				out.push("", "Flags:", "", ...flags.map(([n, f]) => flagRow(n, f)));
			if (c.passthrough !== undefined)
				out.push(
					"",
					`After \`--\`: ${c.passthrough}, handed to the command as typed.`,
				);
			if (c.examples?.length) out.push("", "```sh", ...c.examples, "```");
			if (c.json) out.push("", `With \`--json\`: ${c.json}`);
			if (c.exits?.length)
				out.push(
					"",
					`Exits: ${c.exits.map((code) => `${code} ${exits[code]}`).join(", ")}.`,
				);
		}
		const always = [
			...Object.entries(global).map(([n, f]) => flagRow(n, f)),
			...(spec.version === undefined
				? []
				: [`- \`--version\`: this ${spec.name}'s version`]),
		];
		if (always.length) out.push("", "## Flags", "", ...always);
		if (spec.env?.length)
			out.push(
				"",
				"## Environment",
				"",
				...spec.env.map(([n, s]) => `- \`${n}\`: ${s}`),
			);
		out.push(
			"",
			"## Exit status",
			"",
			...exitRows(exits).map(([code, says]) => `- \`${code}\`: ${says}`),
		);
		out.push(
			"",
			`\`${spec.name} help <command>\` prints one command as above; \`${spec.name} help --json\` prints all of it as data.`,
		);
		return `${out.join("\n")}\n`;
	}

	type Installed = "absent" | "current" | "stale" | { linked: string };
	const installed = (skills: string): Installed => {
		const target = join(skills, spec.name);
		if (!existsSync(target) && !isLink(target)) return "absent";
		if (isLink(target)) return { linked: readlinkSync(target) };
		const file = join(target, "SKILL.md");
		if (!existsSync(file)) return "stale";
		return readFileSync(file, "utf8") === markdown() ? "current" : "stale";
	};

	function status(): string {
		return agents()
			.map(({ name, home }) => {
				if (!existsSync(home)) return `${name}: not installed on this machine`;
				const state = installed(join(home, "skills"));
				if (state === "absent")
					return `${name}: no skill (${spec.name} skill install)`;
				if (state === "current") return `${name}: a copy, current`;
				if (state === "stale")
					return `${name}: a copy older than this ${spec.name} (${spec.name} skill install)`;
				return `${name}: linked to ${state.linked}, another copy (${spec.name} skill install writes this one's)`;
			})
			.join("\n");
	}

	/** Replaces what was there, a hand-edited copy included: the program is the
	 *  source, the file its rendering. Written whole, then moved into place. */
	function install(): string {
		return agents()
			.map(({ name, home }) => {
				if (!existsSync(home))
					return `${name}: not installed on this machine, skipped`;
				const skills = join(home, "skills");
				const target = join(skills, spec.name);
				try {
					mkdirSync(skills, { recursive: true });
					if (installed(skills) !== "absent") discard(target);
					mkdirSync(target);
					const file = join(target, "SKILL.md");
					writeFileSync(`${file}.tmp`, markdown());
					renameSync(`${file}.tmp`, file);
					return `${name}: ${file}`;
				} catch (error) {
					throw new CliError(
						`${name}: the skill was not installed at ${target}: ${(error as Error).message}`,
						"failed",
					);
				}
			})
			.join("\n");
	}

	function remove(): string {
		const said = agents().flatMap(({ name, home }) => {
			const skills = join(home, "skills");
			if (!existsSync(home) || installed(skills) === "absent") return [];
			const target = join(skills, spec.name);
			try {
				discard(target);
			} catch (error) {
				throw new CliError(
					`${name}: ${target} was not removed: ${(error as Error).message}`,
					"failed",
				);
			}
			return [`${name}: removed ${target}`];
		});
		return said.length
			? said.join("\n")
			: `no agent on this machine had the ${spec.name} skill`;
	}

	function answer(action: SkillCall["action"]): string {
		if (!spec.skill) throw new Error(`cli: ${spec.name} has no skill`);
		const text =
			action === "show"
				? markdown()
				: action === "install"
					? install()
					: action === "remove"
						? remove()
						: status();
		return text.endsWith("\n") ? text : `${text}\n`;
	}

	return { markdown, answer };
}

const isLink = (path: string) => {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
};

/** A link is unlinked (its destination untouched); a copy goes to the Trash where
 *  the system has one (macOS's `trash`), else it is removed. */
function discard(path: string): void {
	if (isLink(path)) {
		unlinkSync(path);
		return;
	}
	if (existsSync("/usr/bin/trash")) {
		const run = spawnSync("/usr/bin/trash", [path], { stdio: "ignore" });
		if (run.status === 0) return;
		throw new Error(`trash exited ${run.status}`);
	}
	rmSync(path, { recursive: true });
}
