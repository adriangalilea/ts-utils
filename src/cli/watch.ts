/**
 * `cli/watch`: the one contract every `watch` command keeps, so an agent that
 * learned one has learned them all.
 *
 *   default        stream: every match, until Ctrl-C
 *   --once, -o     exit 0 after the first match
 *   --until <t>    stop at the deadline: exit 0 if anything matched, 2 if nothing
 *   exit 1         a real failure (bad flags, a dead transport)
 *
 * stdout carries the matches (one JSON line each under --json), stderr the
 * words around them. That split and the exit codes make a watch composable: an
 * agent backgrounds it, is woken by its exit, and branches on the code. The
 * process exit IS the event.
 */

import {
	type Edge,
	localStamp,
	parseDeadline,
	parseWhen,
} from "../universal/time.js";
import type { FlagSpecs } from "./command.js";
import { CliError } from "./run.js";

/** The contract's flags, spelled once: spread into a watch command's `flags`. */
export const WATCH_FLAGS = {
	once: {
		type: "boolean",
		short: "o",
		says: "end at the first match (exit 0)",
	},
	until: {
		type: "string",
		value: "<t>",
		says: "end at a deadline (30m, 2h, 20:00, a day, ISO): exit 0 if anything matched, 2 if nothing",
	},
} as const satisfies FlagSpecs;

/** `--since`, `--until` and the like as typed (`parseWhen`), a mistake a `CliError`. */
export function whenFlag(flag: string, s: string, edge: Edge = "start"): Date {
	try {
		return parseWhen(s, edge);
	} catch (error) {
		throw new CliError(`--${flag}: ${(error as Error).message}`, "usage");
	}
}

/** A watch's `--until` as typed (`parseDeadline`), refused in the past. */
export function deadlineFlag(s: string): Date {
	let at: Date;
	try {
		at = parseDeadline(s);
	} catch (error) {
		throw new CliError(`--until: ${(error as Error).message}`, "usage");
	}
	if (at.getTime() <= Date.now())
		throw new CliError(`--until ${localStamp(at)} is already past`, "usage");
	return at;
}

/** `--match` compiled, case-insensitive; a pattern that is no regex is a mistake. */
export function matchFlag(pattern: string): RegExp {
	try {
		return new RegExp(pattern, "i");
	} catch (error) {
		throw new CliError(
			`--match "${pattern}" is no regex: ${(error as Error).message}`,
			"usage",
		);
	}
}

/** Exit once stdout has drained: a pipe writes later, and a match cut off on
 *  exit would defeat the contract. */
function exitFlushed(code: number): void {
	if (process.stdout.writableLength === 0) process.exit(code);
	process.stdout.once("drain", () => process.exit(code));
	setTimeout(() => process.exit(code), 2000).unref();
}

/**
 * The contract kept: `hit()` after each match emitted (ending a `once` watch),
 * the deadline ending it with 0 or 2. `cleanup` closes what the watch holds
 * open (sockets, IMAP, MTProto), given three seconds at most.
 */
export class WatchClock {
	private matched = 0;
	private finishing = false;

	constructor(
		private readonly opts: {
			once: boolean;
			until?: Date;
			cleanup: () => void | Promise<void>;
		},
	) {
		if (opts.until) {
			const ms = opts.until.getTime() - Date.now();
			if (ms <= 0)
				throw new CliError(
					`--until ${localStamp(opts.until)} is already past`,
					"usage",
				);
			setTimeout(() => {
				console.error(
					this.matched > 0
						? `⏱ deadline reached: ${this.matched} match(es)`
						: "⏱ deadline reached: no match",
				);
				void this.finish(this.matched > 0 ? 0 : 2);
			}, ms);
		}
	}

	hit(): void {
		this.matched++;
		if (this.opts.once) void this.finish(0);
	}

	async finish(code: number): Promise<void> {
		if (this.finishing) return;
		this.finishing = true;
		setTimeout(() => process.exit(code), 3000).unref();
		try {
			await this.opts.cleanup();
		} catch {
			// Exiting all the same: a transport that will not close must not hold the exit.
		}
		exitFlushed(code);
	}
}
