import { xdg } from './xdg.js';
import { dir } from './dir.js';
import { file } from './file.js';
import { join, dirname } from 'node:path';
const STORE_DIR = xdg.state('unseen');
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
export async function unseen(namespace, items, key) {
    const storePath = join(STORE_DIR, `${namespace}.json`);
    dir.create(dirname(storePath));
    const seen = new Set(file.exists(storePath) ? JSON.parse(file.readText(storePath)) : []);
    const result = [];
    for (const item of items) {
        const id = String(item[key]);
        if (!seen.has(id)) {
            seen.add(id);
            result.push(item);
        }
    }
    file.write(storePath, JSON.stringify([...seen]));
    return result;
}
//# sourceMappingURL=unseen.js.map