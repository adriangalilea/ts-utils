/**
 * Per-user language preference for GramIO bots.
 *
 * Follows gramio's canonical "shared infrastructure" pattern (see
 * [Composer docs — Production Architecture](https://gramio.dev/extend/middleware.html#production-architecture)):
 * the bot's session is extended once at the top level by the user,
 * and each feature plugin declares it as a required dependency.
 * gramio's runtime deduplication ensures the session derive runs
 * exactly once per update; TypeScript flows the session's data shape
 * into every plugin that `.extend()`s it.
 *
 * ## What this plugin owns
 *
 *   - Validates the supported BCP-47 language tags via `Intl.getCanonicalLocales`
 *   - Resolves `ctx.lang` on every event (override → Telegram hint → default)
 *   - Persists the user's chosen language as `ctx.session.language`
 *   - Provides a `menuItem` for a `botMenu`'s language picker
 *
 * ## What this plugin does NOT own
 *
 *   - The session itself. The user creates it (`session(...)`) and
 *     extends it at bot level before this plugin.
 *   - GDPR machinery. A language preference is trivially covered by
 *     [Telegram's Standard Bot Privacy Policy](https://telegram.org/privacy-tpa)
 *     under "data necessary to function".
 *
 * ## Resolution priority for `ctx.lang`
 *
 *   1. `ctx.session.language` — stored override
 *   2. `ctx.from.languageCode` — Telegram-detected user lang, only in
 *      user-scoped resolution (in groups it would flicker per-speaker)
 *   3. `default` — the fallback passed at construction
 *
 * Peer deps: `gramio`, `@gramio/session`.
 *
 * @example
 * import { Bot } from 'gramio'
 * import { session } from '@gramio/session'
 * import { redisStorage } from '@gramio/storage-redis'
 * import { language } from '@adriangalilea/utils/bot/language'
 *
 * const userSession = session({
 *   storage: redisStorage(),
 *   key: 'session',
 *   initial: () => ({}),     // plugins add their fields by convention
 * })
 *
 * const lang = language({
 *   session: userSession,
 *   supported: ['en','es'] as const,
 *   default: 'en',
 * })
 *
 * const bot = new Bot(process.env.BOT_TOKEN!)
 *   .extend(userSession)        // ← FIRST: ctx.session lands on the real ctx
 *   .extend(lang.plugin)        // declares userSession as dep; runtime dedup
 *   .command('hello', (ctx) => ctx.send({ en: 'Hello', es: 'Hola' }[ctx.lang]))
 */
import { CallbackData, type DeriveDefinitions, Plugin } from 'gramio'
import { session } from '@gramio/session'

import { say, type Polyglot } from '../say/index.js'
import type { MenuItem } from './menu.js'

// ─── public types ──────────────────────────────────────────────────

/** Branded BCP-47 language tag — obtainable only via the validators below. */
export type LangCode = string & { readonly __langCode: unique symbol }

/**
 * Validate + canonicalize a BCP-47 tag using the standard
 * `Intl.getCanonicalLocales`. Throws `RangeError` on invalid input.
 * Canonicalizes casing: `'en-us'` → `'en-US'`.
 */
export const parseLangCode = (s: string): LangCode =>
  Intl.getCanonicalLocales(s)[0] as LangCode

/** Non-throwing type guard. Same parser path as `parseLangCode`. */
export const isLangCode = (s: unknown): s is LangCode => {
  if (typeof s !== 'string') return false
  try {
    Intl.getCanonicalLocales(s)
    return true
  } catch {
    return false
  }
}

export type LanguageScopeStrategy = 'user' | 'chat'

export type LanguageScope =
  | LanguageScopeStrategy
  | {
      private?: LanguageScopeStrategy
      group?: LanguageScopeStrategy
      supergroup?: LanguageScopeStrategy
      channel?: LanguageScopeStrategy
    }

/** Loose session shape — the plugin only touches the `language` field. */
type SessionLike = { language?: string }

/** @internal — kept unexported so it doesn't clash with peers' refs. */
type LangSessionPluginRef = ReturnType<typeof session<SessionLike, 'session'>>

export type LanguageOptions<Langs extends readonly string[]> = {
  /**
   * The session plugin to read/write `ctx.session.language` from.
   * Must be extended on the bot before this plugin (gramio's runtime
   * dedup ensures the session derive only runs once per update).
   */
  session: LangSessionPluginRef
  /** Tuple of BCP-47 tags. Each validated via `Intl.getCanonicalLocales`. */
  supported: Langs
  /** Must be a member of `supported`. */
  default: Langs[number]
  /** See module docstring. Per chat-type override possible. */
  scope?: LanguageScope
  /**
   * Override per-language menu label. Default uses an emoji flag prefix
   * derived from the language code.
   */
  labels?: Partial<Record<Langs[number], string>>
  /**
   * Header text for the language sub-menu. Accepts a plain string or a
   * polyglot literal. Default: `{ en: '🌐 Language', es: '🌐 Idioma' }`.
   */
  menuLabel?: string | Polyglot<string>
}

export type LanguageFeature<Lang extends string> = {
  plugin: ReturnType<typeof buildLanguagePlugin<Lang>>
  menuItem: MenuItem
}

// ─── derives ───────────────────────────────────────────────────────

/**
 * Callable namespace attached to `ctx.say`.
 *
 *   ctx.say({ en, es })           — resolves to a string at ctx.lang
 *   ctx.say.send({ en, es }, p?)  — ctx.send with the resolved string
 *   ctx.say.edit({ en, es }, p?)  — ctx.editText (callback ctx only)
 *   ctx.say.answer({ en, es }, p?)— ctx.answer (callback ctx only)
 *
 * `.send` is valid wherever `ctx.send` exists; `.edit` / `.answer`
 * require a callback_query ctx. Calling the wrong one for the event
 * type raises a clear TypeError at runtime — the type-level declares
 * them uniformly to keep the surface flat.
 */
export type Sayer<L extends string> = {
  <V extends Polyglot<L>>(value: V): string
  send<V extends Polyglot<L>>(value: V, params?: object): Promise<unknown>
  edit<V extends Polyglot<L>>(value: V, params?: object): Promise<unknown>
  answer<V extends Polyglot<L>>(value: V, params?: object): Promise<unknown>
}

/**
 * What this plugin decorates onto `ctx`. Two surfaces:
 *
 *   - `ctx.lang` — the user's current language, **resolved once at
 *     event start and frozen** for the rest of the handler. Cheap to
 *     read repeatedly, but goes stale if you mutate
 *     `ctx.session.language` mid-handler (typical inside a
 *     `MenuItem.action` that flips the user's selection). For
 *     post-mutation freshness use `ctx.session.language` directly,
 *     or call `ctx.say(...)` which is live.
 *
 *   - `ctx.say(value)` — callable + namespace, **resolves the lang
 *     on every call** by re-reading `ctx.session.language`. Safe to
 *     use both before and after a mid-handler mutation. Plus
 *     `.send / .edit / .answer` that forward to gramio's
 *     `ctx.send / .editText / .answer` with the resolved string.
 */
type LanguageDerives<Lang extends string> = {
  lang: Lang
  say: Sayer<Lang>
}

/**
 * Builds `ctx.say` with LIVE lang resolution — the lang is re-read
 * from `ctx.session.language` on every `say(value)` / `.send` / `.edit`
 * / `.answer` call. That way handlers that mutate the session
 * (e.g. a `MenuItem.action` flipping the user's language) and then
 * emit further messages within the same event get the freshly-stored
 * lang, NOT the one that was captured when `derive` ran at event start.
 *
 * Contrast with `ctx.lang`, which IS a snapshot at event start and
 * stays static through the handler. Read `ctx.session.language`
 * directly (or call `ctx.say(...)`) when you need post-mutation
 * freshness.
 */
const buildSayer = <L extends string>(
  ctx: unknown,
  canonicalSet: ReadonlySet<string>,
  defaultLang: L,
): Sayer<L> => {
  type CtxLike = {
    session?: { language?: string }
    send?: (text: string, params?: object) => Promise<unknown>
    editText?: (text: string, params?: object) => Promise<unknown>
    answer?: (params: object) => Promise<unknown>
  }
  const c = ctx as CtxLike

  const currentLang = (): L => {
    const stored = c.session?.language
    return stored && canonicalSet.has(stored) ? (stored as L) : defaultLang
  }

  const resolve = <V extends Polyglot<L>>(value: V): string => {
    const lang = currentLang()
    return value[lang] ?? value[defaultLang] ?? say(value as Polyglot<string>, lang)
  }

  const fn = (<V extends Polyglot<L>>(value: V): string =>
    resolve(value)) as Sayer<L>

  fn.send = (value, params) => {
    if (typeof c.send !== 'function') {
      throw new TypeError('ctx.say.send: ctx.send is not available on this event')
    }
    // ctx.send auto-forwards message_thread_id (gramio SendMixin).
    return c.send(resolve(value), params)
  }
  fn.edit = (value, params) => {
    if (typeof c.editText !== 'function') {
      throw new TypeError(
        'ctx.say.edit: ctx.editText is only available on callback_query events',
      )
    }
    return c.editText(resolve(value), params)
  }
  fn.answer = (value, params) => {
    if (typeof c.answer !== 'function') {
      throw new TypeError(
        'ctx.say.answer: ctx.answer is only available on callback_query events',
      )
    }
    return c.answer({ text: resolve(value), ...(params ?? {}) })
  }

  return fn
}

// ─── scope helpers ─────────────────────────────────────────────────

const DEFAULT_SCOPE = {
  private: 'user' as LanguageScopeStrategy,
  group: 'chat' as LanguageScopeStrategy,
  supergroup: 'chat' as LanguageScopeStrategy,
  channel: 'chat' as LanguageScopeStrategy,
} as const

const resolveScope = (
  scope: LanguageScope | undefined,
  chatType: string,
): LanguageScopeStrategy => {
  if (typeof scope === 'string') return scope
  const t = chatType as keyof typeof DEFAULT_SCOPE
  return scope?.[t] ?? DEFAULT_SCOPE[t] ?? 'user'
}

// ─── flag emoji (best-effort) ──────────────────────────────────────

const REGIONLESS_FLAGS: Record<string, string> = {
  en: '🇬🇧', es: '🇪🇸', fr: '🇫🇷', de: '🇩🇪', it: '🇮🇹',
  pt: '🇵🇹', ru: '🇷🇺', zh: '🇨🇳', ja: '🇯🇵', ko: '🇰🇷',
  ar: '🇸🇦', tr: '🇹🇷', pl: '🇵🇱', nl: '🇳🇱', uk: '🇺🇦',
}

const regionToFlag = (region: string): string =>
  String.fromCodePoint(
    ...region.toUpperCase().split('').map((c) => 0x1f1a5 + c.charCodeAt(0)),
  )

const flagFor = (lang: string): string => {
  const parts = lang.split('-')
  if (parts.length > 1) {
    const region = parts.find((p) => /^[A-Z]{2}$/.test(p))
    if (region) return regionToFlag(region)
  }
  return REGIONLESS_FLAGS[parts[0].toLowerCase()] ?? '🌐'
}

const autonym = (lang: string): string => {
  try {
    const dn = new Intl.DisplayNames([lang], { type: 'language' })
    return dn.of(lang) ?? lang
  } catch {
    return lang
  }
}

const defaultLabel = (lang: string) => `${flagFor(lang)} ${autonym(lang)}`

// ─── callback schema ───────────────────────────────────────────────

const setLangCb = new CallbackData('lang').string('code')

// ─── feature factory ───────────────────────────────────────────────

export const language = <const Langs extends readonly string[]>(
  opts: LanguageOptions<Langs>,
): LanguageFeature<Langs[number]> => {
  type Lang = Langs[number]

  const scopeOpt = opts.scope
  const labels = (opts.labels ?? {}) as Record<string, string>
  const menuLabel: string | Polyglot<string> =
    opts.menuLabel ?? { en: '🌐 Language', es: '🌐 Idioma' }

  // Canonicalize all supported tags at construction.
  const canonical = opts.supported.map((l): Lang => {
    try {
      return Intl.getCanonicalLocales(l)[0] as Lang
    } catch {
      throw new Error(
        `language: "${l}" is not a valid BCP-47 tag (per Intl.getCanonicalLocales)`,
      )
    }
  })
  const canonicalSet = new Set<string>(canonical)

  let defaultLanguage: Lang
  try {
    defaultLanguage = Intl.getCanonicalLocales(opts.default)[0] as Lang
  } catch {
    throw new Error(`language: default "${opts.default}" is not a valid BCP-47 tag`)
  }
  if (!canonicalSet.has(defaultLanguage)) {
    throw new Error(
      `language: default "${defaultLanguage}" is not in supported[]`,
    )
  }

  const matchSupported = (s: string | undefined): Lang | undefined => {
    if (!s) return undefined
    try {
      const c = Intl.getCanonicalLocales(s)[0]
      if (canonicalSet.has(c)) return c as Lang
    } catch {
      // fall through
    }
    return undefined
  }

  const plugin = buildLanguagePlugin<Lang>({
    sessionPlugin: opts.session,
    canonicalSet,
    defaultLanguage,
    matchSupported,
    scopeOpt,
  })

  const menuItem: MenuItem = {
    id: 'lang',
    label: menuLabel,
    submenu: canonical.map((l) => ({
      id: l,
      label: labels[l] ?? defaultLabel(l),
      // The currently-selected language renders blue (Telegram's
      // `primary` style); the rest stay at app default. Replaces the
      // old `●` / `○` markers — same signal, native Telegram styling.
      //
      // Reads `ctx.session.language` (the live store), NOT `ctx.lang`
      // (the event-start snapshot from the language derive — would
      // be stale within the same callback after the sibling action
      // mutated the session).
      style: (ctx) =>
        (ctx as unknown as { session?: { language?: string } }).session
          ?.language === l
          ? 'primary'
          : undefined,
      // Re-render the submenu in place after the tap so the colour
      // moves to the newly-selected language without the user having
      // to re-open the menu.
      refresh: true,
      action: (ctx) => {
        // ctx.session is the shared session record. Mutating any
        // field on it goes through @gramio/session's Proxy and
        // auto-persists. We own the `language` field by convention.
        //
        // The menu plugin owns the single `answerCallbackQuery` for
        // this tap — we return the toast string and it gets sent.
        // Calling ctx.answer directly here would be a second answer
        // → Telegram rejects → action throws → `refresh: true` skipped
        // → button colour wouldn't update.
        const c = ctx as unknown as { session: { language?: Lang } }
        c.session.language = l
        return `✓ ${l}`
      },
    })),
  }

  return { plugin, menuItem }
}

// ─── plugin builder ────────────────────────────────────────────────

const buildLanguagePlugin = <Lang extends string>(args: {
  sessionPlugin: LangSessionPluginRef
  canonicalSet: ReadonlySet<string>
  defaultLanguage: Lang
  matchSupported: (s: string | undefined) => Lang | undefined
  scopeOpt: LanguageScope | undefined
}) => {
  const { sessionPlugin, canonicalSet, defaultLanguage, matchSupported, scopeOpt } = args

  return (
    new Plugin<{}, DeriveDefinitions & { global: LanguageDerives<Lang> }>(
      '@adriangalilea/utils/bot/language',
    )
      // Declare the session as a dependency. gramio's runtime dedupes
      // this against the bot's top-level session extension so the
      // session derive runs exactly once per update — but the types
      // (ctx.session: SessionLike) flow into our handlers below.
      .extend(sessionPlugin)
      .derive(['message', 'callback_query'], (ctx) => {
        // Snapshot resolved at event start. Stays static through the
        // handler — see the JSDoc on `LanguageDerives.lang` below for
        // the staleness gotcha and why `ctx.say` is the live escape.
        const resolveLang = (): Lang => {
          // 1) stored override
          const stored = ctx.session.language
          if (stored && canonicalSet.has(stored)) return stored as Lang

          // 2) Telegram hint — only when in user-scoped resolution
          const chatType =
            ctx.is('message')
              ? ctx.chat.type
              : ctx.message?.chat.type ?? 'private'
          const strategy = resolveScope(scopeOpt, chatType)
          if (strategy === 'user') {
            const hint = matchSupported(ctx.from.languageCode)
            if (hint) return hint
          }

          // 3) configured default
          return defaultLanguage
        }

        return {
          lang: resolveLang(),
          // LIVE: re-resolves ctx.session.language on every call so
          // post-mutation reads inside a handler get the new value.
          say: buildSayer<Lang>(ctx, canonicalSet, defaultLanguage),
        }
      })
  )
}
