# `@adriangalilea/utils/bot/*` — GramIO plugins

Plugins for personal Telegram bots built on [GramIO](https://gramio.dev). Each
ships as a subpath of `@adriangalilea/utils`. Peer deps (`gramio`,
`@gramio/storage`, `@gramio/session`, `@gramio/format`, `marked`) are **all
optional** — install only what the subpaths you import need.

## What's here

| Subpath | What it does |
|---|---|
| `@adriangalilea/utils/bot/kit` | `gracefulStart(bot, opts?)` — SIGINT/SIGTERM → `bot.stop()` → exit; force-kills if shutdown hangs. `adminContext({ adminId? })` — reads `TELEGRAM_ADMIN_ID` from KEV (with optional hardcoded fallback), decorates `ctx.adminId` (number) and `ctx.isAdmin` (boolean). |
| `@adriangalilea/utils/bot/access-control` | `accessControl({ storage, defaults? })` — gates non-admin/non-default users; admin gets DM with `[✅ Aprobar][❌ Denegar]` on first attempt; persistent `/access` menu for revoke/reapprove/list. Plus `simulateAccessRequest()` for tests. |
| `@adriangalilea/utils/bot/coalesce` | `coalesceLongMessages({ minLeadingLength?, windowMs?, acrossUsers?, log? })` — joins client-split inbound messages back into one. When a user pastes >4096 chars, Telegram clients fragment it into separate `message` updates with no marker. This middleware detects the burst and emits one combined event with `ctx.text` set to the full string. Also exports `isCoalescent(prev, curr, opts)` as a pure utility for power users. |
| `@adriangalilea/utils/bot/llm-stream` | `llmStream()` — `ctx.startStream()` returns a `MarkdownStreamer`; debounced `editMessageText`, splits at 4000 chars on paragraph/line/word boundary, parses Markdown locally so malformed mid-stream markup degrades to plain text instead of failing the whole message. |

Implementation files are flat under `src/bot/` — `kit.ts`, `access-control.ts`,
`llm-stream.ts`, plus `index.ts` as a barrel for `@adriangalilea/utils/bot`.

## Standard wiring

```ts
import { Bot } from 'gramio'
import { redisStorage } from '@gramio/storage-redis'   // or sqlite/cloudflare/inMemory
import { adminContext, gracefulStart } from '@adriangalilea/utils/bot/kit'
import { accessControl } from '@adriangalilea/utils/bot/access-control'
import { llmStream } from '@adriangalilea/utils/bot/llm-stream'

const storage = redisStorage()           // ONE instance, shared across plugins

const bot = new Bot(process.env.BOT_TOKEN!)
  .extend(adminContext({ adminId: 190202471 }))     // 1. admin id (KEV with fallback)
  .extend(accessControl({ storage, defaults: [] })) // 2. gate (depends on adminContext)
  .extend(llmStream())                              // 3. ctx.startStream() in handlers
  .command('start', (ctx) => ctx.send(`source=${ctx.access.source ?? '-'}`))

await gracefulStart(bot)
```

Order matters: `accessControl` declares `adminContext` as a runtime dependency.
`bot.start()` will throw if the dep isn't present.

## Storage architecture (why it ended up like this)

The journey, kept here so we don't re-litigate:

1. **First attempt**: one big blob at a single key — `{ users: { [id]: AccessRecord } }`.
   Read+write the whole object on every update. Simple but wrong: data
   model doesn't follow the domain (each user's record belongs at the
   user's address, not in a shared object), and the hot-path writes
   the whole blob on every activity bump.

2. **Considered**: per-user keys (`access:user:<id>`) + an index, talking to
   raw `@gramio/storage` directly. Better data model, but loses the
   ergonomics of `ctx.access` auto-loaded/auto-persisted.

3. **Landed on**: each plugin extends its own internal `@gramio/session`,
   sharing the same `Storage` backend. Per-user records live at
   session-controlled keys. The plugin maintains a separate small
   index for listing.

   ```
   storage:
     access:<userId>   → AccessRecord     (the user's session, written by session proxy)
     ac:index          → { pending, approved, denied }   (just IDs)
   ```

   - **Hot path** (gate read): free — `ctx._accessSession` is loaded by
     session for the current user anyway.
   - **Activity bumps**: mutate `ctx._accessSession.lastActivityAt = …`,
     persists automatically via session's Proxy.
   - **Cross-user mutation** (admin approves Pepe): plugin writes
     directly to `storage.set('access:'+pepeId, …)`. Not a hack — it's
     our own module coordinating with itself, since *we* registered
     the session with `getSessionKey: ctx => 'access:'+ctx.senderId`.
   - **Listing for `/access` menu**: read `ac:index` (small JSON of IDs)
     → fan-out load the N records to display.

   `ctx.access` (consumer-facing) is a *computed* discriminated union —
   `{ allowed, source, record? } | { allowed: false, reason }` — derived
   from `_accessSession.status` plus admin/defaults checks. Consumers
   read `ctx.access.allowed`, never touch `_accessSession`.

### Multi-session pattern (extends to other plugins)

Future per-user-state plugins (`/settings` for language, `/notifications`,
etc.) follow the same shape: each one calls `session({ key, getSessionKey,
storage, initial })` internally with its own namespace. All sessions live in
the same backend (Redis/SQLite/etc) but at distinct key prefixes:

```
storage:
  access:<userId>       ← from accessControl
  settings:<userId>     ← from settings (future)
  scenes:<userId>       ← from @gramio/scenes (if used)
```

No collisions because each plugin owns its prefix. The user passes one
`storage` instance to each.

This was deliberately preferred over a single shared "user record" session:
plugins stay self-contained, schemas don't couple, you can drop one without
breaking the rest, and lazy-load granularity is per-concern (e.g. settings
only loaded when `/settings` is invoked).

## Per-plugin notes

### `kit.ts` — `adminContext` + `gracefulStart`

- **`adminContext` resolves admin id via** `kev.int('TELEGRAM_ADMIN_ID', opts.adminId ?? 0)`.
  KEV reads memory → process.env → .env (auto-discovered project root and
  monorepo root) → fallback. Cached after first read. KEV beats hardcoded
  when both are present — env can override without redeploy.
- **Why `decorate({ adminId })`** (not `derive`): static value, set once at
  startup, zero per-update cost.
- **Why `derive((ctx) => ({ isAdmin }))`**: needs `ctx.senderId`, which is
  per-update. Uses `'senderId' in ctx` so service events without a sender
  resolve to `false` cleanly without casts.
- **`gracefulStart` accepts `AnyBot`**: gramio's `Bot` is heavily
  generic-parameterized (`Bot<Errors, Derives, Macros>`). After several
  `.extend(...)` calls the type is huge but TS-invariant, so a function
  taking bare `Bot` won't accept it. `AnyBot = Bot<any, any, any>` covers
  all flavors.

### `access-control.ts`

- **Depends on `adminContext`** at runtime via `dependencies: ['@adriangalilea/utils/bot/admin']`.
  Throws on `bot.start()` if missing.
- **`AccessStatus = 'unknown' | 'pending' | 'approved' | 'denied'`**.
  `unknown` is the session's `initial` — meaning we've never seen this
  user. Detecting first-request = `rec.status === 'unknown'`.
- **Notification throttle**: re-attempts from the same pending/denied user
  re-notify the admin only once per `notifyThrottleMs` (default 6h).
- **DM-to-user requires the user's `chatId`** — captured on first request.
  Admin DMs require admin to have `/started` the bot at least once. If
  not, `bot.api.sendMessage({ chat_id: adminId, … })` fails; we log and
  continue (admin won't be notified, but the rest of the flow is fine).
- **Approve/Deny callbacks accept optional `v` (originating view)**:
  - From the original notification (no `v`) → `editText(...)` to confirm
  - From a list view (`v: 'pending'|'denied'`) → refresh that list
  - This is what makes `↩️ Reaprobar` from the Denegados list re-render
    the Denegados list (now shorter) instead of leaving a stray
    "✅ Aprobado" text.
- **`/access` menu hierarchy**: main view → list view (with per-row action
  buttons) → ⬅️ back. Cap of 20 entries per list view to keep
  `callback_data` payloads sane.
- **Index integrity**: `indexMove(storage, uid, from, to)` removes from
  `from` and adds to `to` (or removes from all when `from === 'any'`).
  If the process crashes between record-write and index-write, you get
  inconsistency (record says approved, index still has it in pending).
  For a personal bot scale this is essentially never an issue; if it
  ever bites, a "reconcile" pass over `ac:index` is straightforward.

### `coalesce.ts`

- **What it solves:** Telegram clients (tdesktop, iOS, web) split a
  single >4096-char message client-side into multiple `sendMessage`
  calls. The bot receives them as N separate `message` updates with
  no marker linking them. This middleware joins them back so handlers
  see one event.

- **Strict-honest detection.** ALL conditions must hold to coalesce.
  If any fails → fragments pass through as separate events:
  1. Same chat (always)
  2. Same user (default; override with `acrossUsers: true`)
  3. Leading fragment length ≥ `minLeadingLength` — a short first
     fragment is never the start of a real client split; we don't
     open a buffer for short messages
  4. Each subsequent fragment within `windowMs` of the previous

  Bias: false negatives > false positives. Silently merging
  unrelated messages produces bugs the bot user can't debug.

- **Default values are guesses, not measurements.** See
  `DEFAULT_MIN_LEADING_LENGTH` / `DEFAULT_WINDOW_MS` in
  `coalesce.ts`. The first real-world observation: a README of
  11206 chars pasted from macOS desktop client landed as
  `3978 + 3959 + 3269` — so the leading fragment threshold has to
  be ≤3978 to catch this case. Enable `log: true` in your bot to
  see the actual lengths your users trigger and adjust accordingly.

- **`isCoalescent(prev, curr, opts)` exported as a pure utility.**
  Power users plug it into their own logic instead of the
  middleware. Takes plain `CoalesceFragment` (`text`, `chatId`,
  `userId`, `dateMs`) — decoupled from gramio's context.

- **`ctx.text` reassignment via gramio's native setter.** gramio's
  `MessageContext` exposes `text` as a `get/set` accessor — we just
  `ctx.text = combined`. Each new update gets a fresh ctx, no leak
  between updates.

- **`ctx.entities` cleared on coalesced messages.** Per-fragment
  entities reference each fragment's own text; combining them
  naively gives wrong offsets. Plain-text consumers don't care;
  formatted-input consumers should disable this plugin.

- **Order matters.** Extend `coalesceLongMessages()` BEFORE
  `.command()` / `.on('message')`. Otherwise command handlers see
  the first fragment alone before the middleware can hold it.

- **In-memory buffer, no persistence.** Doesn't survive bot restart
  mid-burst. Fine for personal bots.

- **No max-wait cap.** If 100 fragments arrive back-to-back the
  buffer grows unbounded. Add a `maxLength` if needed for hostile
  users.

### `llm-stream.ts`

- **Markdown via `@gramio/format/markdown` (`markdownToFormattable`)** —
  parses locally to `MessageEntity[]`, never uses `parse_mode`. Telegram
  rejects an entire message on `parse_mode` parse errors; this approach
  silently degrades malformed markup to plain text mid-stream.
- **Debounce defaults to 800ms** — Telegram caps `editMessageText` near
  ~1/sec/chat in practice. Anything tighter eats rate-limit errors.
- **Hard length cap at 4000** (Telegram's limit is 4096; headroom for
  entity offset bookkeeping). On overflow the streamer freezes the
  current message at a paragraph/line/word boundary and starts a new
  one.
- **Concurrent appends serialized**: first send happens once via
  `firstSendPromise` so two `append("a")`/`append("b")` in the same
  tick don't both create a new message.
- **Errors handled silently for the common cases**:
  - `"message is not modified"` → ignore (identical content)
  - `"message to edit not found"` → reset `currentMessageId`, next chunk
    sends fresh
  - others → `dirty` stays true so the next debounce retries; logged via
    `opts.onError`.

## Testing

`tests/bot-integration.ts` is the canonical smoke-test. Sets up all four
plugins against the `@manyfacedrobot` bot. Run:

```bash
BOT_TOKEN=… pnpm tsx tests/bot-integration.ts
```

Commands provided by the test bot:

| Command | What it exercises |
|---|---|
| `/start` | adminContext + accessControl (shows `ctx.access.source`) |
| `/stream` | llmStream — fake LLM token generator yielding markdown |
| `/access` | The full admin menu |
| `/simulate` | `simulateAccessRequest` — fakes "another user just DMed", drops a real notification with working buttons in the admin chat. No second account needed for testing the approve/deny flow. |

`Ctrl-C` exercises `gracefulStart`: should print `[bot] shutdown clean`
and exit 0.

## Open / TODO

- **Bundle `bot/gdpr` + `bot/settings` + `bot/message-history` together**
  — these three are conceptually one feature set: per-user state +
  legal compliance + retention. Designing them in isolation produces
  awkward composition. Plan to ship as one PR/release after coalesce
  is locked in:
  - `bot/gdpr` — `/privacy` (default URL `https://telegram.org/privacy-tpa`,
    overridable), `/forget`, `/export`, consent gate. Knows the
    storage key patterns of our other plugins so cascade
    delete/export work out of the box. `extraSources` opt-in for
    custom plugins.
  - `bot/settings` — `/settings` menu with per-user language picker
    (extensible to other prefs). Storage at `settings:<userId>`.
    `ctx.settings.language` typed.
  - `bot/message-history` — opt-in ring buffer per user, with
    retention (days + max count). Storage at `history:<userId>`.
    Auto-deletes old entries; integrates with gdpr `/forget` and
    `/export`. Gives retrospective commands (reply with `/summary`)
    a real path that respects data minimization by default
    (only buffers if you explicitly extend it).
- **`bot/i18n`** — pairs with `settings`. Lookup
  `messages[ctx.settings.language ?? defaultLang][key]`. Could just
  consume `@gramio/i18n` if it covers our needs.
- **Lazy session for accessControl** — currently eager (`session({ lazy:
  false })`). Lazy would skip the storage read for events where we
  bypass via admin/defaults. Trade-off: `ctx._accessSession` becomes a
  Promise, requires `await` everywhere we touch it. Switch only if a
  real bot starts hitting storage perf.
- **CallbackData schema migrations** — adding required fields to
  `acApprove`/`acDeny`/etc. would break inline buttons that Telegram has
  cached in old chat history. Stick to "add optional fields at the end"
  per gramio's [callback-data migration guide](https://gramio.dev/triggers/callback-query.html#schema-migrations).
- **Reconcile pass for `ac:index`** — write a small helper that walks
  the index and verifies each id resolves to an `access:<id>` record
  with matching status; auto-removes orphans. Useful only if we ever
  see real index drift.

## Conventions

- **Spanish copy by default** — these are personal bots for a Spanish
  speaker. All user-facing strings (deny messages, admin menu labels,
  notification headers) are Spanish. `denyMessage` in `accessControl`
  is overridable per-bot if you want English/etc.
- **Emojis as button labels** — Telegram inline buttons have no color
  styling beyond the Pay button (green) and URL/switch buttons. Emoji
  prefix is the only way to make a button visually distinct. Stay
  consistent: ✅ approve, ❌ deny, ↩️ revoke/reaprobar, ⬅️ back, 🔄
  refresh, ✖️ close.
- **No `as unknown as`, no `as any`** — types either work via gramio's
  Plugin generics (`Plugin<{}, AcDerives>` declares what the plugin
  reads/writes on ctx) or via narrow targeted casts on storage values
  (`(await storage.get(key)) as AccessRecord | undefined`). Anything
  beyond that is a smell — fix the types.
