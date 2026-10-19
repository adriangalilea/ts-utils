/**
 * Humanized time. Three questions, three functions: how long is this
 * duration (`span`, or `coarseSpan` for one unit only), how long ago was
 * this instant (`ago` — and its raw-duration twin `since`), how long
 * until this instant (`until`).
 *
 * `ago` degrades by distance instead of stacking units: fresh instants are
 * relative ("now", "3m ago", "2h 15m ago"), older ones snap to the clock the
 * reader would check — "10:30" earlier today, "yst 22:15" yesterday,
 * "Mon 09:00" within a week, "07/28" beyond. Relative wording past a few
 * hours ("19h ago") makes the reader do calendar math; a clock time doesn't.
 *
 * Accepts `Date | ISO string | epoch ms | null | undefined` and renders "—"
 * for null/undefined, same contract as ./format. Epoch numbers are
 * MILLISECONDS only — a seconds heuristic would silently misread dates near
 * the boundary, and a wrong timestamp should scream, not shift by 1000×.
 * Weekday/date fallbacks are en-pinned like every formatter here.
 */

import { NO_DATA } from "./format.js";

export type Dateish = Date | string | number | null | undefined;

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 604_800_000;

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function toMs(d: Dateish): number | null {
	if (d == null) return null;
	if (d instanceof Date) return d.getTime();
	const ms = typeof d === "number" ? d : Date.parse(d);
	return Number.isNaN(ms) ? null : ms;
}

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const sameDay = (a: Date, b: Date) =>
	a.getFullYear() === b.getFullYear() &&
	a.getMonth() === b.getMonth() &&
	a.getDate() === b.getDate();

/** Duration in ms → "45s", "47m", "1h 40m", "2d 3h". Negative clamps to "0s". */
export function span(ms: number): string {
	if (ms < 0) ms = 0;
	if (ms < MIN) return `${Math.floor(ms / 1000)}s`;
	if (ms < HOUR) return `${Math.floor(ms / MIN)}m`;
	if (ms < DAY)
		return `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MIN)}m`;
	return `${Math.floor(ms / DAY)}d ${Math.floor((ms % DAY) / HOUR)}h`;
}

/**
 * Duration in ms → its coarsest single unit: "45s", "47min", "3h", "2d".
 * For a line that has room for one number and no column to align it in
 * (a notification, a list row); reach for `span` when the remainder
 * matters. Minutes are spelled in full here because the value stands
 * alone with no neighbouring unit to read "m" against.
 */
export function coarseSpan(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}min`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

/** Elapsed since an instant, as a bare duration: "47m", "1h 40m" (no "ago"). */
export function since(d: Dateish, now: Dateish = Date.now()): string {
	const ms = toMs(d);
	const ref = toMs(now);
	if (ms == null || ref == null) return NO_DATA;
	return span(ref - ms);
}

/**
 * Past instant, humanized: "now" (<1m), "3m ago", "2h 15m ago" (<6h), then
 * clock time — "10:30" today, "yst 22:15" yesterday, "Mon 09:00" within 7
 * days, "07/28" beyond. Future inputs render "now".
 */
export function ago(d: Dateish, now: Dateish = Date.now()): string {
	const ms = toMs(d);
	const ref = toMs(now);
	if (ms == null || ref == null) return NO_DATA;
	const delta = ref - ms;
	if (delta < MIN) return "now";
	if (delta < HOUR) return `${Math.floor(delta / MIN)}m ago`;
	if (delta < 6 * HOUR)
		return `${Math.floor(delta / HOUR)}h ${Math.floor((delta % HOUR) / MIN)}m ago`;
	const date = new Date(ms);
	const refDate = new Date(ref);
	if (sameDay(date, refDate)) return clock(date);
	if (sameDay(date, new Date(ref - DAY))) return `yst ${clock(date)}`;
	if (delta < WEEK) return `${WEEKDAY[date.getDay()]} ${clock(date)}`;
	return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

/** Future instant, humanized: "now", "in 40m", "in 5h 12m", "in 3d 13h". */
export function until(d: Dateish, now: Dateish = Date.now()): string {
	const ms = toMs(d);
	const ref = toMs(now);
	if (ms == null || ref == null) return NO_DATA;
	const delta = ms - ref;
	if (delta < MIN) return "now";
	return `in ${span(delta)}`;
}

// ── time as a person types it ───────────────────────────────────────────────
// One vocabulary for every --since, --until and deadline a command line takes:
//   today · yesterday     that day
//   20:00 · 9:30          today, at that local time
//   30m · 2h · 3d · 1w    that long ago, or from now in a deadline
//   2026-10-05            that local day
//   anything else         an ISO datetime, as Date.parse reads it
// A day is a span, so where in it a bound falls is said by `edge`: a --since
// starts at its first instant, an --until ends at its last.

/** Where in a day a bound falls. */
export type Edge = "start" | "end";

const UNIT = { m: MIN, h: HOUR, d: DAY, w: WEEK } as const;
const VOCABULARY =
	"today · yesterday · 20:00 · 30m/2h/3d/1w · YYYY-MM-DD · ISO";

const dayEdge = (d: Date, edge: Edge) => {
	const out = new Date(d);
	if (edge === "start") out.setHours(0, 0, 0, 0);
	else out.setHours(23, 59, 59, 999);
	return out;
};

function absolute(s: string, edge: Edge, now: Date): Date | null {
	if (s === "today") return dayEdge(now, edge);
	if (s === "yesterday")
		return dayEdge(
			new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1),
			edge,
		);
	const at = s.match(/^(\d{1,2}):(\d{2})$/);
	if (at) {
		const [h, m] = [Number(at[1]), Number(at[2])];
		if (h > 23 || m > 59) throw new Error(`"${s}" is no time of day`);
		return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
	}
	const day = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (day) {
		const d = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
		if (d.getDate() !== Number(day[3])) throw new Error(`"${s}" is no day`);
		return dayEdge(d, edge);
	}
	return null;
}

/** An instant as typed, looking back: `2h` is two hours ago. Throws on anything
 *  outside the vocabulary, naming it. */
export function parseWhen(
	s: string,
	edge: Edge = "start",
	now: Date = new Date(),
): Date {
	const ago = s.match(/^(\d+)([mhdw])$/);
	if (ago)
		return new Date(
			now.getTime() - Number(ago[1]) * UNIT[ago[2] as keyof typeof UNIT],
		);
	const at = absolute(s, edge, now) ?? new Date(s);
	if (Number.isNaN(at.getTime()))
		throw new Error(`can't read time "${s}": ${VOCABULARY}`);
	return at;
}

/** A deadline as typed, looking forward: `2h` is two hours from now, a day ends
 *  at its last instant. Throws on anything outside the vocabulary. */
export function parseDeadline(s: string, now: Date = new Date()): Date {
	const ahead = s.match(/^(\d+)([mhdw])$/);
	if (ahead)
		return new Date(
			now.getTime() + Number(ahead[1]) * UNIT[ahead[2] as keyof typeof UNIT],
		);
	return parseWhen(s, "end", now);
}

/** A local day as typed: "2026-10-05". */
export const localDay = (d: Date): string =>
	`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** A local wall-clock instant: "2026-10-05 20:00". */
export const localStamp = (d: Date): string => `${localDay(d)} ${clock(d)}`;
