/**
 * A Next.js server's half of a page's trace (utils README, "Web pages"). A
 * request a page made carries the page's `traceparent` (log/web sets it on
 * every same-origin fetch), so what the server does under these wrappers is
 * a child of that request, in the page's trace:
 *
 *     export const POST = traced("POST /api/vote", async (s, request) => {
 *       await s.span("turso insert vote", () => db.execute(...))
 *       return Response.json({ ok: true })
 *     })
 *
 *     // in a "use server" file
 *     export const vote = tracedAction("vote", async (s, id: string) => { ... })
 *
 * A request with no traceparent is a root span of its own. Each wrapper hands
 * flushLog to `after`, so a serverless instance frozen once its response is
 * sent never holds unsent events (LOG_SHIP, set on the deployment, is where
 * they go).
 */

import { headers } from "next/headers";
import { after } from "next/server";
import { flushLog, log, type Span } from "../universal/log.js";

/** A route handler whose work is a span, joined to the caller's trace. */
export function traced<A extends unknown[], R>(
	name: string,
	handler: (s: Span, request: Request, ...rest: A) => Promise<R>,
): (request: Request, ...rest: A) => Promise<R> {
	return (request, ...rest) => {
		after(flushLog);
		return log
			.join(request.headers.get("traceparent"))
			.span(name, (s) => handler(s, request, ...rest));
	};
}

/** A server action whose work is a span, joined to the trace of the page that called it. */
export function tracedAction<A extends unknown[], R>(
	name: string,
	action: (s: Span, ...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
	return async (...args) => {
		after(flushLog);
		const parent = (await headers()).get("traceparent");
		return log.join(parent).span(name, (s) => action(s, ...args));
	};
}
