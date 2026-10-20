/**
 * Assert-based checks for the pure `cli/live` widgets that do arithmetic:
 * `rate()` must read a stall as a falling speed and a restart as a new window,
 * the same as go-utils' `cli.Rate`.
 */
import { strict as assert } from "node:assert";
import { eta, rate } from "./live.js";

const realNow = Date.now;
let now = 1_000_000;
Date.now = () => now;
try {
	const r = rate();
	assert.equal(r.perSecond(), 0); // nothing yet
	r.add(0);
	now += 2000;
	r.add(20_000_000);
	assert.equal(r.perSecond(), 10_000_000); // 20 MB in 2 s

	now += 2000; // silence: measured to now, the speed falls
	assert.equal(r.perSecond(), 5_000_000);

	r.add(5); // below the last total: a restart, the window begins again
	assert.equal(r.perSecond(), 0);

	const w = rate(1000); // old samples leave the window
	w.add(0);
	now += 5000;
	w.add(100);
	now += 500;
	w.add(200);
	assert.equal(w.perSecond(), 200); // the 0 at t0 left: 100 more over the last 0.5 s
} finally {
	Date.now = realNow;
}

assert.equal(eta(100, 10), 10_000);
assert.equal(eta(100, 0), 0);
assert.equal(eta(0, 10), 0);
