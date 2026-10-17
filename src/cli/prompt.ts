/**
 * `cli/prompt`: questions for the person at the terminal, asked on stderr so
 * stdout stays the answer. With no terminal to ask in (a pipe, a script, an
 * agent) each refuses with a `CliError` saying what to type instead, never
 * waiting on an input nobody will give. Ctrl-C at a question is Ctrl-C; Ctrl-D is
 * no answer.
 */

import { createInterface } from "node:readline/promises";
import { CliError } from "./run.js";
import { ui } from "./text.js";

/** Whether a person is there to ask: stdin and stderr both a terminal. */
export const canAsk = (): boolean =>
	Boolean(process.stdin.isTTY && process.stderr.isTTY);

const refuse = (instead: string): never => {
	throw new CliError(`no terminal to ask in: ${instead}`, "unconfirmed");
};

/** A question, its answer trimmed; Ctrl-D answers "". `instead` says what to type
 *  where no one can be asked ("--password <words>"). */
export async function ask(question: string, instead: string): Promise<string> {
	if (!canAsk()) refuse(instead);
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	// readline would swallow Ctrl-C at the question.
	rl.on("SIGINT", () => process.kill(process.pid, "SIGINT"));
	try {
		return (await rl.question(question)).trim();
	} catch (error) {
		if ((error as Error).name === "AbortError") {
			process.stderr.write("\n");
			return "";
		}
		throw error;
	} finally {
		rl.close();
	}
}

/** A yes or no, no by default: `question (y/N)`, true only for y or yes. */
export async function confirm(
	question: string,
	instead: string,
): Promise<boolean> {
	const said = await ask(`${question} ${ui.muted("(y/N)")} `, instead);
	return /^y(es)?$/i.test(said);
}

/** A question whose answer is never shown as it is typed (a password): read key
 *  by key with the terminal in raw mode, so it is in no scrollback and no
 *  recording. */
export function askHidden(question: string, instead: string): Promise<string> {
	if (!canAsk()) refuse(instead);
	const input = process.stdin;
	process.stderr.write(question);
	input.setRawMode(true);
	input.resume();
	return new Promise((done) => {
		let typed: string[] = [];
		const finish = () => {
			input.off("data", onKey);
			input.setRawMode(false);
			input.pause();
			process.stderr.write("\n");
		};
		const onKey = (chunk: Buffer) => {
			for (const c of chunk.toString("utf8")) {
				if (c === "\u0003") {
					finish();
					process.kill(process.pid, "SIGINT");
					return;
				}
				if (c === "\r" || c === "\n" || c === "\u0004") {
					finish();
					done(c === "\u0004" ? "" : typed.join(""));
					return;
				}
				typed =
					c === "\u007f" || c === "\b" ? typed.slice(0, -1) : [...typed, c];
			}
		};
		input.on("data", onKey);
	});
}
