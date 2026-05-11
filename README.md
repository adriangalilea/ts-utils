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

Number and currency formatting utilities:

```typescript
import { format } from '@adriangalilea/utils/format'

// Number formatting
format.number(1234.567, 2)  // "1234.57"
format.withCommas(1234567)  // "1,234,567"
format.withCommas(1234.567, 2)  // "1,234.57"

// Compact notation
format.compact(1234567)  // "1.2M"
format.compact(1234)  // "1.2K"

// Currency formatting
format.usd(1234.56)  // "$1,234.56"
format.btc(0.00123456)  // "0.001235 ₿"
format.eth(1.23456789)  // "1.234568 Ξ"
format.auto(100, 'EUR')  // "€100.00"

// Percentages
format.percentage(12.3456)  // "12.3%"
format.percentage(0.05)  // "0.05%"
format.percentage(123.456)  // "123%"
```

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
- **Offensive Programming**: assert, panic, assertNever, must, unwrap (throw `Panic`) + SourcedError for typed boundary failures
- **File Operations**: Read, write with automatic path resolution
- **Directory Operations**: Create, list, walk directories
- **KEV**: Redis-style environment variable management with monorepo support
- **XDG**: XDG Base Directory paths — reads env vars set by [xdg-dirs](https://github.com/adriangalilea/xdg-dirs), falls back to spec defaults
- **Unseen**: Persistent dedup filter — "what's new since last time?" for cron/monitoring workflows
- **Project Discovery**: Find project/monorepo roots, detect JS/TS projects
- **Bot plugins (GramIO)**: `kit` (graceful shutdown + admin context), `access-control` (gate + approve/deny menu, backed by sessions), `llm` (OpenAI-compat SSE parser `streamChat` + Telegram streaming output `ctx.startStream` + per-thread conversation history `ctx.llm`), `coalesce`, `language`, `menu`

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

In a bot, `bot/language` adds `ctx.say` — a callable namespace bound to `ctx.lang`:

```typescript
ctx.say({ en: 'Continue', es: 'Continuar' })       // → string
await ctx.say.send({ en: 'Hi', es: 'Hola' })       // → ctx.send(resolved)
await ctx.say.edit({ en: 'Done', es: 'Listo' })    // → ctx.editText (callback only)
await ctx.say.answer({ en: 'OK', es: 'OK' })       // → ctx.answer (callback only)
```

### Telegram bot plugins (GramIO)

Plugins for personal Telegram bots built on [GramIO](https://gramio.dev). Each plugin lives at its own subpath; peer deps (`gramio`, `@gramio/storage`, `@gramio/session`, `@gramio/format`, `marked`) are **all optional** — install only what you import.

```bash
pnpm add @adriangalilea/utils gramio @gramio/storage @gramio/session
```

#### Threaded Mode — pin the `@gramio/contexts` fork

Telegram added [Threaded Mode](https://telegram.org/blog/threaded-conversations) for private chats (BotFather → Bot Settings → Threaded Mode). gramio's `SendMixin` skips auto-threading there, and `CallbackQueryContext` doesn't expose `threadId` at all. Fixes [PR'd upstream](https://github.com/gramiojs/contexts/pull/4); until merged, pin the fork in **your bot project's** `package.json` (pnpm only honors overrides at the workspace root, not transitively):

```json
{
  "pnpm": {
    "overrides": {
      "@gramio/contexts": "github:adriangalilea/contexts#local-build/auto-thread-private-chat-threaded-mode"
    }
  }
}
```

Then `pnpm install`. Every `ctx.send` / `ctx.sendDocument` / `ctx.reply` / etc. — including from callback handlers — will auto-forward `message_thread_id` and stay in the thread the message came from. If you don't use Threaded Mode, skip this.

| Subpath | What it does |
|---|---|
| `@adriangalilea/utils/bot/kit` | `gracefulStart(bot)` — SIGINT/SIGTERM → `bot.stop()` → exit; force-kills if shutdown hangs.<br>`adminContext({ adminId? })` — reads `TELEGRAM_ADMIN_ID` from `kev` (with optional hardcoded fallback), decorates `ctx.adminId` + `ctx.isAdmin`. |
| `@adriangalilea/utils/bot/access-control` | Personal-bot ACL — gates non-admin/non-default users; admin gets DM with `[✅ Aprobar][❌ Denegar]` on first attempt; `/access` opens a persistent menu (revoke / reapprove / list pending). Backed by `@gramio/session` per-user + a small index. |
| `@adriangalilea/utils/bot/coalesce` | Joins client-split inbound messages back into one. When a user pastes >4096 chars, Telegram clients fragment it into separate `message` updates with no marker. Middleware detects the burst and emits one combined event. |
| `@adriangalilea/utils/bot/llm` | The full LLM-chatbot pipeline in one module. **Input:** `streamChat(response)` parses OpenAI-compatible SSE (OpenAI, vllm, mlx-lm, llama.cpp, Together, Groq, …) into a typed `AsyncGenerator<{type: 'content' \| 'reasoning', text}>`. **Output:** `ctx.startStream()` (low-level: debounced markdown to Telegram, 4000-char split, exposes `wasPartial` after `.end()`). `ctx.startChatStream(response)` (high-level: consumes the stream, renders reasoning as a Telegram `expandable_blockquote` entity + content as streamed markdown — both go through `markdownToFormattable` with graceful degradation — returns `{ content, reasoning }`). **History:** `llmHistory({...})` returns `.plugin` (decorates `ctx.llm` with `.add() / .get() / .clear() / .all() / .clearAll()`, per-(user, thread) OpenAI `ChatMessage` shape, persisted in the shared session record so the menu's 🗑 Forget wipes it automatically) AND `.menuItem` (drop-in "🧹 Clear this thread" for `botMenu`). |
| `@adriangalilea/utils/bot/menu` | `botMenu({ command, description, items, privacy?, personalData?, adminContact })` — `/settings` command + InlineKeyboard router. With `personalData: { storage }`, auto-adds 🗑 Forget + 📥 Export buttons. `toggleMenuItem({ id, read, write, label: { off, on }, toast? })` — convenience factory for boolean-toggle items with dynamic label + optional toast, storage-agnostic via `read`/`write` closures. |

Standard wiring:

```typescript
import { Bot } from 'gramio'
import { redisStorage } from '@gramio/storage-redis'
import { adminContext, gracefulStart } from '@adriangalilea/utils/bot/kit'
import { accessControl } from '@adriangalilea/utils/bot/access-control'
import { session } from '@gramio/session'
import { llmStream, llmHistory } from '@adriangalilea/utils/bot/llm'

const storage = redisStorage()                      // ONE instance, shared
const userSession = session({ storage, key: 'session', initial: () => ({}) })
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

See `src/bot/CLAUDE.md` for storage layout, design decisions, and gotchas.

## Release

Bump version in `package.json`, push to `main`. CI handles everything:

1. Type-check, lint, build
2. Publish to npm via [OIDC trusted publishing](https://docs.npmjs.com/generating-provenance-statements) (no tokens — GitHub Actions proves identity directly to npm)
3. Create git tag `vX.Y.Z`
4. Generate changelog via [git-cliff](https://github.com/orhun/git-cliff) and create GitHub release

## License

MIT