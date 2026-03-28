/**
 * Filters an array of objects to only the ones you haven't seen before.
 * Remembers across runs. Safe to re-run on any schedule.
 *
 * ```ts
 * const messages = await fetchMessages()
 * const newMessages = await unseen('messages', messages, 'id')
 * // First run → all messages. Second run → only new ones.
 * ```
 *
 * State: `$XDG_STATE_HOME/unseen/{namespace}.json`
 *
 * @param namespace - Name for this seen-set (e.g. 'messages', 'orders')
 * @param items - Array of objects to filter
 * @param key - Which field is the unique ID (e.g. 'id', 'messageId')
 * @returns Only items not seen in previous runs
 */
export declare function unseen<T>(namespace: string, items: T[], key: keyof T & string): Promise<T[]>;
//# sourceMappingURL=unseen.d.ts.map