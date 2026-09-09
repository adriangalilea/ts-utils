# `@adriangalilea/utils/bot/*` — GramIO plugins

Plugins for personal Telegram bots built on [GramIO](https://gramio.dev). Each
ships as a subpath of `@adriangalilea/utils`. Peer deps (`gramio`,
`@gramio/storage`, `@gramio/session`, `@gramio/format`) are **all
optional** — install only what the subpaths you import need.

## What's here

| Subpath | What it does |
|---|---|
| `bot/kit` | The one Node-only subpath: `gracefulStart(bot, opts?)` — SIGINT/SIGTERM → `bot.stop()` → exit; force-kills if shutdown hangs; calls `bot.syncCommands()` automatically before `bot.start()`. DMs the admin `@<bot> started.` / `@<bot> shutting down.` by default when `KEV.TELEGRAM_ADMIN_ID` is set (graceful only — crashes don't fire `onStop`); pass `notifyAdmin: false` to disable, `notifyAdmin: 12345` for an explicit chat id. |
| `bot/access-control` | `accessControl({ session, storage, defaults?, dms?, groups? })` — two independent surfaces, each `"allowlist"` or `"open"`: `dms` (default allowlist — unknown DM users go pending, admin gets `[✅ Approve][❌ Deny]`; open → unknowns pass as `source: 'open'`, only a deny blocks) and `groups` (default off; allowlist → adds go pending `[✅ Approve][🚪 Leave]`, the bot stays but serves nothing, approving a room admits every member as `source: 'group'`, pre-existing rooms surface as pending on first activity; open → every add auto-approves quietly and rooms self-register, ready to be banned). Open IS the ban-list mode: `/ban <id>` / `/unban <id>` (positive = user, negative = room; banning a room leaves it), deny memory survives re-adds (leaves on sight). Canonical pairings: private bot allowlist/allowlist, public bot open/open. Persistent `/access` admin menu where STATUS is the only navigation axis — one Approved / Pending / Denied list each mixing 👤 users and 👥 rooms with per-kind actions; `onGroupRequest/onGroupApprove/onGroupDeny` hooks (send your welcome card on approve, not on add); `simulateAccessRequest()` for tests. |
| `bot/coalesce` | `coalesceLongMessages({ minLeadingLength?, windowMs?, acrossUsers?, log? })` — joins client-split inbound messages back into one event. Also exports `isCoalescent(prev, curr, opts)` as a pure utility. |
| `bot/language` | `language({ session, supported, default, scope?, labels? })` — per-user BCP-47 preference; resolves `ctx.lang` (typed); decorates `ctx.say` (callable polyglot resolver + `.send` / `.edit` / `.answer` methods); supplies a `menuItem` for `botMenu`. Also the picker VOCABULARY, exported so bots stop forking label lists: `flagFor(lang)` (region flag or curated regionless map), `autonym(lang)` (the language's name in itself via Intl), `languageLabel(lang)` ("🇪🇸 Español", title-cased). And the picker SURFACES, policy-agnostic: `languagePickerItem({ label, codes, isActive, pick, labelFor? })` — the 2-up primary-highlighted MenuItem factory (the plugin's own `menuItem` is this factory with session closures; a group-scoped admin-gated picker is the same factory with store closures); `addLanguageRows(kb, { codes, pack, active?, activeStyle?, labelFor?, perRow? })` — its raw-InlineKeyboard twin for onboarding/welcome keyboards (caller owns the callback schema via `pack`; `activeStyle: "success"` when primary already means something else on the keyboard, e.g. an active nav tab). |
| `bot/draft` | The Telegram draft painter (`createDraftPreview(ctx, { render, throttleMs? })`) — the lifecycle primitive under `bot/llm`'s `streamChatReply`, dependency-light (gramio + format TYPES only) so bots with their own rendering pull no markdown machinery. Owns throttled FULL-FRAME repaints (drafts replace, never append), the anti-expiry keepalive under the ~30s draft TTL, serialized sends, reset, quiesce, and `streamForensics` (render-regression + reset warnings, exported standalone). `render` is REQUIRED: a painter doesn't know markdown; frames are plain (`sendMessageDraft`, optional parseMode) or rich (`sendRichMessageDraft`). Private-chat-only; elsewhere every method no-ops. |
| `bot/inline-feedback` | `inlineFeedbackProbe({ bump, reset, markAlerted, adminIds })` — behavioral tripwire for BotFather's inline FEEDBACK probability (gates `chosen_inline_result`; defaults 0%, silently resets on bot TRANSFER and inline-mode toggling, invisible to `getMe` so `expects` can't see it). Served-with-results counts up via injected storage ops; a chosen event resets; ~25 served with zero chosen → throttled admin DM naming the exact switch and both reset triggers. Never throws into the answer path. |
| `bot/llm` | The Telegram side of an LLM chatbot; the model side (providers, failover, tools, usage) is `@adriangalilea/utils/llm`. **Output:** `streamChatReply(ctx, events, opts?)` consumes an `AsyncIterable<LlmStreamEvent>` and paints it with Telegram's native draft streaming (`sendMessageDraft` full-frame repaints, ~1/s throttle, keepalive under the ~30s draft TTL), then persists via `ctx.send`, entity-split by `@gramio/split`. Reasoning: `'preview'` (default — thinking lives in the ephemeral draft), `'message'` (also persists as `expandable_blockquote`), `'hidden'`. Upstream `reset` repaints from scratch. Drafts are private-chat-only; elsewhere only the final send happens. **History:** `llmHistory({ session, maxTurns, retentionDays })` decorates `ctx.llm` with `.add / .get / .clear / .all / .clearAll` — per-(user, thread) conversation buffer in OpenAI `ChatMessage` shape, persisted in the shared session record so the menu's 🗑 Forget wipes it automatically; `toModelMessages(ctx.llm.get())` converts it for `llm.stream({ messages })`. Also returns a drop-in `menuItem` ("🗑 Delete this thread") for `botMenu` — wipes the LLM history AND calls `deleteForumTopic` to physically remove the Telegram thread (with all its messages) from the chat, falling back to history-only when no `threadId` is present. |
| `bot/menu` | `botMenu({ command, description, items, privacy?, personalData?, adminContact, deleteInvocation? })` — `/settings` command + InlineKeyboard router. `deleteInvocation(ctx)` predicate deletes the user's /command message after the menu opens (tidy groups: cleanup mode on + the bot holds the Delete-messages right); best-effort, never blocks the menu. Root view always shows a `🔒 Privacy & data` button that navigates to a submenu with the privacy policy link plus (if `personalData: { storage }`) 🗑 Forget + 📥 Export. `MenuItem` supports `style` (Telegram coloured buttons: `primary` / `success` / `danger`), `refresh` (re-render in place after action so dynamic labels / styles update), `confirm: { prompt }` (one-step confirmation overlay for destructive actions — replacement for `ctx.answer({ show_alert })`), and `Action` returning `void \| string \| Polyglot<string>` (menu plugin owns the single answerCallbackQuery; actions return toasts instead of calling `ctx.answer` directly). `toggleMenuItem({ id, read, write, label: { off, on }, toast? })` builds a boolean-toggle item — dynamic label + auto-`primary` style on ON + `refresh: true` + storage-agnostic. `radioMenuItem({ id, label, header?, choices, isActive, pick, disabledWhen? })` builds ONE-setting-N-values radio submenus (kills cycling toggles and mutually-exclusive toggle pairs): one button per value, chosen wears `success` (green = chosen value; `primary` blue stays navigation), re-rendered on pick; `disabledWhen(ctx, value)` greys a choice out natively (Bot API 10.3 disabled button — no tap fires; explain why in `header`, and still refuse in `pick` for old clients). Action items expose the same as `disabled: Predicate`. Submenu items accept `header` — message text shown while inside that submenu (explainer/legend), deepest wins, root header is the fallback. |
| `bot/payments` | `botPayments({ session, storage, paysupport, legal, waiver, vip?, credits?, perks? })` — Telegram Stars monetization. Three orthogonal axes: VIP tier ladder (positional `vip.1` / `vip.2` / …), credit packs (`credits.N`), and perks (`perks.<key>`). Decorates `ctx.payments.{atLeast, tier, has, credits, require, invoice}`. Owns the Art. 103(m) TRLGDCU waiver consent flow, `/paysupport` slash command (ToS §6.5), idempotent `successful_payment` fulfillment via `pay:idempotency:{chargeId}`, admin-DM refund approval (mirror of `accessControl`'s pattern), and lazy subscription expiry. Returns `{ plugin, menuItem, payouts, admin, onFulfilled, onRefunded }`: `menuItem` is the drop-in `💎 VIP` entry for `botMenu`; `payouts` is the Fragment payout ledger (`record` / `list` / `export` / `exportForUsers`); `admin.{listCharges, getCharge}` for custom admin commands; `onFulfilled(productKey \| '*', handler)` and `onRefunded(...)` fire hooks after a charge is applied and after an admin-approved refund reverses one. Stars-only (digital goods can't use third-party providers per ToS §6.2); Crypto Pay deferred (MiCA risk); Stripe-outside-Telegram is a future v2 channel. Full compliance memo in `src/bot/payments/CLAUDE.md`. |
| `bot/storage` | `botRecord<T>(storage, prefix, validator?)` / `botIndex(storage, prefix, { capacity? })` / `botSentinel(storage, prefix)` — typed storage primitives with automatic bot-id namespacing. Validator is structural (`{ parse(unknown): T }`) — zod / valibot / ArkType / hand-rolled all work. Records validate on read; corrupted storage throws `SourcedError({ source: 'storage', operation: 'validate' })` instead of NaN-ing downstream. Index is a capped, prepend-friendly de-duping `string[]`. Sentinel claims an id atomically (boundaries permitting). Used internally by `bot/payments`; available to bot authors for custom plugins. |
| `bot/ctx` | `BotMessageCtx<S, Api>` / `BotCallbackCtx<S, Query, Api>` / `BotPaymentCtx<S, Api>` / `BotPreCheckoutCtx<Api>` — canonical structural ctx shapes that gramio's real contexts satisfy by duck-typing. `narrow<T>(ctx)` is the documented cast helper. Plugins parameterize with their `Session` shape + strict `Api` (per-method-typed `bot.api`) and stop redeclaring "ctx has session + from + send + …" in every handler. |
| `bot/keys` | The bot-id key namespace, a **persisted contract** owned in one place: `botId(ctx)` / `botStorageKey(ctx, userId)` → `bot-<id>:<userId>` / `botSubKey(ctx, sub)` → `bot-<id>:<sub>`. Session keying, menu Forget/Export, access records, payments indexes all derive from it; the shape lives in consumers' storage rows and never changes. Pure functions of `ctx.bot.info.id` — Worker-safe. |
| `bot/flags` | `defineFlags(spec, { read, write? })` — feature flags declared ONCE in code, resolved LIVE from the bot's operator-config record (a D1 json row, a Redis hash — storage-agnostic, Worker-safe, zero deps). Each flag is `{ kind: 'bool'\|'number'\|'string', label, help?, default }` where `default` is a scalar or a tier map `{ free, vip?, 'vip.N'? }` resolved off `ctx.payments.tier()` (ladder walks down: exact rung → lower rungs → `vip` → `free`; no payments plugin = everyone is `free`). Read sites call `await flags.<key>(ctx)` — override wins over default, per-ctx reads coalesce to one config fetch. `flags.describe()` is the JSON schema admin surfaces render generically (a new flag appears in every panel with zero panel edits); `flags.set(ctx, key, value)` writes a live override (kind-checked, `null` clears — RFC 7386 null-deletes, matching SQLite `json_patch`); `flags.overrides(ctx)` lists what's actually overridden. Corrupt stored overrides scream (`SourcedError`), bad specs panic at construction. |
| `bot/groups` | Group-chat identity, plain functions (no plugin, no derive): `chatIdOf(ctx)` (the chat id on ANY ctx flavour), `isGroupChat(ctx)` / `isPrivateChat(ctx)` chat-type predicates, and `isGroupAdmin(ctx, { chatId?, userId? }?)` — the admin check every admin-gated group setting needs, chat/user defaulted from the ctx. Built on `getChatAdministrators` membership, NOT `getChatMember`: in a hidden-member-list group, `getChatMember` on another user rejects `CHAT_ADMIN_REQUIRED` for a non-admin bot, denying every real admin — the admin list stays readable everywhere the bot is present. Every reader resolves BOTH ctx spellings — message ctxs carry `chat`; `CallbackQueryContext` (every inline-button tap) has NO `chat`, only `chatId` + `message.chat` — so gates work identically in handlers and taps; read chat ids via `chatIdOf`, never `ctx.chat?.id`. Accepts real gramio ctxs AND `MenuCtx` with no cast. A miswired ctx (no `bot.api.getChatAdministrators`) panics; an API rejection fails CLOSED (`false`) — it's a permission gate. Policy stays at the call site: `ctx.isAdmin \|\| await isGroupAdmin(ctx)`. Anonymous admins pass BOTH ways: their own message wears the chat in `senderChat` (= proof, no API call; a linked channel's auto-forward wears the channel's id, never equal), and callback taps carry their real user, present in the admin list. |
| `bot/user` | `userLabel(u)` — the "[name] [@username] [id]" composition every bot re-rolls for admin DMs / logs / access panels, done once: `Ada Lovelace (@ada · 42)`, each missing piece drops (never padded), both gramio spellings read (`firstName` and raw `first_name`). Plain text by design (admin DMs go out without parse_mode; `<`/`&` in names must stay literal). `UserRef` accepts a gramio `from`, a raw payload user, or a stored row. |
| `bot/callbacks` | `callbackNs("plugin").data("name", { uid: 'number' })` — namespaced `CallbackData` factory with a process-wide collision registry. Repeated registration with the same shape returns the cached schema (HMR / dual-import safe); a second registration with conflicting fields panics. gramio hashes the full name to a 6-char wire prefix regardless of name length, so namespace discipline costs nothing on `callback_data`. |
| `bot/admin` | `adminContext(admins)` — decorates `ctx.adminId` (the primary admin: the approve/deny and notification target) and `ctx.isAdmin` (any admin). Ids come in POSITIONALLY as a number, an array, or a FUNCTION consulted per update, so a db-backed resolver goes live with no restart. Reads no env and touches no OS, which is what keeps it Worker-safe; a Node bot composes env in at the call site. `parseIdList("123, 456 789")` turns an env string into clean ids. `accessControl` and the payments refund flow declare a gramio dependency on this plugin's name. |
| `bot/allow-list` | `allowList({ ids?, usernames? })` — stateless gate by id and/or @username, no session, no storage; decorates `ctx.allowed` and you gate in your handlers. `makeAllowList(...)` is the same rule as a bare predicate. The light counterpart to `access-control`. A @username is optional and mutable and the Bot API cannot resolve one to an id ahead of time, so prefer `ids`. |
| `bot/announce` | The house announcement template as a structure: compose an `Announcement` once (banner, optional Info / New Features / Fixes sections, closer, signature), render it per language, hand the bodies to a broadcast engine. Renders the common Telegram-markdown subset (`# heading`, `- ` bullets, `*italics*`) that bot pipelines already convert to HTML, so no parse_mode is assumed. |
| `bot/create` | `createBot<S>({ token?, storage?, initial?, admins?, language?, menu?, access?, payments?, handlers?, worker? })` — the composer that builds the storage + session pair ONCE and threads it into every feature, making "must be the same instance" structural instead of a doc warning. Returns `{ build, session, poll, isMain, fetch }`: `poll()` long-polls, `export default app` is a complete Worker, `app.session(ctx)` is the typed accessor for `S`. Storage is an environment decision (D1 binding → `bot/storage-d1`, `BOT_PERSIST` path → sqlite, `redis://` → redis, else announced-ephemeral memory), and boot narrates what it chose. |
| `bot/lang` | Internal, no subpath: `FALLBACK_LANG`, `ctxLang(ctx)`, `langOfUser(storage, ctx, userId)` and `loadFullRecord` — the language every surface reads and the session record it comes from, owned once so no two plugins can disagree about either. |
| `bot/notify` | Best-effort admin DMs, fire-and-forget BY CONTRACT (a notification must never take the bot down): `notifyAdmins(bot, adminIds, text, extra?)`, `alertAdminError(bot, adminIds, label, error, throttle?)` rate-limited through a caller-owned `alertThrottle(ms?)` so a failure storm sends one alert per window. Worker-safe: the caller passes the ids. |
| `bot/profile` | `syncBotProfile(bot, { name?, description?, about?, photo?, commands?, expects?, adminIds? })` — the bot's Telegram-facing identity as CODE rather than BotFather text boxes, localized and reconciled on every boot with a get → compare → set diff per field per language, so an unchanged value costs one read and a cold start is rate-limit-free. What the API cannot set (the token, the inline-mode switch) is declared as an EXPECTATION instead: `getMe` is checked and the admins are DMed when reality disagrees. Never throws. |
| `bot/reactions` | Which emoji Telegram accepts as a message reaction, and who owns the bot's reaction on a message. `TELEGRAM_REACTIONS` / `isReaction(emoji)` / `reactionsFor(available)` are the accepted set, MEASURED by `scripts/probe-reactions.ts` because the Bot API only reports `available_reactions` for chats that restrict them. `reactionPolicy({...})` arbitrates: `setMessageReaction` REPLACES the bot's whole reaction set, so independent features reacting to one message clobber each other; semantic states with ranks give the message one owner. |
| `bot/session` | `botSession(opts)` — drop-in replacement for `@gramio/session`'s `session()` that namespaces every key as `bot-<id>:<senderId>` from `ctx.bot.info.id`. Use this instead of `session()`, full stop: several bots on one Redis stay isolated by construction, and every plugin here derives the same prefix internally. |
| `bot/storage-d1` | A `@gramio/storage` adapter over one Cloudflare D1 table (four methods over JSON). Its `flush()` exists because `@gramio/session` calls `set()` without awaiting and a Worker freezes the isolate the moment `fetch()` returns: hand `flush()` to `ctx.waitUntil`, which `bot/worker` does for you. Typed structurally (prepare → bind → first/run), so no `@cloudflare/workers-types` dependency. |
| `bot/text` | Telegram outbound-text mechanics: `TELEGRAM_MAX_CHARS`, `fitTelegramText(text, { maxChars?, preserveFinalBlock? })` for deterministic fitting under the limit (keeping a short final source/footer block when asked), and the classifier for Telegram's "message is not modified" edit no-op. Dependency-free, Worker-safe. |
| `bot/update-identity` | Pure update identity: who an update is from, which conversation it belongs to, what callback data it carries. Dependency-free and Worker-safe, so webhook ingress, durable runners and tests share one routing and deduplication contract. |
| `bot/updates` | The pending-update queue of a webhook-less token, treated as the destroy-on-read resource it is. PEEK (`getUpdates` with no offset) confirms nothing, so webhook state, pending count and queue head are inspectable at zero risk. DRAIN is write-before-confirm: each raw batch goes to your `onBatch` and is AWAITED before the next call advances the offset, so a crash mid-drain re-delivers the unconfirmed tail. A 409 (webhook registered, or a competing poller) surfaces as a typed error, never a silent retry. |
| `bot/urls` | Message URL + entity parsing on what Telegram ALREADY parsed: entities carry exact UTF-16 spans, and JS strings are UTF-16. `urlsInMessage` is the load-bearing verb — the visible text scanned by `urlsIn` PLUS `text_link` entities, the hyperlinked words whose URL never appears in the text and which no text scanner can see. Returns the same `Url` objects as `universal/url`, spans indexing the message text. |
| `bot/worker` | The Cloudflare Worker cap: `POST /` (webhook, secret-token checked, acked immediately with the update riding `ctx.waitUntil`, or persisted into a per-conversation Durable Object first when `durableUpdates` is set), `POST /setup` (registers the webhook with `allowed_updates` DERIVED from the bot's handlers), plus pause and deploy-DM endpoints. The workerd twin of `bot/kit`'s `gracefulStart`. |

Implementation files are flat under `src/bot/`. There is no barrel: every
module is reached by its own subpath, so a bot pays only for what it imports.

## Standard wiring

```ts
import { Bot } from 'gramio'
import { redisStorage } from '@gramio/storage-redis'

import { adminContext } from '@adriangalilea/utils/bot/admin'
import { botSession } from '@adriangalilea/utils/bot/session'
import { gracefulStart } from '@adriangalilea/utils/bot/kit'
import { accessControl } from '@adriangalilea/utils/bot/access-control'
import { coalesceLongMessages } from '@adriangalilea/utils/bot/coalesce'
import { llmHistory, streamChatReply, toModelMessages } from '@adriangalilea/utils/bot/llm'
import { language } from '@adriangalilea/utils/bot/language'
import { botMenu } from '@adriangalilea/utils/bot/menu'

// Raw redis is fine — bot-id namespacing happens inside botSession + every
// plugin via ctx.bot.info.id. Multiple bots sharing this Redis stay isolated.
const storage = redisStorage()

// ONE session at bot level. botSession() wraps gramio's session() with
// getSessionKey forced to `bot-<id>:<senderId>` — nothing else to wire.
const userSession = botSession({
  storage,
  key: 'session',
  initial: () => ({}),
})

const lang = language({
  session: userSession,
  supported: ['en', 'es'] as const,
  default: 'en',
})

const chat = llmHistory({
  session: userSession,
  maxTurns: 20,
  retentionDays: 7,
})

const menu = botMenu({
  command: 'settings',
  description: 'Open settings',
  adminContact: '@yourhandle',
  personalData: { storage },                  // enables 🗑 Forget + 📥 Export (wipes ctx.llm too)
  items: [
    lang.menuItem,
    chat.menuItem,                            // 🗑 Delete this thread
  ],
})

const bot = new Bot(process.env.BOT_TOKEN!)
  .extend(adminContext(123456789))
  .extend(userSession)                                                      // SESSION FIRST
  .extend(accessControl({ session: userSession, storage, defaults: [] }))
  .extend(coalesceLongMessages())
  .extend(chat.plugin)
  .extend(lang.plugin)
  .extend(menu.plugin)

await gracefulStart(bot)   // DMs admin on start/stop by default (KEV.TELEGRAM_ADMIN_ID)
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

## Threads

Telegram bots see threaded messages in two flavours: forum-supergroup
topics and the newer BotFather "Threaded Mode" for private chats. Both
arrive with `message_thread_id`, surfaced by gramio as `ctx.threadId`.

gramio's `SendMixin` auto-forwards `message_thread_id` on every
`ctx.send` / `ctx.reply` / `ctx.sendDocument` / `...` whenever
`ctx.threadId` is set — covers both flavours. No helper needed; just
call `ctx.send(text)` and the reply lands in the right thread.

Threaded Mode auto-thread and `threadId`/`isTopicMessage()` on
`CallbackQueryContext` are upstream since `@gramio/contexts` 0.9 (what
gramio 0.12 resolves) — plain npm installs get both; no fork, no
override.

`bot/llm`'s `streamChatReply` calls `bot.api.sendMessageDraft` directly
(drafts have no SendMixin helper for full-frame repaints), forwarding
`ctx.threadId` on every frame; the finalizing sends go through
`ctx.send`, which auto-threads.

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

## gramio foot-guns — the four we lost time on

gramio's docs are mostly excellent, but four behaviours bit us during
the `bot/payments` build. Documented here so the next plugin doesn't
re-discover them.

### 1. `.on(type, fn)` requires explicit `next()`

gramio implements `.on('message', fn)` as an explicit middleware: `fn`
receives `(ctx, next)` and **must call `next()`** for the chain to
continue. Looks like a passive listener; behaves like a stopper.

```ts
// ❌ BUG — this kills the chain for every message event. /start, /me,
//   /vip, every other .command() registered later silently never fires.
.on("message", async (ctx) => {
  if (!ctx.successful_payment) return  // ← silently stops chain
  await fulfill(ctx)
})

// ✅ FIX — pass `next()` through for both branches:
.on("message", async (ctx, next) => {
  if (!ctx.successful_payment) { await next(); return }
  await fulfill(ctx)
  await next()
})
```

The pattern in `composer.md` makes this explicit:

```ts
command(cmd, handler) {
  return this.on("message", (ctx, next) => {
    if (ctx.text?.startsWith(`/${cmd}`)) return handler(ctx)
    return next()                              // ← skip → continue chain
  })
}
```

Matched commands deliberately don't call `next()` (terminal handler).
**Type-filter** handlers (like `bot/payments`' `successful_payment`
filter) always must, because peer `.command()`s registered after them
depend on the chain advancing. `.callbackQuery(schema, fn)` and
`.command(name, fn)` are auto-wrapped, so this only bites raw `.on()`
inside plugins.

### 2. `allowed_updates` auto-derives from `.on()` calls — dedicated events MATTER

gramio's `bot.start()` runs `registeredEvents()` over the whole
composer tree to compute `allowed_updates`. If you write

```ts
bot.on("message", (ctx) => {
  if (!ctx.payload.successful_payment) return
  // ... fulfill
})
```

you'll **never receive** a service-message payment. Telegram doesn't
deliver service messages over the generic `message` channel unless
you also subscribe to the dedicated event type. The fix is to use the
purpose-built event:

```ts
bot.on("successful_payment", (ctx) => {
  // ctx.eventPayment.payload.telegram_payment_charge_id
})
```

Same rule for `pre_checkout_query`, `shipping_query`, `chat_member`,
`business_connection`, …: if there's a dedicated event type for it,
subscribe to that — generic `message` is a different channel.

### 3. Wrapper class vs raw payload — pick one, stick to it

gramio wraps Telegram objects in classes with camelCase getters and
exposes the raw snake_case payload on a `.payload` field:

```
ctx.eventPayment               // SuccessfulPayment wrapper
ctx.eventPayment.totalAmount   // camelCase getter
ctx.eventPayment.payload       // TelegramSuccessfulPayment (raw)
ctx.eventPayment.payload.total_amount   // snake_case field
```

If you mix them — reading `ctx.eventPayment.total_amount` (snake_case
on the wrapper, doesn't exist) — you get `undefined` with zero error.
This package's convention is **always go through `.payload`** for
payment / shipping / pre-checkout reads; the rest of the package
(record shapes, log lines) speaks snake_case end-to-end. The
canonical ctx type in `bot/ctx.ts` (`BotPaymentCtx`) bakes this in.

### 4. `Plugin.extend()` isolates derives by default

Composers extended with `.extend(plugin)` wrap the plugin's middleware
in an isolation group. Derives run inside the group; the values
**don't propagate to the parent ctx** unless the plugin is marked
`.as("scoped")` or `.as("global")`. gramio's `Plugin` class
auto-applies `scoped` for the ctx-decorating use case we have, but
it's not obvious. If you write a custom `Composer` and forget the
scope, every downstream handler sees `ctx.yourField` as `undefined`
while TS happily types it.

Pattern: when a Composer is for ctx enrichment (e.g. `withUser`,
`withAuth`), end the chain with `.as("scoped")` so the derives bubble
up. `Plugin` already does this internally.

---

## Building blocks — the four utilities every plugin uses

When writing a new `bot/*` plugin, reach for these instead of
reinventing storage / context / callback boilerplate. They exist for
the specific frictions called out above.

### `bot/storage` — typed storage with bot-id namespacing

```ts
import { botRecord, botIndex, botSentinel } from "../storage.js"

const charges    = botRecord<ChargeRecord>(storage, "pay:charge", ChargeSchema)
const idem       = botSentinel(storage, "pay:idem")
const userChrgs  = (userId: number) =>
  botIndex(storage, `pay:user:${userId}:charges`, { capacity: 100 })

await charges.set(ctx, chargeId, charge)         // namespaced + validated
const c = await charges.get(ctx, chargeId)        // ChargeRecord | undefined
if (!(await idem.claim(ctx, chargeId))) return    // idempotent fulfillment
await userChrgs(userId).prepend(ctx, chargeId)    // cap-bounded list
```

Validators are structural (`{ parse(unknown): T }`) so zod, valibot,
ArkType, or a hand-rolled type guard all work. Omit the validator for
unchecked reads (same behaviour as `storage.get(key) as T`).

### `bot/ctx` — canonical structural ctx shapes

```ts
import { type BotCallbackCtx, narrow } from "../ctx.js"

.callbackQuery(refundApproveCb, async (ctx) => {
  const c = narrow<BotCallbackCtx<MySession, { cid: string }> & AdminDerives>(ctx)
  // c.session.foo, c.queryData.cid, c.answer({...}), c.editText("..."), c.bot.api.x
})
```

Replaces the per-handler `const c = ctx as unknown as { session, from, answer, editText, queryData, ... }` redeclarations. One source of truth in `bot/ctx.ts`; plugin-specific derives compose via type intersection.

### `bot/callbacks` — namespaced callback registry

```ts
import { callbackNs } from "../callbacks.js"

const cb = callbackNs("pay")                            // reserves "pay" prefix
export const waiverConsent = cb.data("waiver:consent", { pk: "string" })
export const refundApprove = cb.data("refund:approve", { cid: "string" })
```

Cross-plugin name collisions throw at registration. Duplicate
registration with the same shape returns the cached `CallbackData`
(HMR / dual-import safe). gramio still hashes the full name to a
6-char wire prefix so name length doesn't bloat `callback_data`.

### `bot/menu` — `MenuItem.id` constraint

Already covered above (no dots — uses `_`). The `botMenu` constructor
validates ids recursively and panics on violation. Worth re-stating
here because it's the same class of issue: silent dispatch failure due
to namespace collision.

---

## Plugin file convention

Each `bot/<plugin>/` directory follows the same shape so new plugins
read predictably:

```
src/bot/<plugin>/
├── CLAUDE.md       ← design + compliance + flows
├── types.ts        ← public + internal types, schemas
├── config.ts       ← validateConfig + buildCatalog (pure)
├── handlers.ts     ← .on(eventType) handlers (event filters)
├── callbacks.ts    ← .callbackQuery() handlers (inline taps)
├── commands.ts     ← .command() handlers (slash commands)
├── derive.ts       ← ctx.<plugin> builder (the ctx decoration)
├── menu-item.ts    ← MenuItem factory for botMenu integration
├── plugin.ts       ← assembly: .extend() + .derive() + .on() + .callbackQuery() + .command()
└── index.ts        ← public exports
```

`plugin.ts` is **wiring only** — no handler bodies. Each `.on()` /
`.callbackQuery()` / `.command()` line delegates to a function imported
from the matching concern file. Reading `plugin.ts` should be 60 seconds
of inspection, not 500 LOC of decryption.

---

## Snapshot vs live derives — the staleness gotcha

gramio `.derive(...)` returns values that are computed once per event
and assigned to `ctx` at the START of the handler chain. Anything you
read from a derive (`ctx.lang`, `ctx.access`, …) is **frozen for the
duration of that event**. If a handler mutates the underlying state
mid-event (typical: `MenuItem.action` toggling a session field, then
`refresh: true` re-renders, then label / style resolvers run), those
resolvers see the **stale snapshot**, not the post-mutation value.

The library handles this two ways, depending on what makes sense per
derive:

- **Live access** for emit-time values: `ctx.say(...)` re-reads
  `ctx.session.language` on every call. Safe to use anywhere — before
  or after a mid-event mutation. Use it for outgoing-message
  rendering.

- **Documented snapshot** for state-reading: `ctx.lang` (the resolved
  current language) and `ctx.access` (the gate decision) stay
  event-start snapshots. Cheap to read repeatedly, but read
  `ctx.session.<field>` directly when you need post-mutation
  freshness (typical inside resolvers for label / style on items
  with `refresh: true`).

This package's own `language.menuItem` style resolver and any custom
toggle / selection resolver should read `ctx.session.<field>`. The
JSDoc on `MenuItem.style` / `LanguageDerives.lang` calls this out.

## Multi-bot isolation — `botSession` handles it for you

`@gramio/session`'s default `getSessionKey` is `String(senderId)`. If several
bots share the same backend (one Redis, one SQLite file, one in-memory map
re-imported, …), they all write the same user's record to the same key
and the last writer wins:

```
redis['123456789'] = { access, language, llm }   ← whichever bot wrote LAST
```

Symptom: `/settings → 📥 Export` on bot A returns the data bot B last wrote.
`/settings → 🗑 Forget` on bot A wipes bot B's record too.

The library handles this for you — **use `botSession()` from this package
instead of `@gramio/session`'s `session()`**:

```ts
import { botSession } from '@adriangalilea/utils/bot/session'

const userSession = botSession({ storage, key: 'session', initial: () => ({}) })
```

`botSession` is a thin wrapper that forces `getSessionKey: ctx => `bot-${ctx.bot.info.id}:${ctx.senderId}``.
Every plugin in this package (`accessControl`, `botMenu`'s Forget/Export,
`llmHistory`) derives the same `bot-<id>:` prefix from `ctx.bot.info.id`
internally via `botStorageKey(ctx, userId)` / `botSubKey(ctx, sub)`, so the
whole keyspace stays disjoint without any user-side wrapping.

Resulting Redis layout for two bots sharing one instance:

```
bot-7000000001:123456789   = { access, language, llm }   ← bot A, user 123…
bot-7000000001:ac:index    = { pending, approved, denied }

bot-8000000002:123456789   = { ... }                     ← same human, bot B
bot-8000000002:ac:index    = { ... }
```

The bot id comes from `ctx.bot.info.id`, populated by gramio's `getMe()`
during `bot.init` / `bot.start`. No regex on the token, no manual prefix
argument, no way for a consumer to forget. Token rotation (BotFather →
Revoke) doesn't change the id, so prefixes survive rotation.

## Architecture: shared session, one record per user

All per-user state across the plugins in this package lives in ONE shared
`@gramio/session` record. Each plugin owns a distinct field by convention:

```
storage[String(userId)] = {
  access:   { status, approvedAt, … },               // ← bot/access-control
  language: 'es',                                     // ← bot/language
  llm:      { shards: { '12345': [{role, content, date}, …] } },  // ← bot/llm (llmHistory)
  // (any field you add via your own handlers, or a future plugin)
}
```

The user creates the session at bot level. Each plugin **declares the session
as a required option** and `.extend()`s it internally so its handler types see
`ctx.session`. gramio's runtime deduplication ensures the session derive only
runs once per update.

### Why this and not separate sessions per plugin

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

It is also why the menu has no per-plugin dataSource registry and nothing to
cascade-delete: every plugin writes into ONE record, so a single
`storage.delete(botStorageKey(ctx, userId))` wipes all of it and /export
reads the same row.

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

Conversation history retained by `llmHistory` is covered by [Telegram's
Standard Bot Privacy Policy](https://telegram.org/privacy-tpa) — Telegram
explicitly designed Threaded Mode for AI chatbots to keep multi-turn
context per topic. No custom privacy URL required.

Exposing 🗑 Forget / 📥 Export via `personalData: { storage }` is still
recommended for user transparency (one-tap data review + wipe) but isn't
legally required by the standard policy.

`adminContact` is **required** on `botMenu` — when /export's `sendDocument`
fails (transient network, file too big, etc.), the user gets a clear error
pointing them at a human. A bot that asks users to trust it with data must
always have a human escape hatch.

---

## Per-plugin notes

### `admin.ts` — `adminContext`

- `adminContext(admins)` takes the ids POSITIONALLY: a number, an array,
  or a function consulted per update (a db-backed resolver goes live with
  no restart). It reads no env and touches no OS, which is what keeps it
  Worker-safe; a Node bot composes env in at the call site
  (`adminContext(kev.int('TELEGRAM_ADMIN_ID', 123456789))`).
- `parseIdList(raw)` turns a `"123, 456 789"` env string into clean ids.

### `kit.ts` — `gracefulStart`

- `gracefulStart` accepts `AnyBot` because after `.extend()` chains the
  concrete Bot type is a heavily-parameterised union; `Bot` (bare) won't
  accept it.
- `gracefulStart` calls `bot.onStart(() => bot.syncCommands())`. This
  publishes every `.command(name, { description }, …)` registration to
  Telegram via `setMyCommands`; hashed scopes mean unchanged metadata
  doesn't burn rate-limit budget. [Source](https://gramio.dev/triggers/command.html#how-synccommands-works).

### `access-control.ts`

- **Native alternative**: BotFather → Bot Settings → Access → "Restrict
  bot usage". Hard pre-filter at Telegram. Use it when a static allow-list
  is enough; use this plugin when you want in-bot approval + revoke flows.
  Can coexist (BotFather filters first, plugin layers dynamic UX on top).
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

### `coalesce.ts`

- See file docstring. Detection rule = (same chat) ∧ (same user, default) ∧
  (leading fragment length ≥ `minLeadingLength`) ∧ (within `windowMs`).
- Defaults `minLeadingLength: 3750` / `windowMs: 2000` are current guesses
  documented as such in the source — adjust based on `log: true` output.
  `windowMs` is the max gap between fragments (timer is debounced — each
  continuation resets it), not the total wait.

### `llm.ts`

Two primitives in one file: `streamChatReply` (render an
`@adriangalilea/utils/llm` event stream into the chat) and
`llmHistory({...}).plugin` → `ctx.llm.{add,get,clear,all,clearAll}`
(per-thread conversation buffer) + `toModelMessages` (history → AI SDK
`ModelMessage[]`). Input-side SSE parsing, provider dialects, failover,
and tools all live in the `llm` module — nothing here talks to a model.

- **`streamChatReply`**: Telegram-native draft streaming — full-frame
  `sendMessageDraft` repaints (~1/s throttle, keepalive re-emits under
  the ~30s draft TTL), so upstream `reset` events and the thinking→answer
  phase switch each cost one frame. Markdown parsed per frame via
  `@gramio/format/markdown` (malformed mid-stream markup degrades to
  plain text); the final send is entity-split by `@gramio/split` (4096,
  entity-correct across boundaries). Drafts are private-chat-only and
  need BotFather forum-topic mode; other chats skip the preview phase.
- **`ctx.llm`** (from `llmHistory({...}).plugin`): synchronous read/write
  through `@gramio/session`'s auto-persisting Proxy. Per-(user, thread)
  shards keyed by `String(ctx.threadId)` or `'general'`. Two prune
  dimensions: `maxTurns` and `retentionDays`, applied on every read.
  Stores any role (`user` / `assistant` / `system` / `tool`); caller
  decides what to persist. Last-write-wins on concurrent appends —
  acceptable for chatbots (users rarely race themselves).

### `menu.ts`

- Single command per menu (`/settings` by default; configurable).
- Items are a tree (`action` / `url` / `submenu` variants). Custom items
  inline alongside built-in feature items (`lang.menuItem`).
- /forget and /export operate on the whole shared session record — no
  per-plugin dataSource registry (see [§ Why this and not separate sessions
  per plugin](#why-this-and-not-separate-sessions-per-plugin)).
- `adminContact` is required for honest error reporting on /export failure.

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
