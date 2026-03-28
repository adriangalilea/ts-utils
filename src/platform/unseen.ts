import { xdg } from './xdg.js'
import { dir } from './dir.js'
import { file } from './file.js'
import { join, dirname } from 'node:path'

const STORE_DIR = xdg.state('unseen')

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
export async function unseen<T>(namespace: string, items: T[], key: (item: T) => string): Promise<T[]> {
  const storePath = join(STORE_DIR, `${namespace}.json`)
  dir.create(dirname(storePath))

  const seen: Set<string> = new Set(
    file.exists(storePath) ? JSON.parse(file.readText(storePath)) as string[] : []
  )

  const result: T[] = []
  for (const item of items) {
    const k = key(item)
    if (!seen.has(k)) {
      seen.add(k)
      result.push(item)
    }
  }

  file.write(storePath, JSON.stringify([...seen]))
  return result
}
