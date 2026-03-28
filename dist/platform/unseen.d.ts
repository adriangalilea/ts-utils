/**
 * Persistent dedup filter for arrays of objects.
 *
 * You have objects with IDs. `unseen` remembers which IDs it has
 * seen across runs and returns only the new ones.
 *
 * ```ts
 * type Message = { id: string, text: string }
 *
 * const messages: Message[] = await fetchMessages()
 * const newMessages = await unseen('messages', messages, 'id')
 *
 * // 1st run: 3 messages exist  → returns all 3
 * // 2nd run: same 3 messages   → returns []
 * // 3rd run: 5 messages exist  → returns the 2 new ones
 * ```
 *
 * Makes any script idempotent — run it once or a thousand times,
 * you only process each item once. Any scheduling works.
 *
 * State persists at `~/.local/state/unseen/{namespace}.json`
 *
 * @param namespace - Name for this seen-set (e.g. 'messages', 'orders')
 * @param items - Array of objects to filter
 * @param key - Which field is the unique ID (e.g. 'id', 'messageId', 'bdnsCode')
 * @returns Only items not seen in previous runs
 */
export declare function unseen<T>(namespace: string, items: T[], key: keyof T & string): Promise<T[]>;
//# sourceMappingURL=unseen.d.ts.map