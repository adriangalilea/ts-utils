/**
 * `live` — a pinned, self-repainting terminal region, the pure widgets that
 * animate inside it (`spin` / `bar` / `elapsed`), and the `spinner()` one-liner.
 *
 * The model: you own the state, the region owns the screen. A region is a
 * `render: () => string` repainted on a timer (plus `refresh()` for instant
 * updates). A frame is just a string — `table()` / `kv()` / `ui` compose
 * inside it unchanged, and widgets are plain string functions.
 *
 * The hard problem this solves is interleaving: while a region is active,
 * `console.log/warn/error` — and therefore the logger, which writes through
 * console — are rerouted to print ABOVE the region (erase → write → repaint).
 * Logging never tears the UI, and there is no new logging API to learn.
 *
 * Non-TTY (pipe / CI / log file): nothing animates, nothing repaints.
 * `done(final)` prints the final frame once; the opt-in `heartbeat` prints
 * plain snapshots for long CI silences. Same calling code either way.
 *
 * Crash-safe cursor: hidden while painting, restored on done/clear, process
 * exit, and fatal signals. Signals are handled politely — if the app has its
 * own SIGINT handler (graceful shutdown), we restore the cursor and stay out
 * of the way; if we are the only listener, default die-on-signal is preserved.
 *
 * Exactly one region can be active: two pinned regions can't share the bottom
 * of one screen. Compose everything into a single `render()` — that's the
 * point of frames being strings.
 */

import { assert } from "../offensive.js";
import { cyan, dim, green, red } from "../universal/log.js";
import { clip } from "./text.js";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
// Synchronized-update markers: modern terminals (iTerm2, kitty, Ghostty,
// WezTerm, recent Terminal.app) paint the wrapped write atomically — no
// flicker on erase+rewrite. Unknown CSIs are ignored elsewhere, so this is
// free to always emit.
const SYNC_ON = "\x1b[?2026h";
const SYNC_OFF = "\x1b[?2026l";

/** Cursor to the first line of an `n`-line region + erase to end of screen. */
const wipe = (n: number): string => (n > 0 ? `\x1b[${n}F\x1b[J` : "");

export interface LiveOpts {
	/** Target stream. Default stderr — stdout stays clean for pipes / --json. */
	stream?: NodeJS.WriteStream;
	/** Repaints per second while active (default 12.5 — the spinner's cadence). */
	fps?: number;
	/** Non-TTY only: print a plain snapshot every N ms so long CI runs aren't silent. Default off. */
	heartbeat?: number;
}

export interface Live {
	/** Repaint now (state changed and 80ms is too long to wait). */
	refresh(): void;
	/** Swap the render function (e.g. a new phase of the same operation). */
	update(render: () => string): void;
	/** Stop and persist a final frame (default: the current render) into scrollback. */
	done(final?: string): void;
	/** Stop and remove the region entirely. */
	clear(): void;
}

let active: LiveRegion | null = null;

type ConsoleMethods = Pick<Console, "log" | "warn" | "error">;
type Signal = "SIGINT" | "SIGTERM";
const SIGNALS: Signal[] = ["SIGINT", "SIGTERM"];

class LiveRegion implements Live {
	private render: () => string;
	private readonly stream: NodeJS.WriteStream;
	private readonly tty: boolean;
	private painted = 0;
	private stopped = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	private orig: ConsoleMethods | undefined;
	private sigHandlers = new Map<Signal, () => void>();
	private onExit = (): void => {
		this.stream.write(SHOW_CURSOR);
	};

	constructor(render: () => string, opts: LiveOpts = {}) {
		this.render = render;
		this.stream = opts.stream ?? process.stderr;
		this.tty = this.stream.isTTY === true;

		if (!this.tty) {
			if (opts.heartbeat) {
				this.timer = setInterval(() => {
					this.stream.write(`${this.render()}\n`);
				}, opts.heartbeat);
				this.timer.unref();
			}
			return;
		}

		assert(
			active === null,
			"one live region at a time — compose into a single render()",
		);
		active = this;
		this.patchConsole();
		this.installGuards();
		this.stream.write(HIDE_CURSOR);
		this.paint();
		this.timer = setInterval(() => this.paint(), 1000 / (opts.fps ?? 12.5));
		this.timer.unref();
	}

	refresh(): void {
		if (this.tty && !this.stopped) this.paint();
	}

	update(render: () => string): void {
		this.render = render;
		this.refresh();
	}

	done(final?: string): void {
		assert(!this.stopped, "live region already stopped");
		if (!this.tty) {
			this.stopped = true;
			clearInterval(this.timer);
			this.stream.write(`${final ?? this.render()}\n`);
			return;
		}
		const frame = final ?? this.render();
		this.stop();
		this.stream.write(`${wipe(this.painted)}${frame}\n${SHOW_CURSOR}`);
	}

	clear(): void {
		assert(!this.stopped, "live region already stopped");
		if (!this.tty) {
			this.stopped = true;
			clearInterval(this.timer);
			return;
		}
		this.stop();
		this.stream.write(wipe(this.painted) + SHOW_CURSOR);
	}

	// --- internals (TTY path) ---

	private paint(): void {
		// `||` not `??` — a sizeless PTY (CI emulators, `script`) reports 0×0.
		const cols = this.stream.columns || 80;
		const rows = this.stream.rows || 24;
		// Clip each line to the terminal width — a wrapped line would break the
		// erase math. Clamp height to rows-1, keeping the BOTTOM of the frame
		// (latest activity), so an oversized frame degrades instead of corrupting.
		const lines = this.render()
			.split("\n")
			.map((l) => clip(l, cols - 1));
		const frame =
			lines.length < rows ? lines : lines.slice(lines.length - (rows - 1));
		this.stream.write(
			`${SYNC_ON}${wipe(this.painted)}${frame.join("\n")}\n${SYNC_OFF}`,
		);
		this.painted = frame.length;
	}

	/**
	 * Erase the region, run a write (a console call), repaint underneath it.
	 * The wipe opens a sync block; paint() re-asserts SYNC_ON (a no-op set)
	 * and its SYNC_OFF closes the whole erase→log→repaint atomically.
	 */
	private above(write: () => void): void {
		this.stream.write(SYNC_ON + wipe(this.painted));
		this.painted = 0;
		write();
		this.paint();
	}

	private patchConsole(): void {
		const orig: ConsoleMethods = {
			log: console.log.bind(console),
			warn: console.warn.bind(console),
			error: console.error.bind(console),
		};
		this.orig = orig;
		console.log = (...a: unknown[]) => this.above(() => orig.log(...a));
		console.warn = (...a: unknown[]) => this.above(() => orig.warn(...a));
		console.error = (...a: unknown[]) => this.above(() => orig.error(...a));
	}

	private installGuards(): void {
		process.on("exit", this.onExit);
		for (const sig of SIGNALS) {
			const h = (): void => {
				this.stream.write(SHOW_CURSOR);
				// Only listener (count includes us) → preserve default semantics:
				// re-raise and die. Otherwise the app owns shutdown; cursor is
				// restored and its handler proceeds over a still-painting region
				// that its own exit path will finalize.
				if (process.listenerCount(sig) === 1) {
					process.removeListener(sig, h);
					process.kill(process.pid, sig);
				}
			};
			process.on(sig, h);
			this.sigHandlers.set(sig, h);
		}
	}

	private stop(): void {
		this.stopped = true;
		clearInterval(this.timer);
		const orig = this.orig;
		assert(orig !== undefined, "stop() before patchConsole()");
		console.log = orig.log;
		console.warn = orig.warn;
		console.error = orig.error;
		process.removeListener("exit", this.onExit);
		for (const [sig, h] of this.sigHandlers) process.removeListener(sig, h);
		active = null;
	}
}

/**
 * Start a pinned region at the bottom of the terminal, repainting
 * `render()` until `done()` / `clear()`. Non-TTY → inert (see module doc).
 */
export function live(render: () => string, opts?: LiveOpts): Live {
	return new LiveRegion(render, opts);
}

// --- widgets: pure string builders, animated by being re-rendered ---

const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Spinner frame for "now" — call it inside `render()` and it animates. */
export const spin = (): string =>
	cyan(SPIN_FRAMES[Math.floor(Date.now() / 80) % SPIN_FRAMES.length] as string);

/**
 * Progress bar, `width` cells. `done > total` clamps to full — live counters
 * drift (e.g. a server-count proxy that overcounts) and that's the caller's
 * data, not a bug here.
 */
export function bar(done: number, total: number, width = 24): string {
	assert(done >= 0 && total >= 0, "bar: negative counts", done, total);
	const fill = Math.round(Math.min(1, total === 0 ? 1 : done / total) * width);
	return green("█".repeat(fill)) + dim("░".repeat(width - fill));
}

/** Compact elapsed time since a `Date.now()` timestamp: 0.4s · 12s · 1m05s · 1h02m. */
export function elapsed(since: number): string {
	const s = (Date.now() - since) / 1000;
	if (s < 10) return `${s.toFixed(1)}s`;
	const r = Math.round(s);
	if (r < 60) return `${r}s`;
	const m = Math.floor(r / 60);
	if (m < 60) return `${m}m${String(r % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/**
 * The one-liner: animate `label` with a spinner + elapsed time while `fn`
 * runs, persist `✓ label 1.2s` on success, `⨯ label 1.2s message` on failure
 * (and rethrow). Non-TTY prints just the final line.
 */
export async function spinner<T>(
	label: string,
	fn: () => Promise<T>,
): Promise<T> {
	const start = Date.now();
	const l = live(() => `${spin()} ${label} ${dim(elapsed(start))}`);
	try {
		const v = await fn();
		l.done(`${green("✓")} ${label} ${dim(elapsed(start))}`);
		return v;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		l.done(`${red("⨯")} ${label} ${dim(elapsed(start))} ${red(msg)}`);
		throw e;
	}
}
