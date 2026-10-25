# @adriangalilea/bot

Plugins for personal Telegram bots built on [GramIO](https://gramio.dev), and the Telegram HTML and Markdown renderers they send through. Each plugin lives at its own subpath; peer deps (`gramio`, `@gramio/storage`, `@gramio/session`, `@gramio/format`, `@gramio/split`) are **all optional** — install only what you import.

Part of [ts-utils](https://github.com/adriangalilea/ts-utils). The model side of an LLM chatbot is [`@adriangalilea/llm`](https://github.com/adriangalilea/ts-utils/tree/main/packages/llm#readme); the logger, `kev` and `say` come from [`@adriangalilea/utils`](https://github.com/adriangalilea/ts-utils/tree/main/packages/utils#readme).

## Installation

```bash
pnpm add @adriangalilea/bot gramio @gramio/storage @gramio/session
```

## Telegram HTML (`tg-html`)

Transform arbitrary (LLM-emitted) HTML into Telegram-compatible `parse_mode=HTML` with opinionated, consistent spacing. Telegram's HTML subset has no headings, lists, or block layout — send it `<h1>`/`<ul>` and the API rejects the whole message. `transform()` accepts the HTML a model naturally writes and renders the structure typographically: `h1` → bold+underline + blank line, `h2…h6` → bold + blank line, `ul/li` → `• ` bullets, blocks get blank lines, blockquotes keep their internal line breaks, allowed tags pass through with attributes filtered, unknown tags drop their markup (content kept), and stray `<`/`>` escape instead of vanishing. Zero dependencies, no DOM, Worker-safe.

```typescript
import { transform } from '@adriangalilea/bot/tg-html'

transform('<h1>Title</h1><ul><li>Point one</li><li>Point two</li></ul>')
// '<b><u>Title</u></b>\n\n• Point one\n• Point two'
```

## Telegram Markdown (`tg-md`)

The MARKDOWN twin of `tg-html`, for the markdown LLMs actually emit (grown in xtldr's bot, moved here verbatim). One opinionated dialect — `_` is NEVER emphasis so `snake_case` survives, every tag balanced by construction so Telegram can't reject a render, pure whole-string functions so full-frame draft repaints (`bot/draft`) degrade malformed mid-stream markdown to literal text — rendered to every shape a bot sends:

```typescript
import { markdownToRichHtml, markdownToTelegramHtml, toPlainText, tidyRichMarkdown } from '@adriangalilea/bot/tg-md'

markdownToRichHtml(md, coverUrl) // rich-message HTML (Bot API 10.1): real <h1>/<ul>, cover <img> spliced after the title
markdownToTelegramHtml(md)       // strict parse_mode=HTML subset: bold-underlined title, breathing headings, • bullets, ###### footer stays quiet
toPlainText(md)                  // last-ditch fallback; quotes keep their > marker
tidyRichMarkdown(md)             // strip the stray ```fence``` models wrap replies in
```

Zero dependencies, Worker-safe. Typography (heading air, bullet glyph, title underline) IS the opinion; it gets options when a second consumer needs a different look, not before.

## Telegram bot plugins (GramIO)

### One bot file, ideation → production (`bot/create`)

`createBot` is the composer: it constructs the storage + session pair ONCE and threads it into every feature, so "must be the SAME instance you passed to session()" is unrepresentable instead of a doc warning. The same file runs in every stage — **storage and transport are environment decisions, never code shape**:

| stage | run | session | transport |
|---|---|---|---|
| ideation | `BOT_TOKEN=… tsx bot.ts` | memory (ephemeral, announced) | long-poll |
| experiment | `BOT_PERSIST=./bot.sqlite tsx bot.ts` | sqlite | long-poll |
| prod · your own hardware | systemd/launchd unit running the same command | sqlite / `BOT_PERSIST=redis://…` | long-poll (a legitimate prod mode: dials out, no inbound port/TLS) |
| prod · Cloudflare Worker | `wrangler deploy` (D1 binding `DB`) | D1 (`bot/storage-d1`) | webhook (`bot/worker`) |
| prod · Node/Bun server | webhook behind your HTTP server | sqlite/redis | fetch-shaped handler |

```typescript
import { createBot } from '@adriangalilea/bot/create'

const app = createBot({
  admins: 123456789,
  language: { supported: ['en', 'es'] as const, default: 'en' },
  menu: {
    adminContact: '@you',
    header: async (ctx) => `⚙️ hi ${ctx.from?.firstName}`,   // async — read your db here
    items: [/* … */],
    personalData: { onForget: async (ctx, userId) => {/* wipe YOUR tables */} },
  },
  handlers: (bot) => bot.command('start', (ctx) => ctx.say({ en: 'hi', es: 'hola' })),
})

export default app                       // Worker: webhook + /setup + /pause + deploy DMs
if (app.isMain(import.meta)) app.poll()  // Node: `tsx bot.ts` long-polls
```

Cloudflare is one adapter, not the architecture: `bot/worker` and `bot/storage-d1` are the workerd cap (~each 100 lines, both optional); `bot/kit`'s `gracefulStart` is the Node twin (signals + start/stop DMs) and stays the one deliberately Node-only corner. The worker-safe tripwire (`pnpm test:repo`) guarantees the core never grows a Node dependency.

### Design rules the bot plugins hold to (each learned the hard way)

- **Resolution is read-time.** Language resolves stored pick → live Telegram hint → default on every surface (`ctx.lang`, `ctx.say`, menu chrome, picker highlight). Inferred values are NEVER persisted — a user who switches their client language moves with it until they pick.
- **Only explicit user signals are stored.** The session holds picks, consent, state the user created — never derived values, never render caches. If a sync signature ever tempts you to cache a rendered string into the session, the signature is the bug (menu resolvers are async for exactly this reason).
- **Derives cover every event the user can speak through** — message, callback, AND inline. A feature that skips inline forces consumers to fork shadow helpers that read the session directly; those forks then read as design.
- **Forget actually forgets.** `personalData.onForget` runs inside the same try as the session delete: your message logs/metrics/credit rows get wiped too, or the user is told it failed — never a partial erasure reading as success.
- **The composer owns instance wiring.** Features still compose manually (below) when you need full control, but every "same instance" contract has one home.

### Threaded Mode

Telegram's [Threaded Mode](https://telegram.org/blog/threaded-conversations) for private chats (BotFather → Bot Settings → Threaded Mode) auto-threads out of the box: `@gramio/contexts` ≥0.9 (what gramio ≥0.12 resolves) forwards `message_thread_id` on every `ctx.send` / `ctx.sendDocument` / `ctx.reply` — including from callback handlers, which carry `threadId` too. No fork, no override.

**Runs on Cloudflare Workers / bun / anywhere.** Every bot subpath below is import-safe off Node — no filesystem access, no `node:*` modules, no import-time side effects anywhere in its graph — **except `bot/kit`**, whose `gracefulStart` handles process signals. `pnpm test:repo` walks every graph and screams on regression.

| Subpath | What it does |
|---|---|
| `@adriangalilea/bot/ctx` | Structural ctx types (`BotMessageCtx`, `BotCallbackCtx`, …) and the `narrow<T>(ctx)` cast helper. Pure typing — no runtime state. |
| `@adriangalilea/bot/keys` | The bot-id key namespace, a **persisted contract**: `botId(ctx)`, `botStorageKey(ctx, userId)` → `bot-<id>:<userId>`, `botSubKey(ctx, sub)` → `bot-<id>:<sub>`. Every storage key the library writes derives from here, and those keys live in YOUR Redis/D1 rows — the shape never changes. Pure functions of `ctx.bot.info.id` (no env/fs), which is what keeps the whole bot surface Worker-safe. |
| `@adriangalilea/bot/poll` | Long polling as a transport this package owns, the twin of `bot/worker`'s webhook: `longPoll(bot, { timeout? })` starts the bot and polls `getUpdates` into gramio's own update queue, returning `{ stop() }`. Every poll carries a deadline, its `timeout` (default 30 s) plus 15 s for the answer to arrive, covering the body too, so a connection that dies without a reset fails and the next poll goes out instead of leaving the bot deaf behind a pending request (gramio's own poll has none: gramiojs/gramio#35). Otherwise gramio's poll: the same `allowed_updates`, a registered webhook deleted on conflict, `retry_after` honoured; failures back off, doubling to a minute. `gracefulStart` and `createBot().poll()` start through it. |
| `@adriangalilea/bot/token-safe` | Keeps the bot token out of every log: it sits in every Bot API URL, and Bun hangs the request URL on each fetch error as `path`, so any error the runtime prints itself (a crash at start, gramio's default `console.error` handler, a `console.error(err)`) prints the token. `guardToken(bot)` turns every transport failure of a gramio call into a `SourcedError` (source `telegram`, the method, the transport's code and message, no URL anywhere in it) and logs every failed update through `utils/log` instead of gramio's default handler; Telegram's own refusals stay `TelegramError`. `telegramFailure(method, err)` is the same conversion for a fetch of your own (`downloadFile` bypasses the API hooks). `bot/poll` and `createBot` install the guard themselves, so their bots need nothing. |
| `@adriangalilea/bot/kit` | The Node-only corner, one function: `gracefulStart(bot, opts?)` — starts the bot through `bot/poll`; a start that fails (no network, a revoked token) is one logged `start failed` and exit 1 for the supervisor to restart, never a raw crash; SIGINT/SIGTERM → the poll stopped, `bot.stop()` → exit; force-kills if shutdown hangs; calls `bot.syncCommands()` on start. DMs the admin `@<bot> started.` / `@<bot> shutting down.` by default when `KEV.TELEGRAM_ADMIN_ID` is set (graceful only — crashes don't trigger `onStop`); pass `notifyAdmin: false` to disable or `notifyAdmin: 12345` for an explicit chat id. |
| `@adriangalilea/bot/admin` | `adminContext(admins)` — decorates `ctx.adminId` (the primary admin: the approve/deny and notification target) and `ctx.isAdmin` (any admin) on every event. Ids arrive POSITIONALLY as a number, an array, or a FUNCTION consulted per update, so a db-backed resolver changes who is admin with no restart. Reads no env and touches no OS, which is what keeps it Worker-safe; a Node bot composes env in at the call site (`adminContext(kev.int('TELEGRAM_ADMIN_ID', 123))`). `parseIdList("123, 456 789")` turns an env string into clean ids. `accessControl` and the payments refund flow declare a gramio dependency on this plugin, so gramio throws at `bot.start()` if you forget it. |
| `@adriangalilea/bot/session` | `botSession(opts)` — **drop-in replacement for `@gramio/session`'s `session()`** that auto-namespaces every key as `bot-<id>:<senderId>` using `ctx.bot.info.id` (populated by `getMe()` at startup). Use this instead of `session()` — full stop. Multiple bots sharing one Redis/D1 stay isolated by construction; every plugin in this package derives the same prefix internally via `botStorageKey(ctx, userId)` / `botSubKey(ctx, sub)` (from `bot/keys`). No regex, no manual prefix argument, no way to forget. Worker-safe. |
| `@adriangalilea/bot/notify` | Best-effort admin DMs, worker-safe (you pass the ids; no env, no process). `notifyAdmins(bot, adminIds, text, extra?)` — DM each admin, failures logged and swallowed (a notification must never take the bot down). `alertAdminError(bot, adminIds, label, error, throttle?)` — truncated `🚨 label\nName: message`, rate-limited through a caller-owned `alertThrottle(ms?)` so a failure storm sends one alert per window. `alertAdminOnErrors(bot, adminIds, { ms? })` — call once at startup: every error the process LOGS (`utils/log` `onLog`: an error line or a failed span), handled or not, reaches the admins as `🚨 service · scope: msg`, the error, the event's fields; one DM per distinct error per window (10 minutes by default), repeats counted and reported with the next DM, the module's own failed DMs skipped. `adminIds` is a list or an async resolver. `gracefulStart`'s start/stop DMs are built on this. |
| `@adriangalilea/bot/profile` | `syncBotProfile(bot, { name?, description?, about?, photo?, commands?, expects?, adminIds? })` — the bot's Telegram-facing identity as CODE, never BotFather: localized name / description / About / public command list, reconciled idempotently on every boot (get → compare → set per field per language; unchanged values cost one read, so cold-start firing is rate-limit-free). `expects: { inline: true }` declares the BotFather-only capabilities the code assumes — a mismatch (inline mode off on an inline-dependent bot) DMs the admins, since the API can only detect it, not fix it. Never throws; failures log and the bot keeps running. |
| `@adriangalilea/bot/access-control` | Personal-bot ACL — gates non-admin/non-default users; admin gets DM with `[✅ Aprobar][❌ Denegar]` on first attempt; `/access` opens a persistent menu (revoke / reapprove / list pending). Backed by `@gramio/session` per-user + a small index. **Native alternative**: BotFather → Bot Settings → Access → "Restrict bot usage" — flat allow-list at Telegram. Use this plugin when you want in-bot approval flow instead of a BotFather round-trip; both can coexist. |
| `@adriangalilea/bot/allow-list` | Static allow-list by **id and/or @username** — stateless, no session/storage. `allowList({ ids?, usernames? })` is a plugin that decorates `ctx.allowed` (boolean); gate in your handlers (`if (!ctx.allowed) return`). `makeAllowList(...)` is the pure framework-free predicate. The light counterpart to `access-control` (which adds an approve/deny flow + revocable store, needing session+storage). Username caveat: a `@username` is optional and mutable, and the Bot API can't resolve username→id ahead of time — prefer `ids` when known, `usernames` is the pragmatic fallback. |
| `@adriangalilea/bot/groups` | Group-chat identity as plain functions: `chatIdOf(ctx)` (the chat id on any ctx flavour), `isGroupChat(ctx)` / `isPrivateChat(ctx)`, and `isGroupAdmin(ctx, { chatId?, userId? }?)` — the `getChatMember` creator/administrator check behind every admin-gated group setting (auto-summary toggles, "dismiss" buttons on group welcomes), chat/user defaulted from the ctx. Every reader resolves both gramio spellings — message ctxs carry `chat`, callback ctxs (inline-button taps) only `chatId`/`message.chat` — so the same gate works in handlers and taps; read chat ids via `chatIdOf`, never `ctx.chat?.id`. Takes real gramio ctxs and `MenuCtx` with no cast; a miswired ctx panics, an API rejection fails closed (`false`). Composition over policy: bot-owner override stays at your call site (`ctx.isAdmin \|\| await isGroupAdmin(ctx)`). |
| `@adriangalilea/bot/language` (picker surface) | The language-picker vocabulary and surfaces, so bots don't fork label lists: `flagFor` / `autonym` / `languageLabel` ("🇪🇸 Español"), `languagePickerItem({ label, codes, isActive, pick })` (the 2-up primary-highlighted MenuItem factory — storage and policy live in your closures), and `addLanguageRows(kb, { codes, pack, active?, activeStyle? })` (the raw-InlineKeyboard twin for onboarding / group-welcome keyboards; `activeStyle: "success"` when primary already marks something else on the keyboard). |
| `@adriangalilea/bot/user` | `userLabel(u)` — the conditional "[name] [@username] [id]" line every bot re-rolls for admin DMs and logs: `Ada Lovelace (@ada · 42)` / `Ada (42)` / `@ada (42)` / `id 42`, missing pieces drop instead of padding. Reads both gramio spellings (`firstName` / `first_name`); plain text by design. |
| `@adriangalilea/bot/urls` | Telegram-message URL + entity parsing, on what the platform ALREADY parsed (entities carry exact UTF-16 spans — never `startsWith("/")` or a mention regex). `urlsInMessage(msg)` → the url module's `Url[]`: the visible text scanned by `urlsIn` PLUS `text_link` entities — hyperlinked words whose URL never appears in the text, invisible to any text scanner (what forwarded newsletters carry); a text_link's `raw` is its anchor words and its span covers them, so span-cutting treats linked words as the link. `isCommandMessage(msg)` (a `bot_command` entity at offset 0), `commandToken(msg)` (the leading command without any `@botname` suffix, `/summary@my_bot` → `/summary`; null for ordinary text), `commandAddressee(msg)` (the bot a command is explicitly addressed to, lowercased, null when bare — the group addressing gate: a bare command may belong to any bot in the room, one addressed elsewhere never concerns yours), `cutEntities(text, entities, shouldCut)` (exact span surgery; the predicate sees each visible slice), `messageTextAndEntities(msg)` (text or caption with ITS entity set). Framework-agnostic by shape: gramio's `MessageEntity` class and the raw Bot API object both fit. |
| `@adriangalilea/bot/announce` | The house announcement (news) template for bot mass messages, first-class: an `Announcement` = banner (`# 📰 <bot> News`), ordered sections (canonical `section.info/features/fixes` with 💬/✨/🐛, free-form allowed), italic closer, `· signature` (middle dot by design, never an em dash). `renderAnnouncement(a)` → the Telegram-markdown subset; `renderAnnouncementBodies({en, es, …})` → per-language bodies for a polyglot broadcast engine ("en" is the required fallback anchor). Pure, zero deps. |
| `@adriangalilea/bot/updates` | The pending-update queue of a webhook-less bot token, treated as the destroy-on-read resource it is (`getUpdates` with an offset CONFIRMS — destroys — everything below it). `updateQueue({ token, fetch?, apiRoot? })` → `peek({ limit? })` (webhook state + pending count + the queue head, verbatim; sends NO offset so nothing is ever confirmed — repeatable, zero risk), `count()`, `webhookInfo()`, and `drain({ onBatch, limit?, timeoutS?, quietPolls? })` — the one-chance-safe sweep: each raw batch is handed to `onBatch` (persist it somewhere durable) and AWAITED before the offset advances, because the next call is the confirmation; a crash re-delivers the unconfirmed tail on re-run, and the drain ends only after several consecutive silent long-polls, never on the first empty response. A 409 (webhook registered / competing poller) is a typed `SourcedError`, never a silent retry. Plain `fetch`, injectable for tests; no framework. |
| `@adriangalilea/bot/inline-feedback` | Behavioral tripwire for BotFather's inline feedback probability (gates `chosen_inline_result`; defaults 0%, silently resets on bot transfer and inline-mode toggling, invisible to `getMe`): served-but-never-chosen crosses a threshold → throttled admin DM naming the exact BotFather switch. Storage injected as three ops; never throws into the answer path. |
| `@adriangalilea/bot/coalesce` | Joins client-split inbound messages back into one. When a user pastes >4096 chars, Telegram clients fragment it into separate `message` updates with no marker. Middleware detects the burst and emits one combined event. |
| `@adriangalilea/bot/llm` | The Telegram side of an LLM chatbot; the model side is `@adriangalilea/llm`. **Output:** `streamChatReply(ctx, events, opts?)` consumes an `AsyncIterable<LlmStreamEvent>` and paints it with Telegram's native message-draft streaming (`sendMessageDraft` full-frame repaints, throttled ~1/s, keepalive under the ~30s draft TTL), then persists the finished markdown via `ctx.send`, entity-split across 4096 by `@gramio/split`. Reasoning models get a thinking phase — streams into the ephemeral draft and evaporates (`reasoning: 'preview'`, default), persists as an expandable blockquote (`'message'`), or never renders at all (`'hidden'`). Upstream `reset` (provider failover) repaints the draft from scratch. Drafts are private-chat-only (+ BotFather forum-topic mode); elsewhere the preview phase is skipped and only the final send happens. Returns `{ content, reasoning, toolCalls, usage, messages }`. The painter underneath is `@adriangalilea/bot/draft` (`createDraftPreview(ctx, { render, throttleMs? })`): dependency-light (no markdown machinery), for producers that push deltas or own their per-frame rendering (plain or rich-message frames) and persist path, with `streamForensics` (render-regression + reset warnings) built in and exported standalone. **History:** `llmHistory({...})` returns `.plugin` (decorates `ctx.llm` with `.add() / .get() / .clear() / .all() / .clearAll()`, per-(user, thread) OpenAI `ChatMessage` shape, persisted in the shared session record so the menu's 🗑 Forget wipes it automatically) AND `.menuItem` (drop-in "🗑 Delete this thread" for `botMenu` — wipes the LLM history AND calls `deleteForumTopic` so the Telegram thread + all its messages disappear from the chat; falls back to history-only clear when no `threadId` is present). |
| `@adriangalilea/bot/menu` | `botMenu({ command, description, items, privacy?, personalData?, adminContact })` — `/settings` command + InlineKeyboard router. Root view always renders a `🛡️ Privacy & data` submenu button that wraps the privacy policy link plus (if `personalData: { storage }`) 🗑 Forget + 📥 Export buttons. Items take `keepRow` (render on the same row as the next item — e.g. a two-per-row language picker) and `rootExtra` (render at the bottom of the root menu, below Privacy & data). `label` / `header` / `style` / `visible` resolvers may be **async** (read your db at render time — never cache render strings in the session); `parseMode: 'HTML'` renders the header formatted (you own escaping); `personalData.onForget(ctx, userId)` wipes YOUR tables inside the same try as the session delete, so Forget either forgets everything or reports failure. `toggleMenuItem({ id, read, write, label: { off, on }, toast? })` — convenience factory for boolean-toggle items with dynamic label + optional toast, storage-agnostic via `read`/`write` closures. |
| `@adriangalilea/bot/payments` | `botPayments({ session, storage, paysupport, paysupportHint?, legal, waiver, vip?, credits?, perks? })` — Telegram Stars monetization in one drop-in plugin. **Three axes, all optional:** `vip` (positional tier ladder — single rung in v1 is just `vip: [{...}]`, ladder is `vip: [{...}, {...}]`; ids are `vip.1`, `vip.2`, …), `credits` (consumable balance + top-up packs `credits.1`, `credits.2`, …), `perks` (orthogonal one-shot unlocks `perks.<key>`). **Surface:** `ctx.payments.atLeast('vip')` / `atLeast('vip.2')` (typed rank check), `ctx.payments.tier()` / `.tier.level()` / `.tier.label()`, `ctx.payments.credits.{balance, consume, tryConsume}` (throws `InsufficientCredits`), `ctx.payments.has(perkId)`, `await ctx.payments.require('vip', { feature? })` (gate that sends a localized upgrade prompt deep-linked to `/settings → 💎 VIP`), `await ctx.payments.invoice(productKey)` (threads Art. 103(m) TRLGDCU consent inline before `sendInvoice`). **Owns:** waiver consent flow (versioned text → forces re-consent on bump, snapshotted on every charge for audit), `/paysupport` slash command (Telegram ToS §6.5; `paysupportHint` overrides the where-to-manage-charges line when your menu isn't `/settings`), idempotent `successful_payment` fulfillment via `pay:idempotency:{chargeId}` sentinel, lazy subscription expiry (no cron needed), tier upgrade auto-cancel of the lower rung's renewal, and admin-DM refund approval (mirror of `accessControl`'s [✅ Aprobar][❌ Denegar] pattern). **Returns:** `{ plugin, menuItem, payouts, admin, onFulfilled, onRefunded }` — `menuItem` is the drop-in `💎 VIP` entry for `botMenu`; `admin.{listCharges, getCharge}` backs custom admin commands; `payouts.{record, list, export, exportForUsers}` is the Fragment payout ledger (you receive TON, log the EUR conversion, export time-windowed CSV/JSON for your gestor); `onFulfilled(productKey \| '*', handler)` / `onRefunded(...)` register fire-and-forget hooks (purchase applied / admin-approved refund — a revenue ledger writes on one, reverses on the other). **Stars-only by design** — Telegram ToS §6.2 forbids third-party payment providers for digital goods. Crypto Pay deferred (MiCA risk); Stripe-outside-Telegram is a future v2 channel. Full compliance memo (Spanish-autónomo seller-of-record analysis, Verifactu vs Crea y Crece, MiCA, Art. 103(m) waiver text, GDPR retention) in `src/payments/CLAUDE.md`. |
| `@adriangalilea/bot/create` | `createBot<S>({ token?, storage?, initial?, admins?, language?, menu?, access?, payments?, handlers?, worker? })` — the composer (see "One bot file, ideation → production" above). Returns `{ build, session, poll, isMain, fetch }`: `poll()` long-polls, `export default app` is a complete Worker, `app.session(ctx)` / the `handlers` callback's `session(ctx)` is the TYPED accessor for your `S` fields. Owns storage+session wiring; resolves storage per environment (D1 binding → `bot/storage-d1`; `BOT_PERSIST` path → sqlite, `redis://` → redis, lazily-imported optional peers; else announced-ephemeral memory) — or pass `storage: (env) => Storage` when the choice is env-dependent (e.g. a D1 binding not named `DB`). Boot NARRATES the composition (`session storage kind="memory (ephemeral …)"`, `features features=["language(en,es)","menu(/settings)"]`) so every implicit decision is visible where you're looking. Runnable demo: `pnpm --filter @adriangalilea/bot demo:bot`. |
| `@adriangalilea/bot/worker` | `botWorkerFetch(resolve)` — the Cloudflare Worker cap: secret-checked webhook (ack fast, work + storage flush ride `ctx.waitUntil`, errors DM admins throttled), `POST /setup` (webhook registration with handler-derived `allowed_updates` + a commit-narrating 🚀 deploy DM from the request body), `POST /deploy-started` (the 🛳 "what is shipping" DM — curl it from your deploy script on the still-live version, body `{sha, author, message, etaSeconds?}`), operator-authed `/pause` `/resume` `/webhook-status` (+ `statusExtra`), and a `routes` escape hatch tried before the built-ins. `afterUpdate(ctx.updateId, work)` hands off work the reply does not wait for (a cache warm-up): the update ends without it, so it never holds the conversation's next update or counts toward the durable runner's attempt bound, and the Worker stays alive until it settles (`afterWorkMs` on the runner). Structural bot type — no workers-types dependency. |
| `@adriangalilea/bot/flags` | `defineFlags(spec, { read, write? })` — feature flags declared ONCE in code, resolved LIVE from the bot's operator-config record (D1 json row, Redis hash — storage-agnostic, Worker-safe, zero deps). Each flag: `{ kind: 'bool'\|'number'\|'string', label, help?, default }`, where `default` is a scalar or a **tier map** `{ free, vip?, 'vip.N'? }` resolved off `ctx.payments.tier()` — "free users get this limit, premium users get that model" is one declaration, zero branching at the call site (ladder walks down: exact rung → lower rungs → `vip` → `free`). Read sites: `await flags.<key>(ctx)` — stored override wins over the code default, per-ctx reads coalesce into one config fetch. `flags.describe()` is the JSON schema admin panels render generically, so a new flag appears in every panel with zero panel edits; `flags.set(ctx, key, value)` writes a kind-checked live override (`null` clears it — RFC 7386 null-delete, matching SQLite `json_patch`); `flags.overrides(ctx)` lists what's overridden. Corrupt stored values scream (`SourcedError`); bad specs panic at construction. |
| `@adriangalilea/bot/storage-d1` | `d1Storage({ db, table? })` — `@gramio/storage` adapter over a D1 `session` table (schema in the module doc). `flush()` matters: the session plugin writes un-awaited and workerd freezes the isolate the instant `fetch()` returns — hand `flush` to `bot/worker` (automatic via `createBot`) so writes survive. |

Standard wiring:

```typescript
import { Bot } from 'gramio'
import { redisStorage } from '@gramio/storage-redis'
import { adminContext } from '@adriangalilea/bot/admin'
import { gracefulStart } from '@adriangalilea/bot/kit'
import { botSession } from '@adriangalilea/bot/session'
import { accessControl } from '@adriangalilea/bot/access-control'
import { createLlm } from '@adriangalilea/llm'
import { streamChatReply, llmHistory, toModelMessages } from '@adriangalilea/bot/llm'
import { kev } from '@adriangalilea/utils'

// Raw redis is fine — bot-id namespacing happens inside botSession +
// every plugin via ctx.bot.info.id. Multiple bots sharing this Redis
// stay isolated by construction. No manual prefix to remember.
const storage = redisStorage()
const userSession = botSession({ storage, key: 'session', initial: () => ({}) })
const chat = llmHistory({ session: userSession, maxTurns: 20, retentionDays: 7 })

// Any OpenAI-compatible endpoint: vllm-mlx, mlx-lm, llama.cpp, Together, Groq, OpenAI, …
// More entries = priority failover; a KV-shaped `health` store adds the circuit breaker.
const llm = createLlm({
  providers: [{ id: 'local', type: 'openai', baseUrl: process.env.LLM_URL!, apiKey: 'none', defaultModel: process.env.LLM_MODEL! }],
})

const bot = new Bot(process.env.BOT_TOKEN!)
  .extend(adminContext(kev.int('TELEGRAM_ADMIN_ID', 123456789)))   // or a live resolver
  .extend(userSession)
  .extend(accessControl({ session: userSession, storage, defaults: [] }))
  .extend(chat.plugin)
  .on('message', async (ctx) => {
    if (!ctx.access.allowed) return
    ctx.llm.add({ role: 'user', content: ctx.text ?? '' })

    // Draft-streamed reply: thinking phase previews + final entity-split send.
    const { content } = await streamChatReply(ctx, llm.stream({
      instructions: 'You are helpful.',
      messages: toModelMessages(ctx.llm.get()),
    }))
    ctx.llm.add({ role: 'assistant', content })
  })

await gracefulStart(bot)
```

Inside handlers, `ctx.access` is a typed discriminated union — `{ allowed: true, source: 'admin' | 'default' | 'store', record? }` or `{ allowed: false, reason }`. `ctx.adminId` and `ctx.isAdmin` are available on every event from `adminContext`.

For tests/demos without a second Telegram account, `simulateAccessRequest(bot, storage, adminId, fakeUser, msg)` injects a synthetic pending request so admin can exercise the approve/deny flow.

## Menu items — coloured buttons, refresh, toast-return, confirm

`MenuItem` supports four cooperating fields for richer UX. Each is opt-in:

```typescript
import { botMenu, toggleMenuItem } from '@adriangalilea/bot/menu'

const menu = botMenu({
  command: 'settings',
  description: 'Open settings',
  adminContact: '@yourhandle',
  personalData: { storage },
  items: [
    lang.menuItem,           // ← submenu, selected lang renders as a blue (primary) button
    chat.menuItem,           // ← red (danger) button with built-in "⚠️ Sure?" confirm step

    // Boolean toggle — dynamic label + automatic colour + auto-refresh + toast.
    toggleMenuItem({
      id: 'thinking',
      read: (ctx) => (ctx.session as { thinking?: boolean }).thinking ?? false,
      write: (ctx, v) => { (ctx.session as { thinking?: boolean }).thinking = v },
      label: {
        off: { en: '💭 Thinking: OFF', es: '💭 Razonamiento: OFF' },
        on:  { en: '💭 Thinking: ON',  es: '💭 Razonamiento: ON'  },
      },
      toast: {
        on:  { en: 'Thinking on.',  es: 'Razonamiento activado.'  },
        off: { en: 'Thinking off.', es: 'Razonamiento desactivado.' },
      },
    }),

    // Custom destructive action with an explicit confirm step. The
    // action only runs after the user taps Confirm in the overlay.
    {
      id: 'reset',
      label: { en: '💥 Reset everything', es: '💥 Resetear todo' },
      style: 'danger',
      confirm: {
        prompt: {
          en: '⚠️ Reset ALL your data?\n\nThis is irreversible.',
          es: '⚠️ ¿Resetear TODOS tus datos?\n\nNo se puede deshacer.',
        },
      },
      action: (ctx) => {
        ctx.session.somethingHeavy = undefined
        // Return the toast string — the menu plugin owns the single
        // answerCallbackQuery for the tap. Calling ctx.answer here
        // would be a double-answer and would break refresh.
        return { en: '✅ Reset.', es: '✅ Reseteado.' }
      },
    },
  ],
})
```

Field summary:

- `style: 'primary' | 'success' | 'danger'` (or `(ctx) => …` for state-dependent colouring) maps to Telegram's native [InlineKeyboardButton.style](https://core.telegram.org/bots/api#inlinekeyboardbutton). Use `style` instead of emoji markers (`●`/`○`) for active-selection signalling — same UX, native rendering.
- `refresh: true` re-renders the menu in place after `action` runs, so dynamic `label` / `style` resolvers reflect mutated state without the user re-opening `/settings`. `toggleMenuItem` enables this by default.
- `action` returns `void | string | Polyglot<string>`; the menu plugin sends a single `answerCallbackQuery` with that text. **Never call `ctx.answer(...)` from inside an action** — Telegram rejects the second answer, the action throws, and `refresh` never runs.
- `confirm: { prompt }` adds a one-step confirmation overlay before the action runs. Cancel returns to root. Use this for destructive actions instead of `ctx.answer({ show_alert: true })` — Telegram's alert UI doesn't compose with refresh / toast.
- `disabled` (a `(ctx) => boolean` predicate on action items) renders the button greyed-out and non-tappable (Bot API 10.3 DisabledButton — no callback ever fires). A disabled button can't explain itself: pair it with header/body copy saying why, and keep a guard in the action for clients predating the field. `radioMenuItem` exposes it per choice as `disabledWhen(ctx, value)`.

**Live state inside resolvers**: `label` / `style` / `header` / `visible` resolvers fire AFTER the action mutated the session, and they may be **async** — read your database (or `ctx.session.<field>`) directly at render time; never cache render strings into the session to satisfy a signature. `ctx.lang` from `bot/language` is a snapshot at event start and goes stale within the same callback; `ctx.say(...)` IS live and safe to use anywhere.

See [`CLAUDE.md`](https://github.com/adriangalilea/ts-utils/blob/main/packages/bot/CLAUDE.md) for storage layout, design decisions, and gotchas.

## License

MIT
