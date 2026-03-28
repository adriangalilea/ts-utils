import { xdg } from './xdg.js'
import { dir } from './dir.js'
import { file } from './file.js'
import { join, dirname } from 'node:path'

const STORE_DIR = xdg.state('unseen')

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
export async function unseen<T>(namespace: string, items: T[], key: keyof T & string): Promise<T[]> {
  const storePath = join(STORE_DIR, `${namespace}.json`)
  dir.create(dirname(storePath))

  const seen: Set<string> = new Set(
    file.exists(storePath) ? JSON.parse(file.readText(storePath)) as string[] : []
  )

  const result: T[] = []
  for (const item of items) {
    const id = String(item[key])
    if (!seen.has(id)) {
      seen.add(id)
      result.push(item)
    }
  }

  file.write(storePath, JSON.stringify([...seen]))
  return result
}
