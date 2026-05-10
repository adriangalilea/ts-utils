/**
 * Access control for personal GramIO bots — a one-stop guard +
 * approve/deny + revocable allow-list with an inline admin menu.
 *
 *                stranger DMs your bot
 *                       │
 *                       ▼
 *      ┌──── plugin gate (this file) ────────────────────┐
 *      │  ctx.from.id  ∈  admin / defaults / approved?   │
 *      │     yes → next()                                │
 *      │     no  → drop + notify admin (rate-limited)    │
 *      └─────────────────────────────────────────────────┘
 *                       │
 *           admin gets DM with [✅ Aprobar] [❌ Denegar]
 *                       │
 *                  admin taps
 *                       │
 *      stranger's session updated  ·  stranger gets DM
 *
 * **Storage layout.** This plugin stores its per-user record under
 * the `access` field of the shared session record (see
 * `bot/CLAUDE.md` § "Shared session, one record per user"). All
 * per-user state across our plugins coexists in the same record:
 *
 *     storage[String(userId)] = {
 *       access:   { status, approvedAt, … },   // ← this plugin
 *       language: 'es',                         // ← bot/language
 *       history:  { items: [...] },             // ← bot/message-history
 *     }
 *
 * Plus one tiny admin-side index so `/access` can list pending /
 * approved / denied without scanning every user:
 *
 *     storage['ac:index'] = { pending: [...ids], approved: [...], denied: [...] }
 *
 * **Cross-user mutations.** When the admin taps `[✅ Aprobar]` on
 * Pepe's notification, `ctx` is the admin's, so `ctx.session` is the
 * admin's record — useless for mutating Pepe. We reach for Pepe's
 * record directly via `storage.get(String(pepeId))`, preserve other
 * plugins' fields in it (read-modify-write), and put it back.
 *
 * **Composes with**:
 *   - `adminContext` (kit.ts) — required, gives us `ctx.adminId` /
 *     `ctx.isAdmin`. Declared as a runtime dependency.
 *   - `@gramio/session` — the user creates ONE session at bot level
 *     and passes it to this plugin (and the other session-using
 *     ones). gramio's runtime dedup ensures the session derive runs
 *     exactly once per update.
 *
 * Peer deps: `gramio`, `@gramio/session`, `@gramio/storage`.
 *
 * @example
 * import { Bot } from 'gramio'
 * import { session } from '@gramio/session'
 * import { redisStorage } from '@gramio/storage-redis'
 * import { adminContext, gracefulStart } from '@adriangalilea/utils/bot/kit'
 * import { accessControl } from '@adriangalilea/utils/bot/access-control'
 *
 * const storage = redisStorage()
 * const userSession = session({ storage, key: 'session', initial: () => ({}) })
 *
 * const bot = new Bot(process.env.BOT_TOKEN!)
 *   .extend(adminContext({ adminId: 190202471 }))
 *   .extend(userSession)
 *   .extend(accessControl({ session: userSession, storage, defaults: [1158734055] }))
 *   .command('start', (ctx) => ctx.send(`source=${ctx.access.source ?? 'denied'}`))
 *
 * await gracefulStart(bot)
 */
import {
  type AnyBot,
  CallbackData,
  type DeriveDefinitions,
  InlineKeyboard,
  Plugin,
} from 'gramio'
import { session } from '@gramio/session'
import { type Storage } from '@gramio/storage'

// Cross-user mutations (admin approves Pepe → write to Pepe's session)
// hit `storage` directly using the same key format `@gramio/session`
// uses by default: `String(userId)`. We preserve other plugins' fields
// in the same session record by read-modify-write.
const INDEX_KEY = 'ac:index'
const FIRST_MSG_LIMIT = 200
const DEFAULT_DENY_MSG = 'Este bot es privado. Tu solicitud se ha enviado al admin.'
const DEFAULT_THROTTLE_MS = 6 * 60 * 60 * 1000

/** gramio's `@gramio/session` default `getSessionKey` is `String(senderId)`. */
const sessionKey = (userId: number) => String(userId)

// ─── public types ──────────────────────────────────────────────────

export type AccessStatus = 'unknown' | 'pending' | 'approved' | 'denied'

export type AccessUser = {
  id: number
  firstName?: string
  lastName?: string
  username?: string
}

/**
 * What this plugin persists under `ctx.session.access` per user. When
 * `ctx.session.access` is `undefined`, the user has never interacted
 * (or has been wiped via /forget). The plugin treats that as
 * status='unknown' for gating purposes.
 */
export type AccessRecord = {
  status: AccessStatus
  user?: AccessUser
  /** Chat to DM the user back. For private chats this equals user.id. */
  chatId?: number
  requestedAt?: number
  approvedAt?: number
  approvedBy?: number
  deniedAt?: number
  deniedBy?: number
  /** First message text from the request (truncated). */
  firstMessage?: string
  lastActivityAt?: number
  messageCount?: number
  /** Counts attempts after the initial request — used by the throttle. */
  rejectedAttempts?: number
  lastNotifiedAt?: number
}

export type AccessIndex = {
  pending: number[]
  approved: number[]
  denied: number[]
}

export type AccessSource = 'admin' | 'default' | 'store'

/**
 * What handlers downstream see on `ctx.access`. A discriminated union —
 * use the `allowed` field to narrow.
 */
export type AccessInfo =
  | {
      allowed: true
      source: AccessSource
      /** The persisted record, when source is 'store'. */
      record?: AccessRecord
    }
  | {
      allowed: false
      reason: 'denied' | 'pending' | 'unknown' | 'no-sender'
    }

/** Loose session shape — this plugin only touches the `access` field. */
type SessionLike = { access?: AccessRecord }

/** @internal — kept unexported so it doesn't clash with peers' refs. */
type AcSessionPluginRef = ReturnType<typeof session<SessionLike, 'session'>>

export type AccessControlOptions = {
  /**
   * Shared session plugin. This plugin extends it for type flow;
   * gramio's runtime dedup ensures it only runs once per update.
   * `ctx.session.access` is where the per-user access record lives.
   */
  session: AcSessionPluginRef
  /**
   * Storage backend for cross-user mutations (admin approves Pepe →
   * write to Pepe's session record from admin's ctx). Must be the
   * same storage instance passed to `session()`.
   */
  storage: Storage
  /** Always-allowed user ids, hardcoded. Bypass the entire flow. */
  defaults?: ReadonlyArray<number>
  /** Reply sent to denied users on first attempt. `false` to silence. */
  denyMessage?: string | false
  /** Min ms between repeat admin notifications for the same user. Default 6h. */
  notifyThrottleMs?: number
  /** Callbacks for your own logging / metrics. */
  onAccessRequest?: (info: { user: AccessUser; firstMessage?: string }) => void
  onApprove?: (info: { userId: number; approvedBy: number }) => void
  onDeny?: (info: { userId: number; deniedBy: number }) => void
}

// ─── derived context shapes ────────────────────────────────────────

type AdminDerives = { adminId: number; isAdmin: boolean }
type AccessDerives = { access: AccessInfo }
// Session's derives are per-event (message, callback_query, …) per
// `@gramio/session`. We declare it globally here because every
// handler in this plugin runs on those events (commands, callbacks).
// gramio's runtime guarantees the session is loaded before our
// derive/handlers fire on those events.
type SessionDerives = {
  session: SessionLike & { $clear: () => Promise<void> }
}

type AcDerives = DeriveDefinitions & {
  global: AdminDerives & AccessDerives & SessionDerives
}

// ─── callback schemas ──────────────────────────────────────────────
//
// Short `nameId`s keep callback_data under Telegram's 64-byte cap.
// `v` (optional) carries the originating list view ('pending' | 'denied'
// | 'approved'). When present, the handler refreshes that list after
// the action; absent = original notification, edits the message inline.
const acApprove = new CallbackData('acA').number('uid').string('v', { optional: true })
const acDeny = new CallbackData('acD').number('uid').string('v', { optional: true })
const acRevoke = new CallbackData('acR').number('uid')
const acView = new CallbackData('acV').string('v') // main | approved | pending | denied
const acClose = new CallbackData('acC')

// ─── small helpers ─────────────────────────────────────────────────

const formatUser = (u: AccessUser | undefined, fallbackId: number): string => {
  if (!u) return `id ${fallbackId}`
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || `id ${u.id}`
  const handle = u.username ? `@${u.username}` : `id ${u.id}`
  return `${name} (${handle})`
}

const fmtAge = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}min`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

const requestNotificationText = (
  uid: number,
  r: AccessRecord,
  repeat: boolean,
): string => {
  const parts = [
    repeat ? '🔁 Acceso re-solicitado' : '🔔 Acceso solicitado',
    '',
    `👤 ${formatUser(r.user, uid)}`,
    `🆔 ${uid}`,
    `⏰ hace ${fmtAge(Date.now() - (r.requestedAt ?? Date.now()))}`,
  ]
  if (repeat) parts.push(`🔁 intentos: ${(r.rejectedAttempts ?? 0) + 1}`)
  if (r.firstMessage) parts.push('', `💬 "${r.firstMessage}"`)
  return parts.join('\n')
}

const requestKeyboard = (uid: number) =>
  new InlineKeyboard()
    .text('✅ Aprobar', acApprove.pack({ uid }))
    .text('❌ Denegar', acDeny.pack({ uid }))

// ─── index helpers ─────────────────────────────────────────────────

const emptyIndex = (): AccessIndex => ({ pending: [], approved: [], denied: [] })

const loadIndex = async (storage: Storage): Promise<AccessIndex> => {
  const raw = (await storage.get(INDEX_KEY)) as Partial<AccessIndex> | undefined
  return {
    pending: raw?.pending ?? [],
    approved: raw?.approved ?? [],
    denied: raw?.denied ?? [],
  }
}

const saveIndex = (storage: Storage, idx: AccessIndex) => storage.set(INDEX_KEY, idx)

const indexAdd = async (
  storage: Storage,
  bucket: keyof AccessIndex,
  uid: number,
): Promise<void> => {
  const idx = await loadIndex(storage)
  if (!idx[bucket].includes(uid)) idx[bucket].push(uid)
  await saveIndex(storage, idx)
}

const indexMove = async (
  storage: Storage,
  uid: number,
  from: keyof AccessIndex | 'any',
  to: keyof AccessIndex,
): Promise<void> => {
  const idx = await loadIndex(storage)
  const remove = (list: number[]) => {
    const i = list.indexOf(uid)
    if (i >= 0) list.splice(i, 1)
  }
  if (from === 'any') {
    remove(idx.pending)
    remove(idx.approved)
    remove(idx.denied)
  } else {
    remove(idx[from])
  }
  if (!idx[to].includes(uid)) idx[to].push(uid)
  await saveIndex(storage, idx)
}

// ─── per-user record helpers (cross-user storage access) ───────────
//
// When admin approves a stranger, we mutate the stranger's session
// record from the admin's ctx. We can't access the stranger's session
// via gramio's session plugin (it's per-ctx), so we hit `storage`
// directly using the same key format `@gramio/session` uses
// (`String(userId)`). We preserve OTHER plugins' fields in the same
// record via read-modify-write.

type FullSessionRecord = { access?: AccessRecord } & Record<string, unknown>

const loadFullRecord = async (
  storage: Storage,
  userId: number,
): Promise<FullSessionRecord> =>
  ((await storage.get(sessionKey(userId))) as FullSessionRecord | undefined) ?? {}

const saveAccess = async (
  storage: Storage,
  userId: number,
  rec: AccessRecord,
): Promise<void> => {
  const full = await loadFullRecord(storage, userId)
  full.access = rec
  await storage.set(sessionKey(userId), full)
}

const loadAccess = async (
  storage: Storage,
  userId: number,
): Promise<AccessRecord | undefined> => {
  const full = await loadFullRecord(storage, userId)
  return full.access
}

// ─── plugin ────────────────────────────────────────────────────────

export const accessControl = (opts: AccessControlOptions) => {
  const { session: sessionPlugin, storage } = opts
  const defaults = new Set(opts.defaults ?? [])
  const denyMessage =
    opts.denyMessage === false ? null : (opts.denyMessage ?? DEFAULT_DENY_MSG)
  const throttleMs = opts.notifyThrottleMs ?? DEFAULT_THROTTLE_MS

  return (
    // Generic declares dependency on adminContext's derives so
    // ctx.adminId / ctx.isAdmin are typed inside our handlers.
    // Session-side types flow through `.extend(opts.session)` below
    // and TypeScript merges them with our generic via the chain.
    new Plugin<{}, AcDerives>('@adriangalilea/utils/bot/access-control', {
      dependencies: ['@adriangalilea/utils/bot/admin'],
    })
      // Declare the shared session as a dependency. gramio's runtime
      // dedups against the bot's top-level extension; types flow.
      .extend(sessionPlugin)
      // Compute the gate decision so handlers can read `ctx.access` ergonomically.
      .derive((ctx) => {
        // Only message + callback_query carry a senderId we can gate on.
        if (!ctx.is('message') && !ctx.is('callback_query')) {
          return { access: { allowed: false, reason: 'no-sender' } satisfies AccessInfo }
        }
        const senderId = ctx.from.id

        if (senderId === ctx.adminId) {
          return { access: { allowed: true, source: 'admin' } satisfies AccessInfo }
        }
        if (defaults.has(senderId)) {
          return { access: { allowed: true, source: 'default' } satisfies AccessInfo }
        }

        // ctx.session.access may be undefined for first-ever interaction
        // (session.initial() returns {} so .access isn't set yet).
        const rec = ctx.session.access ?? ({ status: 'unknown' } satisfies AccessRecord)
        if (rec.status === 'approved') {
          return { access: { allowed: true, source: 'store', record: rec } satisfies AccessInfo }
        }
        return {
          access: { allowed: false, reason: rec.status } satisfies AccessInfo,
        }
      })
      // Gate. Authorized passes through; unauthorized triggers admin notify
      // and silent stranger reply, then drops.
      .use(async (ctx, next) => {
        if (ctx.access.allowed) {
          // Activity bump (only for store-approved users — admins/defaults
          // don't have a session record we want to clutter).
          if (
            ctx.access.source === 'store' &&
            ctx.is('message') &&
            ctx.session.access
          ) {
            ctx.session.access = {
              ...ctx.session.access,
              lastActivityAt: Date.now(),
              messageCount: (ctx.session.access.messageCount ?? 0) + 1,
            }
          }
          return next()
        }

        // Acknowledge unauthorized callback queries so the spinner clears.
        if (ctx.is('callback_query')) {
          await ctx.answer({ text: 'Sin acceso.', show_alert: false })
          return
        }
        // Only message-shaped events have .text/.chat for our notification.
        if (!ctx.is('message')) return

        const userId = ctx.from.id
        const existing = ctx.session.access
        const now = Date.now()
        const isFirstRequest = !existing || existing.status === 'unknown'

        const rec: AccessRecord = isFirstRequest
          ? {
              status: 'pending',
              user: {
                id: userId,
                firstName: ctx.from.firstName,
                lastName: ctx.from.lastName,
                username: ctx.from.username,
              },
              chatId: ctx.chat.id,
              requestedAt: now,
              firstMessage: ctx.text?.slice(0, FIRST_MSG_LIMIT),
              messageCount: 0,
              rejectedAttempts: 0,
            }
          : { ...existing! }

        if (isFirstRequest) {
          await indexAdd(storage, 'pending', userId)
        } else {
          rec.rejectedAttempts = (rec.rejectedAttempts ?? 0) + 1
        }

        const shouldNotify =
          isFirstRequest || now - (rec.lastNotifiedAt ?? 0) > throttleMs
        if (shouldNotify) {
          rec.lastNotifiedAt = now
          try {
            await ctx.bot.api.sendMessage({
              chat_id: ctx.adminId,
              text: requestNotificationText(userId, rec, !isFirstRequest),
              reply_markup: requestKeyboard(userId),
            })
          } catch (e) {
            console.error(
              '[access-control] failed to notify admin (have you /started the bot from your account?)',
              e,
            )
          }
          opts.onAccessRequest?.({ user: rec.user!, firstMessage: rec.firstMessage })
        }

        // Persist the updated record to the user's session.
        ctx.session.access = rec

        if (denyMessage && isFirstRequest) {
          try {
            await ctx.send(denyMessage)
          } catch {
            // user blocked the bot — irrelevant
          }
        }
        // do NOT call next — drop
      })
      // ─── admin actions ────────────────────────────────────────
      .callbackQuery(acApprove, async (ctx) => {
        if (!ctx.isAdmin) return ctx.answer({ text: 'Solo admin.', show_alert: true })
        const uid = ctx.queryData.uid
        const rec = await loadAccess(storage, uid)
        if (!rec) return ctx.answer({ text: 'No encontrado.' })

        const wasDenied = rec.status === 'denied'
        const wasPending = rec.status === 'pending'
        rec.status = 'approved'
        rec.approvedAt = Date.now()
        rec.approvedBy = ctx.adminId
        rec.deniedAt = undefined
        rec.deniedBy = undefined
        await saveAccess(storage, uid, rec)
        await indexMove(
          storage,
          uid,
          wasPending ? 'pending' : wasDenied ? 'denied' : 'any',
          'approved',
        )

        if (rec.chatId !== undefined) {
          try {
            await ctx.bot.api.sendMessage({
              chat_id: rec.chatId,
              text: wasDenied
                ? '✅ El admin reconsideró: ya tienes acceso.'
                : '✅ Acceso concedido. Ya puedes usar el bot.',
            })
          } catch {
            // user blocked / chat gone
          }
        }
        await ctx.answer({ text: '✅ Aprobado' })

        if (ctx.queryData.v) {
          await renderView(ctx, storage, defaults, ctx.queryData.v)
        } else {
          try {
            await ctx.editText(`✅ Aprobado · ${formatUser(rec.user, uid)}`)
          } catch {
            // not always editable
          }
        }
        opts.onApprove?.({ userId: uid, approvedBy: ctx.adminId })
      })
      .callbackQuery(acDeny, async (ctx) => {
        if (!ctx.isAdmin) return ctx.answer({ text: 'Solo admin.', show_alert: true })
        const uid = ctx.queryData.uid
        const rec = await loadAccess(storage, uid)
        if (!rec) return ctx.answer({ text: 'No encontrado.' })

        const wasPending = rec.status === 'pending'
        rec.status = 'denied'
        rec.deniedAt = Date.now()
        rec.deniedBy = ctx.adminId
        await saveAccess(storage, uid, rec)
        await indexMove(storage, uid, wasPending ? 'pending' : 'any', 'denied')

        if (rec.chatId !== undefined) {
          try {
            await ctx.bot.api.sendMessage({
              chat_id: rec.chatId,
              text: '❌ Acceso denegado.',
            })
          } catch {
            // ignore
          }
        }
        await ctx.answer({ text: '❌ Denegado' })

        if (ctx.queryData.v) {
          await renderView(ctx, storage, defaults, ctx.queryData.v)
        } else {
          try {
            await ctx.editText(`❌ Denegado · ${formatUser(rec.user, uid)}`)
          } catch {
            // ignore
          }
        }
        opts.onDeny?.({ userId: uid, deniedBy: ctx.adminId })
      })
      .callbackQuery(acRevoke, async (ctx) => {
        if (!ctx.isAdmin) return ctx.answer({ text: 'Solo admin.', show_alert: true })
        const uid = ctx.queryData.uid
        const rec = await loadAccess(storage, uid)
        if (!rec) return ctx.answer({ text: 'No encontrado.' })

        rec.status = 'denied'
        rec.deniedAt = Date.now()
        rec.deniedBy = ctx.adminId
        await saveAccess(storage, uid, rec)
        await indexMove(storage, uid, 'approved', 'denied')

        if (rec.chatId !== undefined) {
          try {
            await ctx.bot.api.sendMessage({
              chat_id: rec.chatId,
              text: '↩️ Tu acceso al bot ha sido revocado.',
            })
          } catch {
            // ignore
          }
        }
        await ctx.answer({ text: '↩️ Revocado' })
        await renderView(ctx, storage, defaults, 'approved')
      })
      .callbackQuery(acView, async (ctx) => {
        if (!ctx.isAdmin) return ctx.answer({ text: 'Solo admin.', show_alert: true })
        await ctx.answer({})
        await renderView(ctx, storage, defaults, ctx.queryData.v)
      })
      .callbackQuery(acClose, async (ctx) => {
        if (!ctx.isAdmin) return ctx.answer({ text: 'Solo admin.', show_alert: true })
        await ctx.answer({})
        try {
          await ctx.message?.delete()
        } catch {
          // ignore
        }
      })
      .command(
        'access',
        {
          // Admin-only; hidden from Telegram's `/` menu so it doesn't
          // tempt other users to type it. Admin still invokes via /access.
          // See https://gramio.dev/triggers/command.html#commandmeta-fields
          description: 'Admin: access control menu',
          hide: true,
        },
        async (ctx) => {
          if (!ctx.isAdmin) return
          const v = await mainView(storage, defaults)
          await ctx.send(v.text, { reply_markup: v.keyboard })
        },
      )
  )
}

// ─── views ─────────────────────────────────────────────────────────

type ViewableCtx = {
  editText: (
    text: string,
    params?: { reply_markup?: InlineKeyboard },
  ) => Promise<unknown>
}

const renderView = async (
  ctx: ViewableCtx,
  storage: Storage,
  defaults: ReadonlySet<number>,
  view: string,
): Promise<void> => {
  const v =
    view === 'approved'
      ? await listView(storage, 'approved', defaults)
      : view === 'pending'
        ? await listView(storage, 'pending', defaults)
        : view === 'denied'
          ? await listView(storage, 'denied', defaults)
          : await mainView(storage, defaults)
  try {
    await ctx.editText(v.text, { reply_markup: v.keyboard })
  } catch {
    // editText only works while message is recent enough; ignore
  }
}

const mainView = async (storage: Storage, defaults: ReadonlySet<number>) => {
  const idx = await loadIndex(storage)
  const text = [
    '🔐 Access Control',
    '',
    `✅ Aprobados: ${idx.approved.length}`,
    `⏳ Pendientes: ${idx.pending.length}`,
    `❌ Denegados: ${idx.denied.length}`,
    `👑 Defaults: ${defaults.size} (hardcoded)`,
  ].join('\n')

  const keyboard = new InlineKeyboard()
    .text(`✅ Aprobados (${idx.approved.length})`, acView.pack({ v: 'approved' }))
    .text(`⏳ Pendientes (${idx.pending.length})`, acView.pack({ v: 'pending' }))
    .row()
    .text(`❌ Denegados (${idx.denied.length})`, acView.pack({ v: 'denied' }))
    .text('🔄 Refresh', acView.pack({ v: 'main' }))
    .row()
    .text('✖️ Cerrar', acClose.pack({}))

  return { text, keyboard }
}

const listView = async (
  storage: Storage,
  filter: 'pending' | 'approved' | 'denied',
  defaults: ReadonlySet<number>,
) => {
  const idx = await loadIndex(storage)
  const ids = idx[filter]
  // Cap at 20 to keep callback_data + rendering sane.
  const shownIds = ids.slice(0, 20)
  const records = await Promise.all(
    shownIds.map(async (id) => ({ id, rec: await loadAccess(storage, id) })),
  )

  const headerEmoji = filter === 'approved' ? '✅' : filter === 'pending' ? '⏳' : '❌'
  const headerLabel =
    filter === 'approved' ? 'Aprobados' : filter === 'pending' ? 'Pendientes' : 'Denegados'

  if (ids.length === 0) {
    const text = `${headerEmoji} ${headerLabel} (0)\n\n(vacío)`
    const keyboard = new InlineKeyboard().text('⬅️ Volver', acView.pack({ v: 'main' }))
    return { text, keyboard }
  }

  const lines: string[] = [`${headerEmoji} ${headerLabel} (${ids.length})`, '']
  const keyboard = new InlineKeyboard()

  for (let i = 0; i < records.length; i++) {
    const { id, rec } = records[i]
    if (!rec) {
      // index referenced a missing record — show as placeholder
      lines.push(`${i + 1}. id ${id} (datos perdidos)`)
      continue
    }
    const ageRef = rec.approvedAt ?? rec.deniedAt ?? rec.requestedAt ?? Date.now()
    lines.push(
      `${i + 1}. ${formatUser(rec.user, id)} · hace ${fmtAge(Date.now() - ageRef)}` +
        (rec.messageCount ? ` · ${rec.messageCount} msgs` : ''),
    )
    if (filter === 'pending') {
      keyboard
        .text(`✅ ${i + 1}`, acApprove.pack({ uid: id, v: 'pending' }))
        .text(`❌ ${i + 1}`, acDeny.pack({ uid: id, v: 'pending' }))
        .row()
    } else if (filter === 'approved') {
      keyboard.text(`↩️ Revocar #${i + 1}`, acRevoke.pack({ uid: id })).row()
    } else if (filter === 'denied') {
      keyboard
        .text(`✅ Reaprobar #${i + 1}`, acApprove.pack({ uid: id, v: 'denied' }))
        .row()
    }
  }

  if (ids.length > shownIds.length) {
    lines.push('', `(+${ids.length - shownIds.length} más, no mostrados)`)
  }
  if (filter === 'approved' && defaults.size > 0) {
    lines.push('', `+ ${defaults.size} hardcoded defaults`)
  }

  keyboard.text('⬅️ Volver', acView.pack({ v: 'main' }))
  return { text: lines.join('\n'), keyboard }
}

// ─── test helper ───────────────────────────────────────────────────

/**
 * Inject a synthetic access request — for tests/demos when you can't
 * easily spin up a second Telegram account. Writes a `pending` record
 * to storage at the same key the plugin's session would, updates the
 * index, then DMs the admin with the real
 * `[✅ Aprobar][❌ Denegar]` keyboard. Tapping those buttons exercises
 * the real callback handlers end-to-end.
 *
 * Pass the SAME `storage` instance you passed to `accessControl({ storage })`.
 */
export const simulateAccessRequest = async (
  bot: AnyBot,
  storage: Storage,
  adminId: number,
  fakeUser: AccessUser,
  message?: string,
): Promise<void> => {
  const now = Date.now()
  const rec: AccessRecord = {
    status: 'pending',
    user: fakeUser,
    chatId: fakeUser.id,
    requestedAt: now,
    firstMessage: message?.slice(0, FIRST_MSG_LIMIT),
    messageCount: 0,
    rejectedAttempts: 0,
    lastNotifiedAt: now,
  }
  await saveAccess(storage, fakeUser.id, rec)
  await indexAdd(storage, 'pending', fakeUser.id)

  await bot.api.sendMessage({
    chat_id: adminId,
    text: requestNotificationText(fakeUser.id, rec, false),
    reply_markup: requestKeyboard(fakeUser.id),
  })
}
