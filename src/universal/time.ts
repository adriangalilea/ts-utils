/**
 * Humanized time. Three questions, three functions: how long is this
 * duration (`span`), how long ago was this instant (`ago` — and its raw-
 * duration twin `since`), how long until this instant (`until`).
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
