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
 *           admin gets DM with [✅ Approve] [❌ Deny]
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
 * **Cross-user mutations.** When the admin taps `[✅ Approve]` on
 * Pepe's notification, `ctx` is the admin's, so `ctx.session` is the
 * admin's record — useless for mutating Pepe. We reach for Pepe's
 * record directly via `storage.get(String(pepeId))`, preserve other
 * plugins' fields in it (read-modify-write), and put it back.
 *
 * **i18n.** Every user-facing string is an inline `{ en, es }`
 * polyglot literal resolved via `say(value, lang)` at the call site
 * — no message bundle, no override registry. The recipient's stored
 * `language` field (set by `bot/language`) picks the variant; falls
 * back to `'en'`. Want a different default? Set `language` on the
 * relevant session record before this plugin fires.
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

import { say } from '../say/index.js'

const INDEX_KEY = 'ac:index'
const FIRST_MSG_LIMIT = 200
const DEFAULT_THROTTLE_MS = 6 * 60 * 60 * 1000
const FALLBACK_LANG = 'en'

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

/**
 * Loose session shape — this plugin writes `access`; it READS `language`
 * to localize messages it sends to the subject. Both are optional.
 */
type SessionLike = { access?: AccessRecord; language?: string }

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
  /** Pass `false` to silence the first-attempt reply to denied users. */
  silentDeny?: boolean
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
  lang: string,
): string => {
  const parts = [
    say(
      repeat
        ? { en: '🔁 Access re-requested', es: '🔁 Acceso re-solicitado' }
        : { en: '🔔 Access requested', es: '🔔 Acceso solicitado' },
      lang,
    ),
    '',
    `👤 ${formatUser(r.user, uid)}`,
    `🆔 ${uid}`,
    `⏰ ${say({ en: 'ago', es: 'hace' }, lang)} ${fmtAge(Date.now() - (r.requestedAt ?? Date.now()))}`,
  ]
  if (repeat) {
    parts.push(
      `🔁 ${say({ en: 'attempts', es: 'intentos' }, lang)}: ${(r.rejectedAttempts ?? 0) + 1}`,
    )
  }
  if (r.firstMessage) parts.push('', `💬 "${r.firstMessage}"`)
  return parts.join('\n')
}

const requestKeyboard = (uid: number, lang: string) =>
  new InlineKeyboard()
    .text(say({ en: '✅ Approve', es: '✅ Aprobar' }, lang), acApprove.pack({ uid }))
    .text(say({ en: '❌ Deny', es: '❌ Denegar' }, lang), acDeny.pack({ uid }))

// ─── index helpers ─────────────────────────────────────────────────

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

type FullSessionRecord = {
  access?: AccessRecord
  language?: string
} & Record<string, unknown>

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

/** Read recipient's stored language (set by bot/language); fallback to en. */
const langOfUser = async (storage: Storage, userId: number): Promise<string> => {
  const full = await loadFullRecord(storage, userId)
  return full.language ?? FALLBACK_LANG
}

/** Read current ctx's lang. */
const ctxLang = (ctx: { session: SessionLike }): string =>
  ctx.session.language ?? FALLBACK_LANG

// ─── plugin ────────────────────────────────────────────────────────

export const accessControl = (opts: AccessControlOptions) => {
  const { session: sessionPlugin, storage } = opts
  const defaults = new Set(opts.defaults ?? [])
  const silentDeny = opts.silentDeny === true
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
          await ctx.answer({
            text: say({ en: 'No access.', es: 'Sin acceso.' }, ctxLang(ctx)),
            show_alert: false,
          })
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
            const adminLang = await langOfUser(storage, ctx.adminId)
            await ctx.bot.api.sendMessage({
              chat_id: ctx.adminId,
              text: requestNotificationText(userId, rec, !isFirstRequest, adminLang),
              reply_markup: requestKeyboard(userId, adminLang),
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

        if (!silentDeny && isFirstRequest) {
          try {
            await ctx.send(
              say(
                {
                  en: 'This bot is private. Your request has been sent to the admin.',
                  es: 'Este bot es privado. Tu solicitud se ha enviado al admin.',
                },
                ctxLang(ctx),
              ),
            )
          } catch {
            // user blocked the bot — irrelevant
          }
        }
        // do NOT call next — drop
      })
      // ─── admin actions ────────────────────────────────────────
      .callbackQuery(acApprove, async (ctx) => {
        const aLang = ctxLang(ctx)
        if (!ctx.isAdmin)
          return ctx.answer({
            text: say({ en: 'Admin only.', es: 'Solo admin.' }, aLang),
            show_alert: true,
          })
        const uid = ctx.queryData.uid
        const rec = await loadAccess(storage, uid)
        if (!rec)
          return ctx.answer({
            text: say({ en: 'Not found.', es: 'No encontrado.' }, aLang),
          })

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
            const sLang = await langOfUser(storage, uid)
            await ctx.bot.api.sendMessage({
              chat_id: rec.chatId,
              text: say(
                wasDenied
                  ? {
                      en: '✅ The admin reconsidered: you have access.',
                      es: '✅ El admin reconsideró: ya tienes acceso.',
                    }
                  : {
                      en: '✅ Access granted. You can use the bot now.',
                      es: '✅ Acceso concedido. Ya puedes usar el bot.',
                    },
                sLang,
              ),
            })
          } catch {
            // user blocked / chat gone
          }
        }
        await ctx.answer({
          text: say({ en: '✅ Approved', es: '✅ Aprobado' }, aLang),
        })

        if (ctx.queryData.v) {
          await renderView(ctx, storage, defaults, ctx.queryData.v, aLang)
        } else {
          try {
            await ctx.editText(
              `${say({ en: '✅ Approved', es: '✅ Aprobado' }, aLang)} · ${formatUser(rec.user, uid)}`,
            )
          } catch {
            // not always editable
          }
        }
        opts.onApprove?.({ userId: uid, approvedBy: ctx.adminId })
      })
      .callbackQuery(acDeny, async (ctx) => {
        const aLang = ctxLang(ctx)
        if (!ctx.isAdmin)
          return ctx.answer({
            text: say({ en: 'Admin only.', es: 'Solo admin.' }, aLang),
            show_alert: true,
          })
        const uid = ctx.queryData.uid
        const rec = await loadAccess(storage, uid)
        if (!rec)
          return ctx.answer({
            text: say({ en: 'Not found.', es: 'No encontrado.' }, aLang),
          })

        const wasPending = rec.status === 'pending'
        rec.status = 'denied'
        rec.deniedAt = Date.now()
        rec.deniedBy = ctx.adminId
        await saveAccess(storage, uid, rec)
        await indexMove(storage, uid, wasPending ? 'pending' : 'any', 'denied')

        if (rec.chatId !== undefined) {
          try {
            const sLang = await langOfUser(storage, uid)
            await ctx.bot.api.sendMessage({
              chat_id: rec.chatId,
              text: say(
                { en: '❌ Access denied.', es: '❌ Acceso denegado.' },
                sLang,
              ),
            })
          } catch {
            // ignore
          }
        }
        await ctx.answer({
          text: say({ en: '❌ Denied', es: '❌ Denegado' }, aLang),
        })

        if (ctx.queryData.v) {
          await renderView(ctx, storage, defaults, ctx.queryData.v, aLang)
        } else {
          try {
            await ctx.editText(
              `${say({ en: '❌ Denied', es: '❌ Denegado' }, aLang)} · ${formatUser(rec.user, uid)}`,
            )
          } catch {
            // ignore
          }
        }
        opts.onDeny?.({ userId: uid, deniedBy: ctx.adminId })
      })
      .callbackQuery(acRevoke, async (ctx) => {
        const aLang = ctxLang(ctx)
        if (!ctx.isAdmin)
          return ctx.answer({
            text: say({ en: 'Admin only.', es: 'Solo admin.' }, aLang),
            show_alert: true,
          })
        const uid = ctx.queryData.uid
        const rec = await loadAccess(storage, uid)
        if (!rec)
          return ctx.answer({
            text: say({ en: 'Not found.', es: 'No encontrado.' }, aLang),
          })

        rec.status = 'denied'
        rec.deniedAt = Date.now()
        rec.deniedBy = ctx.adminId
        await saveAccess(storage, uid, rec)
        await indexMove(storage, uid, 'approved', 'denied')

        if (rec.chatId !== undefined) {
          try {
            const sLang = await langOfUser(storage, uid)
            await ctx.bot.api.sendMessage({
              chat_id: rec.chatId,
              text: say(
                {
                  en: '↩️ Your bot access has been revoked.',
                  es: '↩️ Tu acceso al bot ha sido revocado.',
                },
                sLang,
              ),
            })
          } catch {
            // ignore
          }
        }
        await ctx.answer({
          text: say({ en: '↩️ Revoked', es: '↩️ Revocado' }, aLang),
        })
        await renderView(ctx, storage, defaults, 'approved', aLang)
      })
      .callbackQuery(acView, async (ctx) => {
        const aLang = ctxLang(ctx)
        if (!ctx.isAdmin)
          return ctx.answer({
            text: say({ en: 'Admin only.', es: 'Solo admin.' }, aLang),
            show_alert: true,
          })
        await ctx.answer({})
        await renderView(ctx, storage, defaults, ctx.queryData.v, aLang)
      })
      .callbackQuery(acClose, async (ctx) => {
        const aLang = ctxLang(ctx)
        if (!ctx.isAdmin)
          return ctx.answer({
            text: say({ en: 'Admin only.', es: 'Solo admin.' }, aLang),
            show_alert: true,
          })
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
          //
          // Note: gramio's setMyCommands publishes ONE description per
          // bot, not per language. English form used as the canonical.
          description: 'Admin: access control menu',
          hide: true,
        },
        async (ctx) => {
          if (!ctx.isAdmin) return
          const aLang = ctxLang(ctx)
          const v = mainView(await loadIndex(storage), defaults, aLang)
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
  lang: string,
): Promise<void> => {
  const idx = await loadIndex(storage)
  const v =
    view === 'approved'
      ? await listView(storage, idx, 'approved', defaults, lang)
      : view === 'pending'
        ? await listView(storage, idx, 'pending', defaults, lang)
        : view === 'denied'
          ? await listView(storage, idx, 'denied', defaults, lang)
          : mainView(idx, defaults, lang)
  try {
    await ctx.editText(v.text, { reply_markup: v.keyboard })
  } catch {
    // editText only works while message is recent enough; ignore
  }
}

const mainView = (
  idx: AccessIndex,
  defaults: ReadonlySet<number>,
  lang: string,
) => {
  const approved = say({ en: 'Approved', es: 'Aprobados' }, lang)
  const pending = say({ en: 'Pending', es: 'Pendientes' }, lang)
  const denied = say({ en: 'Denied', es: 'Denegados' }, lang)

  const text = [
    say({ en: '🔐 Access Control', es: '🔐 Access Control' }, lang),
    '',
    `✅ ${approved}: ${idx.approved.length}`,
    `⏳ ${pending}: ${idx.pending.length}`,
    `❌ ${denied}: ${idx.denied.length}`,
    `👑 ${say({ en: 'Defaults', es: 'Defaults' }, lang)}: ${defaults.size} (hardcoded)`,
  ].join('\n')

  const keyboard = new InlineKeyboard()
    .text(`✅ ${approved} (${idx.approved.length})`, acView.pack({ v: 'approved' }))
    .text(`⏳ ${pending} (${idx.pending.length})`, acView.pack({ v: 'pending' }))
    .row()
    .text(`❌ ${denied} (${idx.denied.length})`, acView.pack({ v: 'denied' }))
    .text(say({ en: '🔄 Refresh', es: '🔄 Refresh' }, lang), acView.pack({ v: 'main' }))
    .row()
    .text(say({ en: '✖️ Close', es: '✖️ Cerrar' }, lang), acClose.pack({}))

  return { text, keyboard }
}

const listView = async (
  storage: Storage,
  idx: AccessIndex,
  filter: 'pending' | 'approved' | 'denied',
  defaults: ReadonlySet<number>,
  lang: string,
) => {
  const ids = idx[filter]
  // Cap at 20 to keep callback_data + rendering sane.
  const shownIds = ids.slice(0, 20)
  const records = await Promise.all(
    shownIds.map(async (id) => ({ id, rec: await loadAccess(storage, id) })),
  )

  const headerEmoji = filter === 'approved' ? '✅' : filter === 'pending' ? '⏳' : '❌'
  const headerLabel =
    filter === 'approved'
      ? say({ en: 'Approved', es: 'Aprobados' }, lang)
      : filter === 'pending'
        ? say({ en: 'Pending', es: 'Pendientes' }, lang)
        : say({ en: 'Denied', es: 'Denegados' }, lang)

  const back = say({ en: '⬅️ Back', es: '⬅️ Volver' }, lang)

  if (ids.length === 0) {
    const text =
      `${headerEmoji} ${headerLabel} (0)\n\n` +
      say({ en: '(empty)', es: '(vacío)' }, lang)
    const keyboard = new InlineKeyboard().text(back, acView.pack({ v: 'main' }))
    return { text, keyboard }
  }

  const lines: string[] = [`${headerEmoji} ${headerLabel} (${ids.length})`, '']
  const keyboard = new InlineKeyboard()

  for (let i = 0; i < records.length; i++) {
    const { id, rec } = records[i]
    if (!rec) {
      // index referenced a missing record — show as placeholder
      lines.push(
        `${i + 1}. id ${id} ${say({ en: '(data lost)', es: '(datos perdidos)' }, lang)}`,
      )
      continue
    }
    const ageRef = rec.approvedAt ?? rec.deniedAt ?? rec.requestedAt ?? Date.now()
    lines.push(
      `${i + 1}. ${formatUser(rec.user, id)} · ${say({ en: 'ago', es: 'hace' }, lang)} ${fmtAge(Date.now() - ageRef)}` +
        (rec.messageCount ? ` · ${rec.messageCount} msgs` : ''),
    )
    if (filter === 'pending') {
      keyboard
        .text(`✅ ${i + 1}`, acApprove.pack({ uid: id, v: 'pending' }))
        .text(`❌ ${i + 1}`, acDeny.pack({ uid: id, v: 'pending' }))
        .row()
    } else if (filter === 'approved') {
      keyboard
        .text(
          `${say({ en: '↩️ Revoke', es: '↩️ Revocar' }, lang)} #${i + 1}`,
          acRevoke.pack({ uid: id }),
        )
        .row()
    } else if (filter === 'denied') {
      keyboard
        .text(
          `${say({ en: '✅ Reapprove', es: '✅ Reaprobar' }, lang)} #${i + 1}`,
          acApprove.pack({ uid: id, v: 'denied' }),
        )
        .row()
    }
  }

  if (ids.length > shownIds.length) {
    lines.push(
      '',
      `(+${ids.length - shownIds.length} ${say({ en: 'more, not shown', es: 'más, no mostrados' }, lang)})`,
    )
  }
  if (filter === 'approved' && defaults.size > 0) {
    lines.push('', `+ ${defaults.size} hardcoded defaults`)
  }

  keyboard.text(back, acView.pack({ v: 'main' }))
  return { text: lines.join('\n'), keyboard }
}

// ─── test helper ───────────────────────────────────────────────────

/**
 * Inject a synthetic access request — for tests/demos when you can't
 * easily spin up a second Telegram account. Writes a `pending` record
 * to storage at the same key the plugin's session would, updates the
 * index, then DMs the admin with the real
 * `[✅ Approve][❌ Deny]` keyboard. Tapping those buttons exercises
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

  const adminLang = await langOfUser(storage, adminId)

  await bot.api.sendMessage({
    chat_id: adminId,
    text: requestNotificationText(fakeUser.id, rec, false, adminLang),
    reply_markup: requestKeyboard(fakeUser.id, adminLang),
  })
}
