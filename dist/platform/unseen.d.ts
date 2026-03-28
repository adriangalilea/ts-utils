/**
 * "What's new since last time?" — filters an array of objects to only
 * the ones you haven't seen before. Remembers across runs.
 *
 * ```ts
 * const messages = await fetchMessages()
 * const newMessages = await unseen('messages', messages, 'id')
 *
 * // 1st run: messages = [{ id: '1', from: 'alice' }, { id: '2', from: 'bob' }]
 * //          newMessages = [{ id: '1', from: 'alice' }, { id: '2', from: 'bob' }]
 * // 2nd run: messages = [{ id: '1', from: 'alice' }, { id: '2', from: 'bob' }]
 * //          newMessages = []
 * // 3rd run: messages = [{ id: '1', ... }, { id: '2', ... }, { id: '3', from: 'bob' }]
 * //          newMessages = [{ id: '3', from: 'bob' }]
 * ```
 *
 * Idempotent — safe to re-run.
 * State: `$XDG_STATE_HOME/unseen/{namespace}.json`
 *
 * @param namespace - Name for this seen-set (e.g. 'messages', 'orders')
 * @param items - Array of objects to filter
 * @param key - Which field is the unique ID (e.g. 'id', 'messageId')
 * @returns Only items not seen in previous runs
 */
export declare function unseen<T>(namespace: string, items: T[], key: keyof T & string): Promise<T[]>;
//# sourceMappingURL=unseen.d.ts.map