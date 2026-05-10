# `@adriangalilea/utils/bot/*` — GramIO plugins

Plugins for personal Telegram bots built on [GramIO](https://gramio.dev). Each
ships as a subpath of `@adriangalilea/utils`. Peer deps (`gramio`,
`@gramio/storage`, `@gramio/session`, `@gramio/format`, `marked`) are **all
optional** — install only what the subpaths you import need.

## What's here

| Subpath | What it does |
|---|---|
| `bot/kit` | `gracefulStart(bot, opts?)` — SIGINT/SIGTERM → `bot.stop()` → exit; force-kills if shutdown hangs; calls `bot.syncCommands()` automatically before `bot.start()`. `adminContext({ adminId? })` — reads `TELEGRAM_ADMIN_ID` from KEV with optional hardcoded fallback, decorates `ctx.adminId` + `ctx.isAdmin`. |
| `bot/access-control` | `accessControl({ session, storage, defaults? })` — gates non-admin/non-default users; admin gets DM with `[✅ Aprobar][❌ Denegar]` on first attempt; persistent `/access` admin menu for revoke/reapprove/list. Exposes `simulateAccessRequest()` for tests. |
| `bot/coalesce` | `coalesceLongMessages({ minLeadingLength?, windowMs?, acrossUsers?, log? })` — joins client-split inbound messages back into one event. Also exports `isCoalescent(prev, curr, opts)` as a pure utility. |
| `bot/language` | `language({ session, supported, default, scope?, labels? })` — per-user BCP-47 preference; resolves `ctx.lang` (typed); decorates `ctx.say` (callable polyglot resolver + `.send` / `.edit` / `.answer` methods); supplies a `menuItem` for `botMenu`. |
| `bot/llm-stream` | `llmStream()` — `ctx.startStream()` returns a `MarkdownStreamer`; debounced `editMessageText`, splits at 4000 chars on paragraph/line/word boundary, parses Markdown locally so malformed mid-stream markup degrades to plain text. |
| `bot/menu` | `botMenu({ command, description, items, privacy?, personalData?, adminContact })` — `/settings` command + InlineKeyboard router. With `personalData: { storage }`, auto-adds 🗑 Forget + 📥 Export buttons. |
| `bot/message-history` | `messageHistory({ session, maxMessages, retentionDays })` — opt-in per-user ring buffer with retention; exposes `ctx.history` (read-only pruned snapshot). |

Implementation files are flat under `src/bot/`. `index.ts` is the barrel for
`@adriangalilea/utils/bot`.

## Standard wiring

```ts
import { Bot } from 'gramio'
import { session } from '@gramio/session'
import { redisStorage } from '@gramio/storage-redis'

import { adminContext, gracefulStart } from '@adriangalilea/utils/bot/kit'
import { accessControl } from '@adriangalilea/utils/bot/access-control'
import { coalesceLongMessages } from '@adriangalilea/utils/bot/coalesce'
import { llmStream } from '@adriangalilea/utils/bot/llm-stream'
import { language } from '@adriangalilea/utils/bot/language'
import { messageHistory } from '@adriangalilea/utils/bot/message-history'
import { botMenu } from '@adriangalilea/utils/bot/menu'

const storage = redisStorage()

// ONE session at bot level. All per-user state across plugins lives
// in this record; plugins own distinct fields by convention.
const userSession = session({
  storage,
  key: 'session',
  initial: () => ({}),
})

const lang = language({
  session: userSession,
  supported: ['en', 'es'] as const,
  default: 'en',
})

const history = messageHistory({
  session: userSession,
  maxMessages: 100,
  retentionDays: 7,
})

const menu = botMenu({
  command: 'settings',
  description: 'Open settings',
  adminContact: '@yourhandle',
  privacy: 'https://yourbot.com/privacy',     // override standard if you retain content
  personalData: { storage },                  // enables 🗑 Forget + 📥 Export
  items: [lang.menuItem],
})

const bot = new Bot(process.env.BOT_TOKEN!)
  .extend(adminContext({ adminId: 190202471 }))
  .extend(userSession)                                                      // SESSION FIRST
  .extend(accessControl({ session: userSession, storage, defaults: [] }))
  .extend(coalesceLongMessages())
  .extend(llmStream())
  .extend(lang.plugin)
  .extend(history.plugin)
  .extend(menu.plugin)

await gracefulStart(bot)
```

**Order matters**:

1. `adminContext` — declares ctx.adminId via `decorate`. accessControl
   declares it as a [runtime dependency](https://gramio.dev/extend/middleware.html#production-architecture).
2. `userSession` — must come before any plugin that reads `ctx.session`,
   because session's derive must run first to populate it. See
   [gramio docs § "Why .as('scoped')"](https://gramio.dev/extend/middleware.html#production-architecture).
3. The rest can be in any order; gramio's runtime dedup handles
   plugins that internally `.extend(userSession)` for type flow.

---

## Polyglot strings — the hard rule

Every user-facing string this library emits is an **inline polyglot
literal** resolved through `say()` from `@adriangalilea/utils/say`. No
message bundle, no central registry, no extraction tool.

```ts
// inside this library:
await ctx.send(say({ en: 'No access.', es: 'Sin acceso.' }, ctxLang(ctx)))

// in your handlers:
ctx.say.send({ en: 'Welcome', es: 'Bienvenido' })
ctx.say({ en: 'Continue', es: 'Continuar' })  // returns the string
```

Recipient's language comes from `ctx.session.language` (set by
`bot/language`). When the recipient is a different user from the ctx
(admin notifying a subject), the plugin reads the subject's stored
`language` via `loadFullRecord(storage, userId)` and falls back to
`'en'`.

The whole API is in `@adriangalilea/utils/say` (~30 LOC):
`say(value, lang)` standalone and `type Polyglot<L>`. The bot-bound
form `ctx.say` is added by `bot/language` and exposes the namespace
with `.send / .edit / .answer` methods.

## Architecture: shared session, one record per user

All per-user state across the plugins in this package lives in ONE shared
`@gramio/session` record. Each plugin owns a distinct field by convention:

```
storage[String(userId)] = {
  access:   { status, approvedAt, … },   // ← bot/access-control
  language: 'es',                         // ← bot/language
  history:  { items: [{...}, …] },        // ← bot/message-history
  // (any field you add via your own handlers, or a future plugin)
}
```

The user creates the session at bot level. Each plugin **declares the session
as a required option** and `.extend()`s it internally so its handler types see
`ctx.session`. gramio's runtime deduplication ensures the session derive only
runs once per update.

### Why this and not separate sessions per plugin

This was the longest design conversation of this package, with many false
starts. The summary is below; the full evolution is in [§ Design journey](#design-journey).

`@gramio/session` is a Plugin named `"@gramio/session"`. gramio's plugin
extension uses [registration-time deduplication](https://gramio.dev/extend/middleware.html#production-architecture):
the first `.extend(p)` with a given name wins, subsequent ones with the same
name are no-ops at runtime (types still flow). Two plugins each calling
`session(...)` internally produce two Plugins with the same name → only the
first one's session derive ever runs, the second's `ctx.session` is never set.

This is the [dedup gotcha](https://gramio.dev/extend/middleware.html#the-dedup-gotcha)
the gramio docs warn about. The library's intended pattern is the inverse of
what we initially tried: ONE shared session at the top, plugins consume it.

**The canonical pattern from gramio docs (`withUser`):**

```ts
bot.extend(withUser)        // ← FIRST: derive writes ctx.user to the real ctx
   .extend(adminRouter)     // declares withUser as dep; runtime dedup; types flow
   .extend(chatRouter)      // same
```

That's exactly our `userSession` pattern, applied to the session plugin.

### Cross-user mutations

`ctx.session` is the CURRENT user's session, scoped by `getSessionKey(ctx)`.
When the admin approves Pepe via inline button, `ctx` is the admin's — useless
for mutating Pepe's record. `bot/access-control` solves this by reading
`storage` directly at the same key format `@gramio/session` uses
(`String(userId)`), preserving other plugins' fields via read-modify-write.

The key format is `String(senderId)` by default ([source](https://github.com/gramiojs/storages/blob/master/packages/session/src/index.ts)).
If you customize the session's `getSessionKey`, also pass a matching
`sessionKey` to `botMenu`'s `personalData` option so /forget and /export hit
the right keys.

---

## GDPR — what we expose, what we punt to the bot author

`bot/menu`'s `personalData: { storage }` option auto-builds 🗑 Forget and
📥 Export buttons that operate on the full shared session record:

- **🗑 Forget** → `storage.delete(sessionKey(userId))`. Wipes everything in one
  shot — preferences, history, access state.
- **📥 Export** → `storage.get(sessionKey(userId))` → JSON file attachment.

There's no per-plugin cascade because the data layout is flat: one key, many
fields, one delete clears them all.

**What needs the buttons vs not**:

- Bots that only have `bot/language` (or no persistent per-user state at all) —
  language preferences are trivially covered by [Telegram's Standard Bot
  Privacy Policy](https://telegram.org/privacy-tpa) under "data necessary to
  function." Skip `personalData`, use the default Telegram-standard privacy URL.
- Bots that extend `bot/message-history` — you're retaining **message content**,
  which the standard policy does NOT cover by default. Set a custom `privacy`
  URL describing what you keep and pass `personalData: { storage }` so /forget
  and /export are exposed. **This plugin does not enforce that linkage** (it
  would couple `bot/message-history` to `bot/menu`), it's documented as the
  bot author's legal responsibility.

`adminContact` is **required** on `botMenu` — when /export's `sendDocument`
fails (transient network, file too big, etc.), the user gets a clear error
pointing them at a human. A bot that asks users to trust it with data must
always have a human escape hatch.

---

## Per-plugin notes

### `kit.ts` — `adminContext` + `gracefulStart`

- `adminContext` resolves admin id via `kev.int('TELEGRAM_ADMIN_ID',
  opts.adminId ?? 0)`. KEV reads process.env → .env (auto-discovered project
  and monorepo root) → fallback. Cached after first read. `kev.int` throws on
  non-int strings so a malformed env screams immediately rather than
  producing NaN downstream.
- `gracefulStart` accepts `AnyBot` because after `.extend()` chains the
  concrete Bot type is a heavily-parameterised union; `Bot` (bare) won't
  accept it.
- `gracefulStart` calls `bot.onStart(() => bot.syncCommands())`. This
  publishes every `.command(name, { description }, …)` registration to
  Telegram via `setMyCommands`; hashed scopes mean unchanged metadata
  doesn't burn rate-limit budget. [Source](https://gramio.dev/triggers/command.html#how-synccommands-works).

### `access-control.ts`

- **Runtime dep on `adminContext`** via `Plugin({ dependencies:
  ['@adriangalilea/utils/bot/admin'] })`. gramio throws at `bot.start()` if
  missing.
- **Session-scoped record at `ctx.session.access`**. `undefined` means
  the user has never interacted (or was /forget'd). The plugin treats that
  as `status='unknown'` for gating.
- **Cross-user writes**: `loadFullRecord(storage, userId)` →
  `storage.get(String(userId))`, mutate `.access`, `storage.set(...)`. Other
  plugins' fields preserved.
- **`ac:index`** is a separate small key listing pending/approved/denied user
  ids — admin-side data, NOT covered by /forget (it's the bot owner's
  housekeeping, not the user's personal data).
- **Approve/Deny callbacks accept optional `v` (originating view)**: if `v`
  is set, the handler refreshes that list; absent = original notification,
  edits the message inline.

### `language.ts`

- **BCP-47 validation via the standard `Intl.getCanonicalLocales`** — not
  zod, not a regex, not a fork of `bcp-47`. It's built into the JS runtime
  (Node ≥10), validates the structured tag format, and canonicalises casing
  (`'en-us'` → `'en-US'`). [ECMA-402 spec](https://tc39.es/ecma402/#sec-intl.getcanonicallocales).
- **Compile-time strictness via const tuple**: pass `supported: [...] as
  const` and `ctx.lang` is typed as the literal union.
- **Runtime strictness**: each tag in `supported` is canonicalised at
  construction; malformed tags throw immediately.
- **Telegram hint matching**: `ctx.from.languageCode` is also canonicalised
  before matching against `supported`, so `'es-MX'` from the client matches
  `'es-MX'` in your tuple (or falls through if not supported).
- **Scope**: per-user in private chats, per-chat in groups by default — see
  the file docstring for the rationale.

### `message-history.ts`

- **Opt-in**: extending this plugin says "I want to retain user content."
  GDPR responsibility shifts to the bot author at that point.
- **Two prune dimensions**: `maxMessages` (count cap) and `retentionDays`
  (age cap). Both apply on every read so handlers always see a fresh view.
- **`ctx.history` is a read-only snapshot**, not the mutable session field.
  The plugin appends to `ctx.session.history.items` in `.on('message')` and
  exposes the pruned slice via derive. Consumers can't accidentally mutate
  the session and skip retention.

### `coalesce.ts`

- See file docstring. Detection rule = (same chat) ∧ (same user, default) ∧
  (leading fragment length ≥ `minLeadingLength`) ∧ (within `windowMs`).
- Defaults `minLeadingLength: 3750` / `windowMs: 500` are current guesses
  documented as such in the source — adjust based on `log: true` output.

### `llm-stream.ts`

- See file docstring. Markdown parsed locally via `@gramio/format/markdown`
  so malformed mid-stream markup degrades to plain text instead of failing
  the whole message.
- Splits at 4000 chars on paragraph/line/word boundary (4096 is Telegram's
  hard limit; 4000 leaves headroom for entity offsets).

### `menu.ts`

- Single command per menu (`/settings` by default; configurable).
- Items are a tree (`action` / `url` / `submenu` variants). Custom items
  inline alongside built-in feature items (`lang.menuItem`).
- /forget and /export operate on the whole shared session record — no
  per-plugin dataSource registry. Simpler than the earlier design (see
  [§ Design journey](#design-journey)).
- `adminContact` is required for honest error reporting on /export failure.

---

## Design journey

These plugins went through five real iterations. Documented here so we don't
re-litigate.

### Iteration 1: each plugin extends its own `session()`

The first attempt had each plugin internally call `session({ key:
'_pluginName', getSessionKey: ... })` and declare derives via the Plugin
generic. Looked clean in isolation: each plugin self-contained, no shared
state for the user to wire.

**It didn't work.** Runtime symptom: `ctx._historySession` and `ctx.settings`
were `undefined` inside their respective plugins, while `ctx._accessSession`
(from the first-extended plugin) worked fine.

Root cause: **gramio dedupes plugin extensions by name**. `session()` always
produces a Plugin named `"@gramio/session"`. The first one through wins; the
rest are runtime no-ops. The docs call this out as the
[dedup gotcha](https://gramio.dev/extend/middleware.html#the-dedup-gotcha)
but don't spell out the consequence for the session plugin specifically.

### Iteration 2: `uniqueSession` — patch the session plugin's internal name

To dodge the dedup, I wrote a helper that mutated `plugin._.name` and
`plugin._.composer['~'].name` after construction to make each session
plugin's dedup key unique. It worked. The bot ran. All three sessions
coexisted on `ctx`.

But: tocaba propiedades internas de gramio que ningún public API expone. If
gramio renames or restructures those fields, the helper breaks silently. The
fact that this hack was needed at all signalled we were fighting the
framework, not using it.

### Iteration 3: shared session at the bot level (intermediate)

The gramio docs actually solve this. Their canonical
"[`withUser`](https://gramio.dev/extend/middleware.html#production-architecture)"
pattern: extend the shared infrastructure ONCE at the bot level, then have
sub-routers/plugins declare it as a dep. Runtime dedups the inner extensions,
TypeScript flows the types.

Applied to session: the user creates `userSession = session(...)` once,
passes a reference into each plugin (`language({ session: userSession,
... })`), and each plugin's internal `.extend(opts.session)` is the
duplicate-but-types-flow declaration.

This is what we shipped. Three options were considered before settling on
it; see [§ Options explored](#options-explored).

### Iteration 4: storage-direct (rejected)

The honest alternative to session was: drop `@gramio/session` entirely,
have each plugin do `await storage.get(key)` and `await storage.set(key,
value)` in its derives. No name collision, no internal hacks.

Rejected because:

- Loses the auto-persist Proxy ergonomics inside the plugin (`ctx.session.x
  = y` triggers persistence vs explicit `await storage.set(...)`).
- For the consumer, the user-facing `ctx.lang` / `ctx.history` types are the
  same either way — but storage-direct adds 2 reads per update where session
  caches.
- We're not really avoiding session; we'd be re-implementing it badly. The
  shared-session pattern is the framework's intended answer.

### Iteration 5: shared session, plugins as dependents

Final design. Same as iteration 3, refined: each plugin takes `session` as
a required option, declares it as `.extend(opts.session)` for type flow,
runtime dedup means the session derive only fires once per update. /forget
and /export operate on the whole session record via storage directly.

### Options explored (named for posterity)

| Option | What | Why rejected (if applicable) |
|---|---|---|
| Each plugin has its own internal `session()` | Self-contained | Dedup gotcha — only first one runs |
| Patch session internals (`uniqueSession`) | Self-contained, runs | Fights framework, touches internals |
| Single big `session()` with all fields baked in | User wires fields upfront | User has to know every plugin's shape |
| Drop `@gramio/session`, storage-direct | No dedup, no Proxy | Re-implementing session, loses ergonomics |
| **Shared session passed to each plugin** | gramio idiom, types flow, simple | _shipped_ |

### Why menu doesn't need a dataSource registry

The earlier design had each plugin expose a `{ kind, delete, read }`
descriptor that the menu collected for cascade-delete and aggregated for
/export. With shared session, there's nothing to cascade: every plugin's
data is in the same record, one `storage.delete(sessionKey(userId))` wipes
everything. The registry was solving a problem that doesn't exist in the
final architecture.

---

## Conventions

- **Spanish copy by default** in user-facing strings (deny messages, admin
  menu labels). Overridable per-bot via plugin options.
- **Emojis as button labels** — Telegram inline buttons have no native color
  styling. Use emojis as visual category markers: ✅ approve, ❌ deny, ↩️
  revoke/back, ⬅️ back, 🔄 refresh, ✖️ close, 🗑 delete, 📥 export, 📖 privacy.
- **No `as unknown as`, no `as any` in plugin code** — types flow via the
  `Plugin<{}, Derives>` generic + chained `.extend()` calls. Where TS can't
  infer (e.g. our MenuCtx for typed action callbacks), use a narrow targeted
  cast on a specific shape, not a wholesale escape hatch.
- **Default values that are guesses are labelled as such** (e.g. coalesce's
  `minLeadingLength`). The rationale lives next to the constant, not in
  docstrings several screens away.

---

## Open / TODO

- **i18n plugin** — pairs with `language`. Lookup
  `messages[ctx.lang][key]` or consume `@gramio/i18n` directly.
- **Lazy session** — `@gramio/session` supports `lazy: true` which defers
  the storage read until `ctx.session` is accessed. Worth wiring once we
  have a real bot under traffic to verify the cost of eager loads.
- **Reconcile pass for `ac:index`** — walks the index, verifies each id
  resolves to a session record with matching `access.status`,
  auto-removes orphans. Useful only if we ever see real index drift in
  production.
- **CallbackData schema migrations** — adding required fields to
  `acApprove`/`acDeny`/menu's `navCb`/etc. breaks inline buttons cached in
  old chat history. Stick to "add optional fields at the end" per gramio's
  [callback-data migration guide](https://gramio.dev/triggers/callback-query.html#schema-migrations).

---

## References

- [Production Architecture](https://gramio.dev/extend/middleware.html#production-architecture) — the `withUser` pattern + scope system
- [The dedup gotcha](https://gramio.dev/extend/middleware.html#the-dedup-gotcha) — registration-time dedup vs shared data
- [Composer guide](https://gramio.dev/guides/composer.html) — Composer vs Plugin, when to use which
- [Session plugin docs](https://gramio.dev/plugins/official/session)
- [CallbackData migrations](https://gramio.dev/triggers/callback-query.html#schema-migrations)
- [Command metadata + `bot.syncCommands()`](https://gramio.dev/triggers/command.html#command-metadata-bot-synccommands)
- [Telegram Standard Bot Privacy Policy](https://telegram.org/privacy-tpa)
- [`Intl.getCanonicalLocales` (ECMA-402)](https://tc39.es/ecma402/#sec-intl.getcanonicallocales)
