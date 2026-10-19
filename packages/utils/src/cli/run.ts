/**
 * `cli/run`: how a command-line program answers and fails, one way for every
 * program. stdout carries the answer (JSON under `--json`), stderr the words
 * around it; a mistake the person can fix is said plainly with exit 1, a bug is
 * thrown with its stack.
 */

import { ui } from "./text.js";

/**
 * A failure the person caused or can fix: said plainly, no stack, exit 1. `code`
 * names it for a program (`usage`, `unconfirmed`, `not_found`, …); `fields`
 * carries a refused form's reasons by field.
 */
export class CliError extends Error {
	constructor(
		message: string,
		readonly code = "refused",
		readonly fields?: Record<string, string>,
	) {
		super(message);
		this.name = "CliError";
	}
}

/** Whether the answer is to be JSON: read from argv itself, so a mistake in the
 *  arguments is answered as JSON too. */
export const jsonOut = (argv: readonly string[] = process.argv): boolean =>
	argv.includes("--json");

/** The answer: `data` as JSON on stdout under `json`, else `human` for a person. */
export function emit(json: boolean, data: unknown, human: () => void): void {
	if (json) console.log(JSON.stringify(data, null, 2));
	else human();
}

/**
 * Runs the program and answers its failure. A `CliError` is said (red at a
 * terminal; `{ error: { code, message, fields? } }` on stdout under `json`) and
 * exits 1. Anything else is a bug: under `json` it is answered as
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
			process.exit(1);
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
