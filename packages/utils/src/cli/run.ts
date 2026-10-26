/**
 * `cli/run`: how a command-line program answers and fails, one way for every
 * program. stdout carries the answer (JSON under `--json`), stderr the words
 * around it; a mistake the person can fix is said plainly with its exit (64 a
 * wrong call, 1 anything else, or one the program declared), a bug is thrown
 * with its stack.
 */

import { ui } from "./text.js";

/** A wrong call (EX_USAGE): a flag the command does not take, an argument too
 *  few or too many. The same in every program. */
export const USAGE_EXIT = 64;

/**
 * A failure the person caused or can fix: said plainly, no stack. `code` names
 * it for a program (`usage`, `unconfirmed`, `not_found`, …); `fields` carries a
 * refused form's reasons by field; `exit` is the status it ends with, one the
 * program declared (`exits`), else 64 for `usage` and 1 for anything else.
 */
export class CliError extends Error {
	constructor(
		message: string,
		readonly code = "refused",
		readonly fields?: Record<string, string>,
		readonly exit?: number,
	) {
		super(message);
		this.name = "CliError";
	}

	/** The status the program ends with. */
	get status(): number {
		return this.exit ?? (this.code === "usage" ? USAGE_EXIT : 1);
	}
}

/** argv before `--`: what follows is a command's own, never read for the
 *  program's flags. */
export const beforeDash = (argv: readonly string[]): readonly string[] => {
	const dash = argv.indexOf("--");
	return dash === -1 ? argv : argv.slice(0, dash);
};

/** Whether the answer is to be JSON: read from argv itself, before `--`, so a
 *  mistake in the arguments is answered as JSON too. */
export const jsonOut = (argv: readonly string[] = process.argv): boolean =>
	beforeDash(argv).includes("--json");

/** The answer: `data` as JSON on stdout under `json`, else `human` for a person. */
export function emit(json: boolean, data: unknown, human: () => void): void {
	if (json) console.log(JSON.stringify(data, null, 2));
	else human();
}

/**
 * Runs the program and answers its failure. A `CliError` is said (red at a
 * terminal; `{ error: { code, message, fields? } }` on stdout under `json`) and
 * exits with its `status`. Anything else is a bug: under `json` it is answered as
 * `{ error: { code: "crash", message } }` too, then thrown with its stack.
 */
export function main(
	run: () => Promise<void>,
	opts: { json?: boolean } = {},
): void {
	const json = opts.json ?? jsonOut();
	run().catch((error: unknown) => {
		if (error instanceof CliError) {
			if (json)
				console.log(
					JSON.stringify({
						error: {
							code: error.code,
							message: error.message,
							...(error.fields && { fields: error.fields }),
						},
					}),
				);
			else console.error(ui.bad(error.message));
			process.exit(error.status);
		}
		if (json)
			console.log(
				JSON.stringify({
					error: { code: "crash", message: (error as Error).message },
				}),
			);
		throw error;
	});
}
