# ts-utils

TypeScript utilities - logger, currency, offensive programming, file operations, environment management, and more.

## Installation

```bash
pnpm add @adriangalilea/utils
```

## Usage

### Logger

Next.js-style logger with colored output and Unicode symbols:

```typescript
import { wait, error, warn, ready, info, success, event, trace, createLogger } from '@adriangalilea/utils'

// Basic logging
wait('Loading...')
error('Something went wrong')
warn('This is a warning')
ready('Server is ready')
info('Information message')
success('Operation successful')
event('Event occurred')
trace('Trace message')

// Warn once (won't repeat same message)
warnOnce('This warning appears only once')

// Timer functionality
time('operation')
// ... do something
timeEnd('operation') // outputs: operation: 123ms

// Create prefixed logger
const apiLogger = createLogger('API')
apiLogger.info('Request received')  // [API] Request received
```

### Currency

Currency utilities with comprehensive crypto support (500+ symbols):

```typescript
import { currency, isCrypto, isStablecoin, isFiat, getSymbol, getOptimalDecimals } from '@adriangalilea/utils'

// Check currency types
isCrypto('BTC')  // true
isCrypto('XBT')  // true (alternative for BTC)
isCrypto('WBTC')  // true (wrapped tokens detected)
isStablecoin('USDT')  // true
isFiat('USD')  // true

// Get currency symbols
getSymbol('BTC')  // '₿'
getSymbol('ETH')  // 'Ξ'
getSymbol('USD')  // '$'

// Get optimal decimal places based on value
getOptimalDecimals(0.00001234, 'BTC')  // 10
getOptimalDecimals(1234.56, 'USD')  // 2
getOptimalDecimals(0.123, 'ETH')  // 6

// Percentage calculations
currency.percentageOf(25, 100)  // 25
currency.percentageChange(100, 150)  // 50
currency.percentageDiff(100, 150)  // 40

// Basis points
currency.basisPointsToPercent(100)  // 1
currency.percentToBasisPoints(1)  // 100
currency.formatBasisPoints(50)  // "50 bps"
```

### Format

Pure number formatting — named exports, tree-shakeable, zero currency baggage
(money formatting lives in the currency module, which owns the symbol/decimals
knowledge and its crypto-symbol dataset):

```typescript
import { compact, percentage, withCommas } from '@adriangalilea/utils/format'

withCommas(1234567)     // "1,234,567"
withCommas(1234.567, 2) // "1,234.57"
compact(1234567)        // "1.2M"
compact(1234)           // "1.2K"
percentage(12.3456)     // "12.3%"
percentage(0.05)        // "0.05%"
percentage(123.456)     // "123%"

// Money — from currency, not format:
import { usd, btc, money } from '@adriangalilea/utils/currency'
usd(1234.56)        // "$1234.56"
btc(0.00001234)     // "0.00001234 ₿"
money(100, 'EUR')   // "€100.00"
```

### CLI presentation (`cli`)

Terminal output: aligned tables, key/value blocks, trees, and a semantic color
palette. Distinct from `format` (universal value formatting) — this is
terminal-scoped. Colors come from the logger and auto-disable on non-TTY /
`NO_COLOR`, and alignment is **ANSI-aware** (padding uses visible width), so a
`table()` renders colored in a terminal and as plain aligned text in a pipe, log
file, or a bot's monospace block.

```typescript
import { table, kv, tree, indent, clip, ui } from '@adriangalilea/utils/cli'

// Semantic palette — use these, not raw colors, so intent stays consistent
ui.head('Name')   ui.accent('id')   ui.muted('note')
ui.ok('done')     ui.warn('!')      ui.bad('err')   ui.ref('#abc123')

// Aligned columns (auto width; per-column align; optional bolded header).
// Cells may be pre-colored — widths use visible length so they still line up.
table(
  [['Ada', ui.accent('ada@x.com'), ui.ref('42')],
   ['Bo',  ui.accent('bo@y.com'),  ui.ref('7')]],
  { head: ['name', 'email', 'msgs'], align: ['l', 'l', 'r'] },
)

// Key/value block (aligned keys) — for a detail view
kv([['name', 'Ada'], ['email', 'ada@x.com']], { indent: 2 })

// Nesting
tree('Ada', ['email: ada@x.com', 'phone: +1…'])   // labeled node + children
indent(block, 4)                                    // indent every line
clip('a very long value', 10)                       // "a very lo…" (ANSI-aware — styled input stays styled)
```

Run the demo: `FORCE_COLOR=1 pnpm tsx tests/cli-demo.ts`.

### Live output (`cli`) — pinned region, spinner, progress

A pinned, self-repainting region at the bottom of the terminal for progress UIs. You own the state; the region is a `render: () => string` repainted on a timer — a frame is just a string, so `table()` / `kv()` / `ui` and the widgets (`spin()`, `bar()`, `elapsed()`) compose inside it unchanged.

```typescript
import { live, spinner, spin, bar, elapsed, table, ui } from '@adriangalilea/utils/cli'

// The one-liner: animated while fn runs, persists "✓ label 1.2s" when done
await spinner('connecting to imap.gmail.com', () => adapter.connect())

// The general region: declarative multi-line progress
const region = live(() => table(accounts.map(a => [
  a.done === a.total ? ui.ok('✓') : spin(),
  a.alias,
  bar(a.done, a.total, 18),
  ui.muted(`${a.rate}/s`),
])))
// ...mutate your state; it repaints ~12.5fps (region.refresh() for instant)
region.done()   // final frame persists into scrollback (or .clear() to remove)
```

Patterns:

```typescript
// Relabel a spinner mid-flight — fn receives a setter
await spinner('connecting 0/4', async (set) => {
  for (const [i, a] of accounts.entries()) { await a.connect(); set(`connecting ${i + 1}/4`) }
})

// Streaming table — rows appear as they arrive, columns re-align retroactively
const rows: string[][] = []
const region = live(() => table(rows, { head: ['day', 'author', 'title'] }))
for await (const e of feed) { rows.push(renderRow(e)); region.refresh() }
region.done()   // full aligned table persists (a pipe gets exactly this, once)

// State-dependent bar color — style hook on the filled part
bar(done, total, 18, ui.warn)   // amber: throttled/cooling
```

What makes it hold up:

- **Logging never tears the UI, with no API to learn.** While a region is active, `console.log/warn/error` — and therefore the logger — are rerouted to print *above* the region (erase → write → repaint). Keep logging from anywhere, including third-party code. Boundary: only `console.*` is patched — a library writing raw to `process.stdout.write` bypasses the routing and can tear.
- **Non-TTY degrades to sane output.** In a pipe / CI / log file nothing animates: `done()` prints the final frame once, `spinner()` prints just its `✓ label 1.2s` line. Same calling code. Opt-in `heartbeat: ms` prints plain snapshots so long CI runs aren't silent.
- **Renders to stderr by default** — stdout stays clean for `--json` and pipes.
- **Crash-safe cursor**: hidden while painting, restored on done/clear, process exit, and signals — politely (if the app has its own SIGINT handler for graceful shutdown, it stays in charge).
- **Flicker-free**: synchronized-update escapes (`?2026`) make repaints atomic on modern terminals; lines are ANSI-aware clipped to the terminal width so the erase math never breaks.
- **Measurement is grapheme-aware**: a ZWJ emoji / flag counts as one visible unit in `width()`/`clip()`/`table()` alignment. East-Asian double-width (CJK) is a known TODO — those columns can drift a cell.
- One **region** at a time, by design (`assert`): two pinned regions can't share the bottom of one screen — compose into a single `render()`. A `spinner()` started *under* an active region is legitimate composition and degrades gracefully: its final line prints above the region.

Run the demo: `pnpm tsx tests/live-demo.ts` (and pipe it through `| cat` to see the non-TTY degradation).

### Offensive Programming

Fail loud, fail fast. Zero dependencies, works in Node, Deno, Bun, and browsers.

Two kinds of errors, kept separate: **`Panic`** (bugs in us — crash the process) and **`SourcedError`** (boundary failures — handle per-source).

```typescript
import { assert, panic, assertNever, must, unwrap, Panic, SourcedError, isSourcedError } from '@adriangalilea/utils'

// Assert invariants — narrows types via `asserts condition`
assert(port > 0 && port < 65536, 'invalid port:', port)

// Impossible state
switch (state) {
  case 'ready': handleReady(); break
  default: panic('impossible state:', state)
}

// Exhaustiveness check — TS compile error if you miss a case
type Event = { kind: 'click' } | { kind: 'hover' } | { kind: 'scroll' }
function handle(e: Event) {
  switch (e.kind) {
    case 'click': return handleClick()
    case 'hover': return handleHover()
    // forgot 'scroll' → TS error: Argument of type '{ kind: "scroll" }' not assignable to 'never'
    default: return assertNever(e)
  }
}
// Add a new variant to Event → every assertNever site lights up at compile time.

// Unwrap operations that shouldn't fail (sync + async)
const data = must(() => JSON.parse(staticJsonString))
const file = must(() => readFileSync(path))
const resp = await must(() => fetch(url))

// Unwrap nullable values — T | null | undefined → T in one expression
const user = unwrap(db.findUser(id), 'user not found:', id)
const el = unwrap(document.getElementById('app'))
```

#### Typed boundary errors — `SourcedError`

Every external system call should wear its source. When it fails, carry forensics:

```typescript
import { SourcedError, isSourcedError, Panic } from '@adriangalilea/utils'

try {
  return await stripe.charges.create({ customer, amount })
} catch (e) {
  throw new SourcedError({
    source: 'stripe',
    operation: 'charge_customer',
    message: e instanceof Error ? e.message : String(e),
    status: (e as any)?.statusCode,
    cause: e,
    context: { customer, amount },
  })
}

// At catch boundaries — keep Panics and SourcedErrors separate:
try { await doWork() }
catch (e) {
  if (e instanceof Panic) throw e                            // bug in us — crash
  if (isSourcedError(e, 'stripe') && e.status === 402) {
    // TS knows e.source === 'stripe' here (generic narrows)
    return { error: 'card declined' }
  }
  if (isSourcedError(e)) {
    logger.error(`[${e.source}:${e.operation}]`, e.toJSON())  // structured forensics
    throw e
  }
  throw e                                                     // unknown — re-throw
}
```

Every `SourcedError` carries `source`, `operation`, `status`, `context`, and the original exception via `cause`. Call `.toJSON()` for serialization across process boundaries.

## Features

- **Logger**: Next.js-style colored console output with symbols
- **Currency**:
  - 13,750+ crypto symbols from CoinGecko (auto-updatable)
  - Alternative ticker support (XBT→BTC, wrapped tokens, etc.)
  - Optimal decimal calculations
  - Percentage and basis point utilities
  - Fiat and stablecoin detection
- **Format**: Number and currency formatting with compact notation
- **CLI**: ANSI-aware tables/kv/trees + semantic palette, and live output — pinned self-repainting region, spinner, progress bar, with logs flowing above and clean non-TTY degradation
- **Offensive Programming**: assert, panic, assertNever, must, unwrap (throw `Panic`) + SourcedError for typed boundary failures
- **File Operations**: Read, write with automatic path resolution
- **Directory Operations**: Create, list, walk directories
- **KEV**: Redis-style environment variable management with monorepo support
- **XDG**: XDG Base Directory paths — reads env vars set by [xdg-dirs](https://github.com/adriangalilea/xdg-dirs), falls back to spec defaults
- **Unseen**: Persistent dedup filter — "what's new since last time?" for cron/monitoring workflows
- **Project Discovery**: Find project/monorepo roots, detect JS/TS projects
- **Bot plugins (GramIO)**: `kit` (graceful shutdown + admin context), `access-control` (gate + approve/deny menu, backed by sessions), `llm` (OpenAI-compat SSE parser `streamChat` + Telegram streaming output `ctx.startStream` + per-thread conversation history `ctx.llm`), `payments` (Telegram Stars: VIP tiers + credits + perks + waiver + refund flow, ToS-compliant, Spanish-autónomo-aware), `coalesce`, `language`, `menu`

### XDG Base Directories

XDG paths that respect env vars from [xdg-dirs](https://github.com/adriangalilea/xdg-dirs) with spec-compliant fallbacks:

```typescript
import { xdg, dir } from '@adriangalilea/utils'

xdg.state('notify')                    // ~/.local/state/notify
xdg.state('notify', 'watchers.json')   // ~/.local/state/notify/watchers.json
xdg.config('myapp')                    // ~/.config/myapp
xdg.data('myapp')                      // ~/.local/share/myapp
xdg.cache('myapp')                     // ~/.cache/myapp
xdg.runtime('myapp')                   // $XDG_RUNTIME_DIR/myapp

// Ensure the directory exists before writing
dir.create(xdg.state('notify'))
```

### Unseen

"What's new since last time?" — filters an array of objects to only the ones you haven't seen before. Remembers across runs.

```typescript
import { unseen } from '@adriangalilea/utils'

const messages = await fetchMessages()
const newMessages = await unseen('messages', messages, 'id')
```

1st run:
```
messages    = [{ id: '1', from: 'alice', text: 'hi' }]
newMessages = [{ id: '1', from: 'alice', text: 'hi' }]
```

2nd run, no new message:
```
newMessages = []
```

3rd run, bob replied:
```
messages    = [{ id: '1', ... }, { id: '2', from: 'bob', text: 'hey' }]
newMessages = [{ id: '2', from: 'bob', text: 'hey' }]
```

Saves state to: `$XDG_STATE_HOME/unseen/{name}.json`

### Polyglot strings (`say`)

A typed multi-language string is just an object literal `{ en, es, … }` — the keys are the source of truth, the TS compiler enforces completeness, there's no JSON file / extraction tool / registry.

```typescript
import { say, type Polyglot } from '@adriangalilea/utils/say'

say({ en: 'Hello', es: 'Hola' }, 'es')       // → 'Hola'
say({ en: 'Hello', es: 'Hola' }, 'fr')       // TS error: '"fr"' not in '"en" | "es"'

// parametric — closures, no wrapper:
const greeting = (name: string) => ({ en: `Hi ${name}`, es: `Hola ${name}` })
say(greeting('Adrian'), 'es')                 // → 'Hola Adrian'

// type your own adapter:
const notify = (msg: Polyglot<'en' | 'es'>, lang: 'en' | 'es') =>
  transport.send(say(msg, lang))
```

In a bot, `bot/language` adds `ctx.lang` + `ctx.say`. Both resolve stored explicit pick → Telegram client hint → configured default, at READ time — the hint is never persisted, and `session.language` is written only by an explicit pick (the plugin's menuItem action):

```typescript
ctx.say({ en: 'Continue', es: 'Continuar' })       // → string
await ctx.say.send({ en: 'Hi', es: 'Hola' })       // → ctx.send(resolved)
await ctx.say.edit({ en: 'Done', es: 'Listo' })    // → ctx.editText (callback only)
await ctx.say.answer({ en: 'OK', es: 'OK' })       // → ctx.answer (callback only)
```

### Telegram HTML (`tg-html`)

Transform arbitrary (LLM-emitted) HTML into Telegram-compatible `parse_mode=HTML` with opinionated, consistent spacing. Telegram's HTML subset has no headings, lists, or block layout — send it `<h1>`/`<ul>` and the API rejects the whole message. `transform()` accepts the HTML a model naturally writes and renders the structure typographically: `h1` → bold+underline + blank line, `h2…h6` → bold + blank line, `ul/li` → `• ` bullets, blocks get blank lines, blockquotes keep their internal line breaks, allowed tags pass through with attributes filtered, unknown tags drop their markup (content kept), and stray `<`/`>` escape instead of vanishing. Zero dependencies, no DOM, Worker-safe. Successor of the standalone `tghtml` package (jsr, archived).

```typescript
import { transform } from '@adriangalilea/utils/tg-html'

transform('<h1>Title</h1><ul><li>Point one</li><li>Point two</li></ul>')
// '<b><u>Title</u></b>\n\n• Point one\n• Point two'
```

### Telegram bot plugins (GramIO)

Plugins for personal Telegram bots built on [GramIO](https://gramio.dev). Each plugin lives at its own subpath; peer deps (`gramio`, `@gramio/storage`, `@gramio/session`, `@gramio/format`, `marked`) are **all optional** — install only what you import.

```bash
pnpm add @adriangalilea/utils gramio @gramio/storage @gramio/session
```

#### One bot file, ideation → production (`bot/create`)

`createBot` is the composer: it constructs the storage + session pair ONCE and threads it into every feature, so "must be the SAME instance you passed to session()" is unrepresentable instead of a doc warning. The same file runs in every stage — **storage and transport are environment decisions, never code shape**:

| stage | run | session | transport |
|---|---|---|---|
| ideation | `BOT_TOKEN=… tsx bot.ts` | memory (ephemeral, announced) | long-poll |
| experiment | `BOT_PERSIST=./bot.sqlite tsx bot.ts` | sqlite | long-poll |
| prod · your own hardware | systemd/launchd unit running the same command | sqlite / `BOT_PERSIST=redis://…` | long-poll (a legitimate prod mode: dials out, no inbound port/TLS) |
| prod · Cloudflare Worker | `wrangler deploy` (D1 binding `DB`) | D1 (`bot/storage-d1`) | webhook (`bot/worker`) |
| prod · Node/Bun server | webhook behind your HTTP server | sqlite/redis | fetch-shaped handler |

```typescript
import { createBot } from '@adriangalilea/utils/bot/create'

const app = createBot({
  admins: 190202471,
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

Cloudflare is one adapter, not the architecture: `bot/worker` and `bot/storage-d1` are the workerd cap (~each 100 lines, both optional); `bot/kit`'s `gracefulStart` is the Node twin (signals + start/stop DMs) and stays the one deliberately Node-only corner. The worker-safe tripwire (`pnpm test:worker-safe`) guarantees the core never grows a Node dependency.

#### Design rules the bot plugins hold to (each learned the hard way)

- **Resolution is read-time.** Language resolves stored pick → live Telegram hint → default on every surface (`ctx.lang`, `ctx.say`, menu chrome, picker highlight). Inferred values are NEVER persisted — a user who switches their client language moves with it until they pick.
- **Only explicit user signals are stored.** The session holds picks, consent, state the user created — never derived values, never render caches. If a sync signature ever tempts you to cache a rendered string into the session, the signature is the bug (menu resolvers are async for exactly this reason).
- **Derives cover every event the user can speak through** — message, callback, AND inline. A feature that skips inline forces consumers to fork shadow helpers that read the session directly; those forks then read as design.
- **Forget actually forgets.** `personalData.onForget` runs inside the same try as the session delete: your message logs/metrics/credit rows get wiped too, or the user is told it failed — never a partial erasure reading as success.
- **The composer owns instance wiring.** Features still compose manually (below) when you need full control, but every "same instance" contract has one home.

#### Threaded Mode — pin the `@gramio/contexts` fork

Telegram added [Threaded Mode](https://telegram.org/blog/threaded-conversations) for private chats (BotFather → Bot Settings → Threaded Mode). gramio's `SendMixin` skips auto-threading there, and `CallbackQueryContext` doesn't expose `threadId` at all. Fixes [PR'd upstream](https://github.com/gramiojs/contexts/pull/4); until merged, pin the fork in **your bot project's** workspace root (pnpm only honors overrides at the root, not transitively — and pnpm ≥11 reads them from `pnpm-workspace.yaml`, not `package.json`):

```yaml
# pnpm-workspace.yaml
overrides:
  "@gramio/contexts": "github:adriangalilea/contexts#local-build/auto-thread-private-chat-threaded-mode"
```

Then `pnpm install`. Every `ctx.send` / `ctx.sendDocument` / `ctx.reply` / etc. — including from callback handlers — will auto-forward `message_thread_id` and stay in the thread the message came from. If you don't use Threaded Mode, skip this.

**Runs on Cloudflare Workers / bun / anywhere.** Every bot subpath below is import-safe off Node — no filesystem access, no `node:*` modules, no import-time side effects anywhere in its graph — **except `bot/kit`**, which deliberately owns the Node-only pieces (process signal handling in `gracefulStart`, kev-backed env reading in `adminContext`). `pnpm test:worker-safe` walks every graph and screams on regression.

| Subpath | What it does |
|---|---|
| `@adriangalilea/utils/bot/ctx` | Structural ctx types (`BotMessageCtx`, `BotCallbackCtx`, …) and the `narrow<T>(ctx)` cast helper. Pure typing — no runtime state. |
| `@adriangalilea/utils/bot/keys` | The bot-id key namespace, a **persisted contract**: `botId(ctx)`, `botStorageKey(ctx, userId)` → `bot-<id>:<userId>`, `botSubKey(ctx, sub)` → `bot-<id>:<sub>`. Every storage key the library writes derives from here, and those keys live in YOUR Redis/D1 rows — the shape never changes. Pure functions of `ctx.bot.info.id` (no env/fs), which is what keeps the whole bot surface Worker-safe. |
| `@adriangalilea/utils/bot/kit` | The Node-only corner. `gracefulStart(bot, opts?)` — SIGINT/SIGTERM → `bot.stop()` → exit; force-kills if shutdown hangs. DMs the admin `@<bot> started.` / `@<bot> shutting down.` by default when `KEV.TELEGRAM_ADMIN_ID` is set (graceful only — crashes don't trigger `onStop`); pass `notifyAdmin: false` to disable or `notifyAdmin: 12345` for an explicit chat id.<br>`adminContext({ adminId? })` — reads `TELEGRAM_ADMIN_ID` from `kev` (with optional hardcoded fallback), decorates `ctx.adminId` + `ctx.isAdmin`.<br>Also re-exports `botSession` / `prefixStorage` from `bot/session` so Node consumers keep one import. |
| `@adriangalilea/utils/bot/session` | `botSession(opts)` — **drop-in replacement for `@gramio/session`'s `session()`** that auto-namespaces every key as `bot-<id>:<senderId>` using `ctx.bot.info.id` (populated by `getMe()` at startup). Use this instead of `session()` — full stop. Multiple bots sharing one Redis/D1 stay isolated by construction; every plugin in this package derives the same prefix internally via `botStorageKey(ctx, userId)` / `botSubKey(ctx, sub)` (from `bot/keys`). No regex, no manual prefix argument, no way to forget.<br>`prefixStorage(storage, prefix)` — escape hatch for adding a top-level prefix on top of the bot-id namespace; almost never needed. Worker-safe. |
| `@adriangalilea/utils/bot/notify` | Best-effort admin DMs, worker-safe (you pass the ids; no env, no process). `notifyAdmins(bot, adminIds, text, extra?)` — DM each admin, failures logged and swallowed (a notification must never take the bot down). `alertAdminError(bot, adminIds, label, error, throttle?)` — truncated `🚨 label\nName: message`, rate-limited through a caller-owned `alertThrottle(ms?)` so a failure storm sends one alert per window. `gracefulStart`'s start/stop DMs are built on this. |
| `@adriangalilea/utils/bot/profile` | `syncBotProfile(bot, { name?, description?, about?, photo?, commands?, expects?, adminIds? })` — the bot's Telegram-facing identity as CODE, never BotFather: localized name / description / About / public command list, reconciled idempotently on every boot (get → compare → set per field per language; unchanged values cost one read, so cold-start firing is rate-limit-free). `expects: { inline: true }` declares the BotFather-only capabilities the code assumes — a mismatch (inline mode off on an inline-dependent bot) DMs the admins, since the API can only detect it, not fix it. Never throws; failures log and the bot keeps running. |
| `@adriangalilea/utils/bot/access-control` | Personal-bot ACL — gates non-admin/non-default users; admin gets DM with `[✅ Aprobar][❌ Denegar]` on first attempt; `/access` opens a persistent menu (revoke / reapprove / list pending). Backed by `@gramio/session` per-user + a small index. **Native alternative**: BotFather → Bot Settings → Access → "Restrict bot usage" — flat allow-list at Telegram. Use this plugin when you want in-bot approval flow instead of a BotFather round-trip; both can coexist. |
| `@adriangalilea/utils/bot/allow-list` | Static allow-list by **id and/or @username** — stateless, no session/storage. `allowList({ ids?, usernames? })` is a plugin that decorates `ctx.allowed` (boolean); gate in your handlers (`if (!ctx.allowed) return`). `makeAllowList(...)` is the pure framework-free predicate. The light counterpart to `access-control` (which adds an approve/deny flow + revocable store, needing session+storage). Username caveat: a `@username` is optional and mutable, and the Bot API can't resolve username→id ahead of time — prefer `ids` when known, `usernames` is the pragmatic fallback. |
| `@adriangalilea/utils/bot/coalesce` | Joins client-split inbound messages back into one. When a user pastes >4096 chars, Telegram clients fragment it into separate `message` updates with no marker. Middleware detects the burst and emits one combined event. |
| `@adriangalilea/utils/bot/llm` | The full LLM-chatbot pipeline in one module. **Input:** `streamChat(response)` parses OpenAI-compatible SSE (OpenAI, vllm, mlx-lm, llama.cpp, Together, Groq, …) into a typed `AsyncGenerator<{type: 'content' \| 'reasoning', text}>`. **Output:** `ctx.startStream()` (low-level: debounced markdown to Telegram, 4000-char split, exposes `wasPartial` after `.end()`). `ctx.startChatStream(response)` (high-level: consumes the stream, renders reasoning as a Telegram `expandable_blockquote` entity + content as streamed markdown — both go through `markdownToFormattable` with graceful degradation — returns `{ content, reasoning }`). **History:** `llmHistory({...})` returns `.plugin` (decorates `ctx.llm` with `.add() / .get() / .clear() / .all() / .clearAll()`, per-(user, thread) OpenAI `ChatMessage` shape, persisted in the shared session record so the menu's 🗑 Forget wipes it automatically) AND `.menuItem` (drop-in "🗑 Delete this thread" for `botMenu` — wipes the LLM history AND calls `deleteForumTopic` so the Telegram thread + all its messages disappear from the chat; falls back to Redis-only clear when no `threadId` is present). |
| `@adriangalilea/utils/bot/menu` | `botMenu({ command, description, items, privacy?, personalData?, adminContact })` — `/settings` command + InlineKeyboard router. Root view always renders a `🛡️ Privacy & data` submenu button that wraps the privacy policy link plus (if `personalData: { storage }`) 🗑 Forget + 📥 Export buttons. Items take `keepRow` (render on the same row as the next item — e.g. a two-per-row language picker) and `rootExtra` (render at the bottom of the root menu, below Privacy & data). `label` / `header` / `style` / `visible` resolvers may be **async** (read your db at render time — never cache render strings in the session); `parseMode: 'HTML'` renders the header formatted (you own escaping); `personalData.onForget(ctx, userId)` wipes YOUR tables inside the same try as the session delete, so Forget either forgets everything or reports failure. `toggleMenuItem({ id, read, write, label: { off, on }, toast? })` — convenience factory for boolean-toggle items with dynamic label + optional toast, storage-agnostic via `read`/`write` closures. |
| `@adriangalilea/utils/bot/payments` | `botPayments({ session, storage, paysupport, paysupportHint?, legal, waiver, vip?, credits?, perks? })` — Telegram Stars monetization in one drop-in plugin. **Three axes, all optional:** `vip` (positional tier ladder — single rung in v1 is just `vip: [{...}]`, ladder is `vip: [{...}, {...}]`; ids are `vip.1`, `vip.2`, …), `credits` (consumable balance + top-up packs `credits.1`, `credits.2`, …), `perks` (orthogonal one-shot unlocks `perks.<key>`). **Surface:** `ctx.payments.atLeast('vip')` / `atLeast('vip.2')` (typed rank check), `ctx.payments.tier()` / `.tier.level()` / `.tier.label()`, `ctx.payments.credits.{balance, consume, tryConsume}` (throws `InsufficientCredits`), `ctx.payments.has(perkId)`, `await ctx.payments.require('vip', { feature? })` (gate that sends a localized upgrade prompt deep-linked to `/settings → 💎 VIP`), `await ctx.payments.invoice(productKey)` (threads Art. 103(m) TRLGDCU consent inline before `sendInvoice`). **Owns:** waiver consent flow (versioned text → forces re-consent on bump, snapshotted on every charge for audit), `/paysupport` slash command (Telegram ToS §6.5; `paysupportHint` overrides the where-to-manage-charges line when your menu isn't `/settings`), idempotent `successful_payment` fulfillment via `pay:idempotency:{chargeId}` sentinel, lazy subscription expiry (no cron needed), tier upgrade auto-cancel of the lower rung's renewal, and admin-DM refund approval (mirror of `accessControl`'s [✅ Aprobar][❌ Denegar] pattern). **Returns:** `{ plugin, menuItem, payouts, onFulfilled }` — `menuItem` is the drop-in `💎 VIP` entry for `botMenu`; `payouts.{record, list, export, exportForUsers}` is the Fragment payout ledger (you receive TON, log the EUR conversion, export time-windowed CSV/JSON for your gestor); `onFulfilled(productKey \| '*', handler)` / `onRefunded(...)` register fire-and-forget hooks (purchase applied / admin-approved refund — a revenue ledger writes on one, reverses on the other). **Stars-only by design** — Telegram ToS §6.2 forbids third-party payment providers for digital goods. Crypto Pay deferred (MiCA risk); Stripe-outside-Telegram is a future v2 channel. Full compliance memo (Spanish-autónomo seller-of-record analysis, Verifactu vs Crea y Crece, MiCA, Art. 103(m) waiver text, GDPR retention) in `src/bot/payments/CLAUDE.md`. |
| `@adriangalilea/utils/bot/create` | `createBot<S>({ token?, storage?, initial?, admins?, language?, menu?, access?, payments?, handlers?, worker? })` — the composer (see "One bot file, ideation → production" above). Returns `{ build, session, poll, isMain, fetch }`: `poll()` long-polls, `export default app` is a complete Worker, `app.session(ctx)` / the `handlers` callback's `session(ctx)` is the TYPED accessor for your `S` fields. Owns storage+session wiring; resolves storage per environment (D1 binding → `bot/storage-d1`; `BOT_PERSIST` path → sqlite, `redis://` → redis, lazily-imported optional peers; else announced-ephemeral memory) — or pass `storage: (env) => Storage` when the choice is env-dependent (e.g. a D1 binding not named `DB`). Boot NARRATES the composition (`session: memory …`, `features: language(en,es) · menu(/settings)`) so every implicit decision is visible where you're looking. Runnable demo: `pnpm demo:bot`. |
| `@adriangalilea/utils/bot/worker` | `botWorkerFetch(resolve)` — the Cloudflare Worker cap: secret-checked webhook (ack fast, work + storage flush ride `ctx.waitUntil`, errors DM admins throttled), `POST /setup` (webhook registration with handler-derived `allowed_updates` + a commit-narrating 🚀 deploy DM from the request body), `POST /deploy-started` (the 🛳 "what is shipping" DM — curl it from your deploy script on the still-live version, body `{sha, author, message, etaSeconds?}`), operator-authed `/pause` `/resume` `/webhook-status` (+ `statusExtra`), and a `routes` escape hatch tried before the built-ins. Structural bot type — no workers-types dependency. |
| `@adriangalilea/utils/bot/flags` | `defineFlags(spec, { read, write? })` — feature flags declared ONCE in code, resolved LIVE from the bot's operator-config record (D1 json row, Redis hash — storage-agnostic, Worker-safe, zero deps). Each flag: `{ kind: 'bool'\|'number'\|'string', label, help?, default }`, where `default` is a scalar or a **tier map** `{ free, vip?, 'vip.N'? }` resolved off `ctx.payments.tier()` — "free users get this limit, premium users get that model" is one declaration, zero branching at the call site (ladder walks down: exact rung → lower rungs → `vip` → `free`). Read sites: `await flags.<key>(ctx)` — stored override wins over the code default, per-ctx reads coalesce into one config fetch. `flags.describe()` is the JSON schema admin panels render generically, so a new flag appears in every panel with zero panel edits; `flags.set(ctx, key, value)` writes a kind-checked live override (`null` clears it — RFC 7386 null-delete, matching SQLite `json_patch`); `flags.overrides(ctx)` lists what's overridden. Corrupt stored values scream (`SourcedError`); bad specs panic at construction. |
| `@adriangalilea/utils/bot/storage-d1` | `d1Storage({ db, table? })` — `@gramio/storage` adapter over a D1 `session` table (schema in the module doc). `flush()` matters: the session plugin writes un-awaited and workerd freezes the isolate the instant `fetch()` returns — hand `flush` to `bot/worker` (automatic via `createBot`) so writes survive. |

Standard wiring:

```typescript
import { Bot } from 'gramio'
import { redisStorage } from '@gramio/storage-redis'
import { adminContext, gracefulStart } from '@adriangalilea/utils/bot/kit'
import { botSession } from '@adriangalilea/utils/bot/session'
import { accessControl } from '@adriangalilea/utils/bot/access-control'
import { llmStream, llmHistory } from '@adriangalilea/utils/bot/llm'

// Raw redis is fine — bot-id namespacing happens inside botSession +
// every plugin via ctx.bot.info.id. Multiple bots sharing this Redis
// stay isolated by construction. No manual prefix to remember.
const storage = redisStorage()
const userSession = botSession({ storage, key: 'session', initial: () => ({}) })
const chat = llmHistory({ session: userSession, maxTurns: 20, retentionDays: 7 })

const bot = new Bot(process.env.BOT_TOKEN!)
  .extend(adminContext({ adminId: 190202471 }))     // KEV.TELEGRAM_ADMIN_ID overrides
  .extend(userSession)
  .extend(accessControl({ session: userSession, storage, defaults: [] }))
  .extend(llmStream())
  .extend(chat.plugin)
  .on('message', async (ctx) => {
    if (!ctx.access.allowed) return
    ctx.llm.add({ role: 'user', content: ctx.text ?? '' })

    // Any OpenAI-compatible endpoint: vllm-mlx, mlx-lm, llama.cpp, Together, Groq, OpenAI, …
    const response = await fetch(process.env.LLM_URL!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.LLM_MODEL,
        messages: [{ role: 'system', content: 'You are helpful.' }, ...ctx.llm.get()],
        stream: true,
      }),
    })

    // High-level: handles reasoning (collapsed blockquote) + content streaming.
    const { content } = await ctx.startChatStream(response)
    ctx.llm.add({ role: 'assistant', content })
  })

await gracefulStart(bot)
```

Inside handlers, `ctx.access` is a typed discriminated union — `{ allowed: true, source: 'admin' | 'default' | 'store', record? }` or `{ allowed: false, reason }`. `ctx.adminId` and `ctx.isAdmin` are available on every event from `adminContext`.

For tests/demos without a second Telegram account, `simulateAccessRequest(bot, storage, adminId, fakeUser, msg)` injects a synthetic pending request so admin can exercise the approve/deny flow.

### Menu items — coloured buttons, refresh, toast-return, confirm

`MenuItem` supports four cooperating fields for richer UX. Each is opt-in:

```typescript
import { botMenu, toggleMenuItem } from '@adriangalilea/utils/bot/menu'

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

**Live state inside resolvers**: `label` / `style` / `header` / `visible` resolvers fire AFTER the action mutated the session, and they may be **async** — read your database (or `ctx.session.<field>`) directly at render time; never cache render strings into the session to satisfy a signature. `ctx.lang` from `bot/language` is a snapshot at event start and goes stale within the same callback; `ctx.say(...)` IS live and safe to use anywhere.

See `src/bot/CLAUDE.md` for storage layout, design decisions, and gotchas.

## Release

Bump version in `package.json`, push to `main`. CI handles everything:

1. Type-check, lint, build
2. Publish to npm via [OIDC trusted publishing](https://docs.npmjs.com/generating-provenance-statements) (no tokens — GitHub Actions proves identity directly to npm)
3. Create git tag `vX.Y.Z`
4. Generate changelog via [git-cliff](https://github.com/orhun/git-cliff) and create GitHub release

## License

MIT