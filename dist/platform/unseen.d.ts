/**
 * Persistent dedup filter — "what's new since last time?"
 *
 * Makes any script idempotent. Run it once, run it a thousand times —
 * you only process each item once. This means any scheduling works:
 * manual `tsx check.ts`, a fish loop, a cron job, whatever.
 * Can't double-notify, can't miss items, can't corrupt state.
 *
 *   1st run: 5 orders exist  → returns 5
 *   2nd run: same 5 orders   → returns 0
 *   3rd run: 7 orders exist  → returns 2
 *
 * ```ts
 * const fresh = await unseen('orders', allOrders, o => o.id)
 * for (const o of fresh) await notify(o.summary)
 * ```
 *
 * State persists at `~/.local/state/unseen/{namespace}.json`
 *
 * @param namespace - Seen-set name (e.g. 'messages', 'github-issues', 'orders')
 * @param items - Items to filter
 * @param key - Extract a unique string key from each item
 * @returns Only items whose key hasn't been seen before
 */
export declare function unseen<T>(namespace: string, items: T[], key: (item: T) => string): Promise<T[]>;
//# sourceMappingURL=unseen.d.ts.map