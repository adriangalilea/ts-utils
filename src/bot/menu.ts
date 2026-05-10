/**
 * Composable settings menu — registers a single slash command, renders
 * an `InlineKeyboard`, routes callbacks. Features (language, history,
 * etc.) contribute items; the bot builder adds custom items inline.
 *
 * ## Why menu is a separate primitive
 *
 * The user-facing menu is just UI — composing items. Features (per-user
 * state, recording, gates) have their OWN runtime behaviour independent
 * of any menu.
 *
 * ## GDPR rights (Forget / Export)
 *
 * If you pass `personalData: { storage }`, the menu adds two buttons:
 *
 *   - 🗑 Forget my data — `storage.delete(sessionKey(userId))`
 *   - 📥 Export my data — `storage.get(sessionKey(userId))` → JSON file
 *
 * Because all per-user state across our plugins lives in ONE shared
 * session record (see `bot/language`, `bot/message-history`), wiping
 * or exporting that single key covers everything in one shot. No
 * registry, no cascade, no per-plugin coordination.
 *
 * The `sessionKey` option defaults to `String(userId)` — matching
 * `@gramio/session`'s default `getSessionKey: (ctx) => `${ctx.senderId}`.
 * If you customize the session's `getSessionKey`, pass a matching
 * function here.
 *
 * ## Privacy URL
 *
 * `privacy` defaults to [Telegram's Standard Bot Privacy Policy](https://telegram.org/privacy-tpa).
 * Override when you retain content or process data beyond what the
 * standard covers.
 *
 * Peer deps: `gramio`, `@gramio/storage`.
 *
 * @example  Personal LLM bot — language only, no retention
 *
 * import { language } from '@adriangalilea/utils/bot/language'
 * import { botMenu } from '@adriangalilea/utils/bot/menu'
 *
 * const lang = language({ session: userSession, supported: ['en','es'] as const, default: 'en' })
 *
 * const menu = botMenu({
 *   command: 'settings',
 *   description: 'Open settings',
 *   adminContact: '@adriangalilea',
 *   items: [lang.menuItem],
 * })
 *
 * bot.extend(userSession).extend(lang.plugin).extend(menu.plugin)
 *
 * @example  Bot with retention — adds Forget/Export
 *
 * const menu = botMenu({
 *   command: 'settings',
 *   description: 'Open settings',
 *   adminContact: '@adriangalilea',
 *   privacy: 'https://yourbot.com/privacy',
 *   personalData: { storage },              // ← enables Forget/Export
 *   items: [lang.menuItem],
 * })
 *
 * bot
 *   .extend(userSession)
 *   .extend(history.plugin)
 *   .extend(menu.plugin)
 */
import {
  CallbackData,
  InlineKeyboard,
  Plugin,
} from 'gramio'
import type { Storage } from '@gramio/storage'

// ─── public types ──────────────────────────────────────────────────

type MenuCtx = {
  bot: unknown
  from?: { id: number }
  chat?: { id: number; type: string }
}

type Label = string | ((ctx: MenuCtx) => string)
type Predicate = (ctx: MenuCtx) => boolean
type Action = (ctx: MenuCtx) => Promise<void> | void

export type MenuItem =
  | { id: string; label: Label; action: Action; order?: number; visible?: Predicate }
  | { id: string; label: Label; url: string; order?: number; visible?: Predicate }
  | {
      id: string
      label: Label
      submenu: MenuItem[]
      order?: number
      visible?: Predicate
    }

export type PersonalDataOptions = {
  /**
   * Storage backend where each user's data lives. Must be the SAME
   * instance you passed to your `session(...)` plugin — that's how
   * /forget and /export reach the right keys.
   */
  storage: Storage
  /**
   * How to compute the storage key for a given user id. Defaults to
   * `String(userId)` — matching `@gramio/session`'s default
   * `getSessionKey`. Override if your session uses a custom
   * `getSessionKey`.
   */
  sessionKey?: (userId: number) => string
}

export type BotMenuOptions = {
  /** Slash command that opens the menu. Default `'settings'`. */
  command?: string
  /** Description shown in Telegram's command list. */
  description?: string
  /** Items rendered top-down (sorted by `order`, then registration). */
  items?: MenuItem[]
  /**
   * URL to your privacy policy. Defaults to Telegram's Standard Bot
   * Privacy Policy. Override when you retain content or process data
   * beyond what the standard covers.
   */
  privacy?: string
  /**
   * Header text rendered above the keyboard.
   */
  header?: Label
  /**
   * Contact the user can reach when something fails (export error,
   * etc.). **Required** — a bot that asks users to trust it with
   * data must always offer a human to talk to when the automated
   * paths fail.
   */
  adminContact: string
  /**
   * Enables 🗑 Forget my data and 📥 Export my data buttons. Pass
   * the storage instance backing your `session()`. If omitted, the
   * buttons don't appear (use this for bots with no per-user state
   * beyond what Telegram's standard policy covers).
   */
  personalData?: PersonalDataOptions
}

const DEFAULT_COMMAND = 'settings'
const DEFAULT_DESCRIPTION = 'Open settings menu'
const DEFAULT_PRIVACY_URL = 'https://telegram.org/privacy-tpa'
const DEFAULT_HEADER = '⚙️ Settings'
const DEFAULT_SESSION_KEY = (userId: number) => String(userId)

// ─── callback data schemas ─────────────────────────────────────────

const navCb = new CallbackData('mNav').string('path')
const actCb = new CallbackData('mAct').string('path')
const forgetConfirmCb = new CallbackData('mFcfm')
const forgetCancelCb = new CallbackData('mFcnl')
const exportCb = new CallbackData('mExp')

// ─── BotMenu (the builder) ─────────────────────────────────────────

type ResolvedPersonalData = {
  storage: Storage
  sessionKey: (userId: number) => string
}

type ResolvedOpts = {
  command: string
  description: string
  privacy: string
  header: Label
  adminContact: string
  personalData: ResolvedPersonalData | null
}

export class BotMenu {
  /** @internal */
  readonly _items: MenuItem[]
  /** @internal */
  readonly _opts: ResolvedOpts

  constructor(opts: BotMenuOptions) {
    this._items = [...(opts.items ?? [])]
    this._opts = {
      command: opts.command ?? DEFAULT_COMMAND,
      description: opts.description ?? DEFAULT_DESCRIPTION,
      privacy: opts.privacy ?? DEFAULT_PRIVACY_URL,
      header: opts.header ?? DEFAULT_HEADER,
      adminContact: opts.adminContact,
      personalData: opts.personalData
        ? {
            storage: opts.personalData.storage,
            sessionKey: opts.personalData.sessionKey ?? DEFAULT_SESSION_KEY,
          }
        : null,
    }
  }

  /** Append a custom item. Mutates the menu. */
  add(item: MenuItem): this {
    this._items.push(item)
    return this
  }

  /** The gramio plugin: registers the slash command + all callback handlers. */
  get plugin() {
    return buildMenuPlugin(this)
  }
}

export const botMenu = (opts: BotMenuOptions): BotMenu => new BotMenu(opts)

// ─── internal: rendering + plugin ──────────────────────────────────

const labelOf = (l: Label, ctx: MenuCtx): string =>
  typeof l === 'function' ? l(ctx) : l

const itemsForPath = (root: MenuItem[], path: string[]): MenuItem[] | null => {
  if (path.length === 0) return root
  const [head, ...rest] = path
  const found = root.find((i) => i.id === head)
  if (!found || !('submenu' in found)) return null
  return itemsForPath(found.submenu, rest)
}

const itemForPath = (root: MenuItem[], path: string[]): MenuItem | null => {
  if (path.length === 0) return null
  let current: MenuItem[] | undefined = root
  let last: MenuItem | undefined
  for (const segment of path) {
    if (!current) return null
    last = current.find((i) => i.id === segment)
    if (!last) return null
    current = 'submenu' in last ? last.submenu : undefined
  }
  return last ?? null
}

const renderKeyboard = (
  menu: BotMenu,
  items: MenuItem[],
  ctx: MenuCtx,
  parentPath: string[],
): InlineKeyboard => {
  const kb = new InlineKeyboard()

  const sorted = [...items]
    .filter((i) => (i.visible ? i.visible(ctx) : true))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

  for (const item of sorted) {
    const path = [...parentPath, item.id].join('.')
    const label = labelOf(item.label, ctx)

    if ('action' in item) {
      kb.text(label, actCb.pack({ path }))
    } else if ('url' in item) {
      kb.url(label, item.url)
    } else {
      kb.text(label, navCb.pack({ path }))
    }
    kb.row()
  }

  if (parentPath.length === 0) {
    // GDPR rights buttons at the root view.
    if (menu._opts.personalData) {
      kb.text('🗑 Forget my data', actCb.pack({ path: '_forget' }))
      kb.row()
      kb.text('📥 Export my data', exportCb.pack({}))
      kb.row()
    }
    // Privacy link.
    kb.url('📖 Privacy', menu._opts.privacy)
    kb.row()
  } else {
    const backPath = parentPath.slice(0, -1).join('.')
    kb.text('⬅️ Back', navCb.pack({ path: backPath || '_root' }))
  }

  return kb
}

const renderConfirmForget = (): InlineKeyboard =>
  new InlineKeyboard()
    .text('✅ Confirm delete', forgetConfirmCb.pack({}))
    .row()
    .text('⬅️ Cancel', forgetCancelCb.pack({}))

const buildMenuPlugin = (menu: BotMenu) => {
  const { command, description, header, personalData, adminContact } = menu._opts

  return new Plugin('@adriangalilea/utils/bot/menu')
    .command(command, { description }, async (ctx) => {
      const kb = renderKeyboard(menu, menu._items, ctx, [])
      await ctx.send(labelOf(header, ctx), { reply_markup: kb })
    })
    // Navigate (root / submenu)
    .callbackQuery(navCb, async (ctx) => {
      const raw = ctx.queryData.path
      const segments = raw === '_root' ? [] : raw.split('.')
      const items = itemsForPath(menu._items, segments)
      if (!items) {
        await ctx.answer({ text: 'Menu out of date.' })
        return
      }
      await ctx.answer({})
      const kb = renderKeyboard(menu, items, ctx, segments)
      try {
        await ctx.editText(labelOf(header, ctx), { reply_markup: kb })
      } catch {
        // message too old to edit
      }
    })
    // Action items + the forget pre-confirmation
    .callbackQuery(actCb, async (ctx) => {
      const raw = ctx.queryData.path
      if (raw === '_forget') {
        await ctx.answer({})
        try {
          await ctx.editText(
            '⚠️ Delete all your data?\n\n' +
              'This removes the session record we keep about you ' +
              '(preferences, history, access state). Not reversible.',
            { reply_markup: renderConfirmForget() },
          )
        } catch {
          /* ignore */
        }
        return
      }
      const item = itemForPath(menu._items, raw.split('.'))
      if (!item || !('action' in item)) {
        await ctx.answer({ text: 'Item not found.' })
        return
      }
      await ctx.answer({})
      await item.action(ctx)
    })
    // Forget — confirm path
    .callbackQuery(forgetConfirmCb, async (ctx) => {
      if (!personalData) {
        await ctx.answer({ text: 'Not configured.', show_alert: true })
        return
      }
      const userId = ctx.from?.id
      if (userId === undefined) return ctx.answer({ text: 'No user.' })

      try {
        await personalData.storage.delete(personalData.sessionKey(userId))
        await ctx.answer({ text: 'Deleted.' })
        try {
          await ctx.editText('✅ Your data has been deleted.')
        } catch {
          /* ignore */
        }
      } catch (e) {
        console.error('[menu] /forget failed', e)
        await ctx.answer({ text: 'Failed.' })
        await ctx.send(
          `❌ Could not delete your data.\n\nPlease contact ${adminContact}.`,
        )
      }
    })
    .callbackQuery(forgetCancelCb, async (ctx) => {
      await ctx.answer({})
      const kb = renderKeyboard(menu, menu._items, ctx, [])
      try {
        await ctx.editText(labelOf(header, ctx), { reply_markup: kb })
      } catch {
        /* ignore */
      }
    })
    // Export — JSON file with the user's whole session record
    .callbackQuery(exportCb, async (ctx) => {
      if (!personalData) {
        await ctx.answer({ text: 'Not configured.', show_alert: true })
        return
      }
      const userId = ctx.from?.id
      if (userId === undefined) return ctx.answer({ text: 'No user.' })

      const record =
        (await personalData.storage.get(personalData.sessionKey(userId))) ?? {}
      const file = new File(
        [JSON.stringify({ userId, exportedAt: Date.now(), data: record }, null, 2)],
        `my-data-${userId}-${Date.now()}.json`,
        { type: 'application/json' },
      )

      await ctx.answer({})
      try {
        await ctx.sendDocument(file, { caption: '📥 Your data export' })
      } catch (e) {
        console.error('[menu] /export sendDocument failed', e)
        await ctx.send(
          `❌ Could not send your data export.\n\nPlease contact ${adminContact}.`,
        )
      }
    })
}
