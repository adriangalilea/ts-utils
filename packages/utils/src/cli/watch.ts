/**
 * `cli/watch`: the one contract every `watch` command keeps, so an agent that
 * learned one has learned them all.
 *
 *   default        stream: every match, until Ctrl-C
 *   --once, -o     exit 0 after the first match
 *   --until <t>    stop at the deadline: exit 0 if anything matched, 2 if nothing
 *   exit 1         a real failure (bad flags, a dead transport)
 *
 *   --since <t>    consider everything that arrived after t before going live
 *
 * stdout carries the matches (one JSON line each under --json), stderr the
 * words around them. That split and the exit codes make a watch composable: an
 * agent backgrounds it, is woken by its exit, and branches on the code. The
 * process exit IS the event.
 *
 * Every transport behind a watch owes four guarantees, because an exit 2 is
 * read as "it did not happen" and nothing downstream can tell a miss from a
 * no:
 *
 *   1. Concurrent watches each see every event. Any number of watches on one
 *      account run side by side; a transport that admits one live subscriber
 *      (an MTProto auth key's update stream) is owned by one daemon that
 *      writes a local log, and the watches read that log.
 *   2. Nothing between start and live is lost. The watch is armed at
 *      `armedAt()`, the moment the process started (or `--since`), and every
 *      event after it is considered: a poller's baseline is that instant,
 *      never its first poll.
 *   3. `--since` works in every scope. A supervisor re-arming a watch after a
 *      reboot appends `--since <armed>`, and the watch covers what arrived
 *      while nothing was watching; a transport that cannot reach that far back
 *      says so and exits 1, never answers from a shorter window.
 *   4. A dead source is exit 1. A watch over a transport that stopped
 *      receiving must fail, not reach its deadline and report no match.
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
	since: {
		type: "string",
		value: "<t>",
		says: "consider what arrived after t first, so a re-armed watch misses nothing (30m, 2h, today, ISO)",
	},
} as const satisfies FlagSpecs;

/** When this process started: the instant a watch without `--since` is armed
 *  at, read before any connect so the time spent connecting is covered. */
const PROCESS_START = new Date(performance.timeOrigin);

/**
 * The instant a watch is armed at: `--since` as typed, else the moment the
 * process started. Every event after it belongs to the watch (guarantee 2); a
 * poller takes it as its baseline instead of its first poll's answer.
 */
export function armedAt(since?: string): Date {
	return since === undefined ? PROCESS_START : whenFlag("since", since);
}

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

	/** Whether the watch has ended (its first match under --once, its deadline,
	 *  a failure): nothing more is emitted. */
	get ended(): boolean {
		return this.finishing;
	}

	/**
	 * A match: `emit` writes it, then the watch counts it, a --once watch ending
	 * there. Once the watch has ended nothing is emitted, so a batch delivered in
	 * one go (a backfill) yields exactly one match under --once. False when it
	 * was not emitted.
	 */
	hit(emit: () => void): boolean {
		if (this.finishing) return false;
		emit();
		this.matched++;
		if (this.opts.once) void this.finish(0);
		return true;
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
