# @adriangalilea/utils

TypeScript utilities - logger, currency, offensive programming, file operations, environment management, and more. The sibling of [swift-utils](https://github.com/adriangalilea/swift-utils), [py-utils](https://github.com/adriangalilea/py-utils), and [go-utils](https://github.com/adriangalilea/go-utils). The logging contract the three share, and the harness that proves they write the same event stream, live in [utils](https://github.com/adriangalilea/utils).

The Telegram bot plugins, the LLM caller and product metrics are their own packages in the same repo: [`@adriangalilea/bot`](https://github.com/adriangalilea/ts-utils/tree/main/packages/bot#readme), [`@adriangalilea/llm`](https://github.com/adriangalilea/ts-utils/tree/main/packages/llm#readme) and [`@adriangalilea/metrics`](https://github.com/adriangalilea/ts-utils/tree/main/packages/metrics#readme).

## Installation

```bash
pnpm add @adriangalilea/utils
```

## Features

- **Logger**: one event stream shared byte for byte with go-utils and py-utils (lines and spans, W3C trace ids), json or human rendering, scoped env-controlled levels
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

## Usage

### Logger

A program's logs and traces are one stream of events. A line is an event; a span is a piece of work written as a start and an end; every line written through a span carries its id. go-utils and py-utils write the same stream byte for byte, so their output can be read, merged and traced together. The contract, its JSON schema and the harness that runs all three live in [utils](https://github.com/adriangalilea/utils).

```typescript
import { log } from '@adriangalilea/utils/log'

log.info('ready')
log.warn('retrying', { attempt: 2 })
log.error('charge failed', { err })
```

Every verb takes a message, then optional fields. The message says what happened, the fields say with what. Fields are a plain object; anything else (an `Error`, a string, extra arguments) panics.

| verb | level | human |
|---|---|---|
| `error`, `fail` | error | `⨯` |
| `warn` | warn | `⚠` |
| `warnOnce` | warn, once per message and scope (bounded memory) | `⚠` |
| `info` | info | |
| `success` | info | `✓` |
| `wait` | info | `○` |
| `ready` | info | `▶` |
| `step` | info | `•`, indented |
| `debug` | debug | `◦` |
| `trace` | trace | `»` |

**Scopes.** `log.scope('api')` returns a child logger whose events carry `["api"]`; `log.scope('api').scope('auth')` carries `["api", "auth"]`.

**Spans.** A span is a logger: what is written through it belongs to it, and nothing else does (there is no ambient context, a function that logs inside a span takes the span). `span` returns what the callback returns, a Promise when it is async; a throw ends the span failed, with the error in `fields.err`, and is rethrown.

```typescript
await log.span('sync', { repo }, async (s) => {
  s.info('cloned', { files: 3 })
  await s.span('build', async (c) => { c.step('compiling') })
  s.set({ pushed: true })          // carried on the span's end event
})

// Work that does not fit a block: open it, end it once (twice panics).
const up = log.begin('upload', { size })
stream.on('end', () => up.end())
stream.on('error', (err) => up.end(err))
```

`s.traceId` is the id of the trace it belongs to, the `trace_id` its events carry: what a reader of the stream files and finds it under.

**Traces cross processes explicitly.** `s.traceparent()` is the W3C value to hand on, in an HTTP `traceparent` header or the `TRACEPARENT` env of a child process. `log.join(req.headers.get('traceparent'))` returns a logger whose spans are children of that remote span; `null` or `undefined` returns the logger itself, and a malformed value is ignored with one warn per distinct value. A process started with `TRACEPARENT` set joins it for every root span, with no code.

**Levels.** `silent < error < warn < info < debug < trace`, default `info`. A scoped event reads its threshold live from the most specific variable set: `["api", "auth"]` reads `API_AUTH_LOG_LEVEL`, then `API_LOG_LEVEL`, then `LOG_LEVEL`, then `setLogLevel()`, then `info`. `GZIP_LOG_LEVEL=silent` shuts one subsystem up without touching code. Whether a span is shown is decided once, when it begins; a hidden span writes no end, but a failure is never lost to that: a hidden span that fails writes one `fail` line (its name, its fields with `err` and `dur_ms`) as a line of the nearest shown span. What it holds (lines, child spans, `traceparent()`) attaches to the nearest shown span, so a viewer never meets a missing parent. A remote span joined through `join` or `TRACEPARENT` counts as shown. With no shown ancestor, a hidden span's lines carry no ids, as lines outside any span.

**Renderings.** `json` is one event per line on stderr, keys in the contract's order, fields sorted at every depth, errors as `{type, message, stack, cause, …}`:

```json
{"time":"2026-10-12T12:20:39.123Z","level":"warn","verb":"warn","msg":"retrying","service":"checkout","scope":["payments"],"trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7","fields":{"attempt":2}}
```

`human` is symbols, colour (TTY, `NO_COLOR`, `FORCE_COLOR`), fields dim as `key=value`, a field holding several lines under its line as written, an error's stack under its line (once: a span failing with the error a span inside it already failed with shows the message only; json writes it on both ends), and spans with what they hold indented:

```
 ○ sync repo=ui
     cloned files=3
   ○ build
       • compiling
   ✓ build 51ms
 ✓ sync 51ms pushed=true
```

Node, Bun and Deno write every event through `console.error` (stdout stays data, and a `cli` live region keeps lines above it); browsers and Workers use the level's console method, so Workers Logs files each event at its level. A Worker is recognised by its user agent, so `nodejs_compat`'s `process` does not pass it off as Node; its `LOG_SERVICE` and other vars are read from that `process.env`.

**Configuration.** Each variable has a setter. The setter is the program's default and the variable, read live, overrides it. Values match without regard to case, an empty variable is unset, and an unknown value panics.

| variable | setter | values | default |
|---|---|---|---|
| `LOG_FORMAT` | `setLogFormat` | `human`, `json` | Node: human when stderr is a TTY, else json. Browser: human. Worker: json |
| `LOG_TIME` | `setLogTime` | `1`, `0` | off. Puts a dim local `HH:MM:SS` before human lines; json always carries `time` |
| `LOG_CONSOLE` | `setLogConsole` | `1`, `0` | on. Off, events are not written to the console (stderr, a browser's console) and only ship: a page that ships its stream shows a visitor nothing |
| `LOG_LEVEL`, `{SCOPE}_LOG_LEVEL` | `setLogLevel` | the levels | `info` |
| `LOG_SERVICE` | `setLogService` | a name | the entry script's name without extension. A Worker or browser has none: set it, or the first json event panics |
| `LOG_SHIP` | `setLogShip` | an http(s) URL | unset. Every event that passes its threshold is also POSTed there (Shipping) |
| `LOG_SHIP_TOKEN` | `setLogShipToken` | a token | unset. Sent as `Authorization: Bearer` with each batch; a browser sends none, and `setLogShipToken` in one panics |

**Shipping.** With `LOG_SHIP` set, the logger also POSTs its events to that URL, so a process ships its stream with no code:

```sh
LOG_SHIP=https://logs.example.com/ingest LOG_SHIP_TOKEN=… node server.js
```

What ships is the stream's json line, byte for byte, whatever the console renders (human at a terminal included). A batch is lines joined by `\n`, `Content-Type: text/plain;charset=utf-8`, at most 64 KB and 50 events. It leaves 2s after its first event, at 50 events, when a span opened outside any local span ends (a root span, or a request joined from its caller: its whole trace leaves together), before a Node or Bun process exits on its own (`beforeExit`), and in a browser on `visibilitychange: hidden` and `pagehide`; whatever a hidden page sends goes through `sendBeacon`, the one request a browser finishes after the page is gone. `flushLog()` sends what waits and resolves when nothing is in flight: a Worker hands it to `ctx.waitUntil(flushLog())`, a serverless function to its runtime's `after`, and a process that calls `process.exit()` awaits it first (nothing else runs after `exit`). Shipping never throws and never blocks a write: a refused or lost batch is one `warnOnce` under scope `ship`, an event over 64 KB stays on the console and warns once. The wire and the collector's answers are the contract's, in [utils](https://github.com/adriangalilea/utils#shipping).

**A page's trace on a Next.js server** (`@adriangalilea/utils/log/next`, `next` an optional peer). A page that writes the stream ([utils](https://github.com/adriangalilea/utils) README, "Web pages") puts its `traceparent` on every same-origin request; these wrappers make the server's work a child of that request, in the page's trace, and hand `flushLog` to Next's `after` so a frozen instance holds nothing unsent. A request with no `traceparent` is a root span of its own.

```typescript
import { traced, tracedAction } from '@adriangalilea/utils/log/next'

export const POST = traced('POST /api/vote', async (s, request) => {
  await s.span('turso insert vote', () => db.execute(insert))
  return Response.json({ ok: true })
})

// in a "use server" file
export const vote = tracedAction('vote', async (s, id: string) => { … })
```

**Reading the stream.** `LogEvent` is the wire shape as a type (a line, a span start, an ok end or a failed end, discriminated by `phase` and `status`), and `parseEvent(line)` reads one line back: an event, `null` for a line that is not one (pass it through), or a `Panic` for a JSON object with a `verb` key that breaks the shape.

```typescript
import { parseEvent, type LogEvent } from '@adriangalilea/utils/log'

const e = parseEvent(line)
if (e?.phase === 'end') e.dur_ms
```

`humanReader({ clock? })` renders a stream the way the `human` format shows it live: spans at their depth, lines under the span that wrote them, durations, an error's stack once. The depth comes from the stream's own `parent_id`s, so a stored file, or a stream another process shipped, reads like that process's console.

```typescript
const show = humanReader({ clock: true })
for (const line of text.split('\n')) {
  const e = parseEvent(line)
  if (e) console.log(show(e))
}
```

`breakdown(events)` says where a trace's time went: each span's own time (its duration, less the time its children cover) counts for its `kind` field, or the nearest enclosing span's, else `other`. Name what a span does where it begins (`span('look', { kind: 'perception' })`) and everything inside counts for it until a span says otherwise.

```typescript
breakdown(events) // { wall_ms: 26800, by: { inference: 18600, input: 4600, wait: 2300, other: 900, perception: 300 } }
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

Every Intl call pins `en` — SSR apps hydrate identically on server and client
(no React #418 from a runtime-default locale). Every formatter accepts
`null | undefined` and renders `"—"`, so DB fields pass straight through.

```typescript
import { compact, percentage, fixed, withCommas, bytes, bitsPerSec } from '@adriangalilea/utils/format'

withCommas(1234567)     // "1,234,567" (bigint-safe)
withCommas(1234.567, 2) // "1,234.57"
compact(1234567)        // "1.2M"
compact(1234)           // "1.2K"
percentage(12.3456)     // "12.3%" (smart decimals)
percentage(0.05)        // "0.05%"
percentage(123.456)     // "123%"
percentage(2.41, { sign: true })    // "+2.4%" (deltas: 24h change, diffs)
percentage(2.4126, { decimals: 2 }) // "2.41%" (fixed decimals)
fixed(1.234)            // "1.23" (plain toFixed, no grouping)
bytes(12.7e12)          // "12.7 TB" (decimal SI, like drive specs / df -h)
bitsPerSec(2.5e9)       // "2.5 Gbps"
percentage(null)        // "—" (every formatter)
```

Money lives in `currency`, which is split by dependency weight so the barrel
tree-shakes at file granularity: the 133KB crypto-symbol dataset is imported
only by its classify module, so `import { usd } from '…/currency'` ships
dollars, not 13k tickers.

```typescript
import { usd, usdIntlOptions, btc, money } from '@adriangalilea/utils/currency'

usd(1234.56)                  // "$1,234.56" (grouped; dataset-free import)
usd(4.3387e-7)                // "$0.00000043" (sub-cent keeps 2 significant digits)
usd(0.43387, { decimals: 4 }) // "$0.4339" (policy override)
usd(60892283, { compact: true }) // "$60.9M" (market-cap scale)
btc(0.00001234)     // "0.000012340 ₿" (dataset via optimal decimals)
money(100, 'EUR')   // "€100.00"

// The decimals policy as Intl.NumberFormatOptions — for consumers that format
// internally (NumberFlow-style animated numbers, chart axes):
usdIntlOptions(0.43387) // { style: 'currency', currency: 'USD', minimumFractionDigits: 3, ... }
```

### ANSI primitives (`ansi`)

Raw escape codes, ALWAYS ON — the vocabulary under the TTY-aware layers. The
logger and `cli` palettes decide *whether* to color (TTY, `NO_COLOR`,
`FORCE_COLOR`); this module is for output whose consumer renders ANSI
regardless of what stdout is: Claude Code status lines, tmux status strings,
files a terminal will cat. 256-color first (`fg`/`bg` — stable across
terminals and multiplexers); `rgb` for known-truecolor consumers. Out-of-range
indices panic.

```typescript
import { fg, bg, rgb, BOLD, RESET, stripAnsi, ANSI_RE } from '@adriangalilea/utils/ansi'

`${BOLD}${fg(171)}Fable 5${RESET}`   // bold bright violet
fg(196)                              // red foreground
bg(238)                              // dark gray background
rgb(173, 127, 168)                   // 24-bit, when the consumer renders it
stripAnsi(styled)                    // the string minus its escapes (hyperlinks too)
link('docs', 'https://example.com')  // OSC 8 hyperlink, always on
```

`cli`'s ANSI-aware `width()` / `clip()` measure strings styled with these
(they share `ANSI_RE`).

The semantic roles live here too, the one map of role to escape that `cli`'s
`ui` paints with: `ROLES` (`head`, `accent`, `muted`, `ok`, `warn`, `bad`,
`ref`) and `inRole(role, s)`, always on. A page that draws a CLI's output (a
terminal on a landing page) writes it in the same roles, so the two cannot
disagree on a colour.

```typescript
import { inRole } from '@adriangalilea/utils/ansi'

`${inRole('muted', 'code')} ${inRole('head', 'BCDF-GHJK')}`
```

### Time (`time`)

Humanized time — three questions, three functions: how long is a duration
(`span`), how long ago was an instant (`ago`, raw-duration twin `since`), how
long until an instant (`until`). `ago` degrades by distance instead of
stacking units: fresh instants stay relative, older ones snap to the clock the
reader would check. Accepts `Date | ISO string | epoch ms | null | undefined`
(null renders `"—"`); epoch numbers are milliseconds only, by design — a
seconds heuristic would silently shift dates near the boundary.

```typescript
import { span, since, ago, until } from '@adriangalilea/utils/time'

span(6_000_000)                    // "1h 40m"  (also "45s", "47m", "2d 3h")
since(sessionStart)                // "47m" — elapsed, no "ago"
ago(twoMinutesAgo)                 // "2m ago"  ("now" under a minute)
ago(fiveHoursAgo)                  // "5h 12m ago"  (relative up to 6h)
ago(thisMorning)                   // "10:30"       (clock time, today)
ago(lastNight)                     // "yst 22:15"
ago(fourDaysAgo)                   // "Mon 09:00"   (within a week)
ago(lastMonth)                     // "07/28"
until(weeklyReset)                 // "in 3d 13h"   ("now" if passed)
ago(null)                          // "—" (every function)
```

Time as a person types it, one vocabulary for every `--since`, `--until` and deadline: `today`, `yesterday`, `20:00` (today at that local time), `30m`/`2h`/`3d`/`1w`, `2026-10-05` (that local day), or an ISO datetime. `parseWhen` looks back (`2h` is two hours ago), `parseDeadline` forward (two hours from now). A day is a span, so `edge` says where a bound falls: a `--since` at its first instant, an `--until` at its last; a deadline day ends at its last. Anything outside the vocabulary throws, naming it.

```typescript
import { localDay, localStamp, parseDeadline, parseWhen } from '@adriangalilea/utils/time'

parseWhen('3d')                    // three days ago
parseWhen('2026-10-05', 'end')     // 2026-10-05 23:59:59.999, local
parseDeadline('2h')                // two hours from now
localDay(d)                        // "2026-10-05", the local day (never toISOString's UTC one)
localStamp(d)                      // "2026-10-05 20:00"
```

### URL (`url`)

URLs, from user-typed text to cache identity. The whole funnel — *is there a
URL? which resource? whose content? what identity?* — answered once, on one
object. Each concern rides its state of the art instead of hand-rolls:
detection is [linkifyjs](https://linkify.js.org) (scanner-based, TLD-aware);
parsing is the WHATWG URL API, never regexes; the knowledge of WHICH params
are tracking is vendored from
[@protontech/tidy-url](https://www.npmjs.com/package/@protontech/tidy-url)
(Proton's maintained fork of DrKain/tidy-url, MIT; refresh with
`pnpm --filter @adriangalilea/utils update-url-rules`) plus a small tested overlay; per-site content
identity is an adapter registry (YouTube built in). Global rules only for
unambiguous trackers (utm_*, fbclid, gclid, …); ambiguous names stay per-host —
`si` is junk on YouTube/Spotify but `ref` on GitHub names a branch and
survives.

```typescript
import { urlsIn, urlOf, cleanUrl, urlKey, hostOf, hostMatches,
         youtubeVideoId, youtubeUrl, youtubeThumbnailUrl } from '@adriangalilea/utils/url'

// Every http(s) URL in free text, in order, fully resolved:
urlsIn('watch youtu.be/dQw4w9WgXcQ?si=junk and https://a.com/x?utm_source=t')
// [{ raw: 'youtu.be/dQw4w9WgXcQ?si=junk', start: 6, end: 34, hadScheme: false,
//    href: 'https://youtu.be/dQw4w9WgXcQ',          // cleaned — fetch/share this
//    host: 'youtu.be', site: 'youtube', id: 'dQw4w9WgXcQ',
//    key:  'youtube:dQw4w9WgXcQ' },                  // THE cache/dedupe identity
//  { …, href: 'https://a.com/x', site: null, id: null, key: 'a.com/x' }]

// One pasted token → one resolved Url (or null). Punctuation, brackets,
// emails-are-not-URLs: the scanner's problem, not yours.
urlOf('<https://example.com/a?utm_source=x>,')?.href  // 'https://example.com/a'
urlOf('example.com/a', { requireScheme: true })       // null (bare domains opt-out)

// `key` is the point: every spelling of one resource collides.
// Recognized sites collapse to their native content id —
urlKey('https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=x')  // 'youtube:dQw4w9WgXcQ'
urlKey('https://www.youtube.com/shorts/dQw4w9WgXcQ')          // 'youtube:dQw4w9WgXcQ'
// — everything else canonicalizes generically:
urlKey('https://www.theverge.com/2026/story/?utm_source=x#c') // 'theverge.com/2026/story'

// The SAME resource minus tracking — keeps scheme, www., order, fragment.
cleanUrl('https://www.youtube.com/watch?v=abc&t=120s&si=junk')
// 'https://www.youtube.com/watch?v=abc&t=120s'

// YouTube identity from ANY spelling (watch, youtu.be, shorts, live, embed,
// music., nocookie, redirect wrappers, bare 11-char id):
youtubeVideoId('https://www.youtube.com/attribution_link?u=%2Fwatch%3Fv%3DdQw4w9WgXcQ')
// 'dQw4w9WgXcQ'
youtubeUrl('dQw4w9WgXcQ')           // 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
youtubeThumbnailUrl('dQw4w9WgXcQ')  // 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'

hostOf('https://www.theverge.com/a')            // 'theverge.com'
hostMatches('music.youtube.com', 'youtube.com') // true (RFC 6265 domain-match)
hostMatches('notyoutube.com', 'youtube.com')    // false

// App-specific junk rides along per call
urlKey(url, { strip: ['session_id'] })
```

Unparseable or non-http(s) input passes through unchanged — these are hygiene
functions over user-pasted text, not validators.

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

// A clickable link (OSC 8) where this process colors; the words alone in a pipe.
// Measured as its words, so a linked cell aligns like any other.
link('eid.to/ada', 'https://eid.to/ada')
```

Run the demo: `FORCE_COLOR=1 pnpm --filter @adriangalilea/utils demo:cli`.

### Live output (`cli`) — pinned region, spinner, progress

A pinned, self-repainting region at the bottom of the terminal for progress UIs. You own the state; the region is a `render: () => string` repainted on a timer — a frame is just a string, so `table()` / `kv()` / `ui` and the widgets (`spin()`, `bar()`, `rate()` / `eta()`, `elapsed()`) compose inside it unchanged.

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

// Speed over a moving window (5 s default): a stall reads as a falling number
const speed = rate()
onProgress((done) => speed.add(done))       // the running total
live(() => `${bar(done, total)} ${bytes(speed.perSecond())}/s · ${Math.round(eta(total - done, speed.perSecond()) / 1000)}s left`)
```

What makes it hold up:

- **Logging never tears the UI, with no API to learn.** While a region is active, `console.log/warn/error` — and therefore the logger — are rerouted to print *above* the region (erase → write → repaint). Keep logging from anywhere, including third-party code. Boundary: only `console.*` is patched — a library writing raw to `process.stdout.write` bypasses the routing and can tear.
- **Non-TTY degrades to sane output.** In a pipe / CI / log file nothing animates: `done()` prints the final frame once, `spinner()` prints just its `✓ label 1.2s` line (`⨯ label 1.2s` when it fails: the step and its time, the error said once, by whoever handles it). Same calling code. Opt-in `heartbeat: ms` prints plain snapshots so long CI runs aren't silent.
- **Renders to stderr by default** — stdout stays clean for `--json` and pipes.
- **Crash-safe cursor**: hidden while painting, restored on done/clear, process exit, and signals — politely (if the app has its own SIGINT handler for graceful shutdown, it stays in charge).
- **Flicker-free**: synchronized-update escapes (`?2026`) make repaints atomic on modern terminals; lines are ANSI-aware clipped to the terminal width so the erase math never breaks.
- **Measurement is in terminal cells**: a ZWJ emoji / flag is one grapheme, and CJK characters and emoji take two cells, so `width()`/`clip()`/`table()` line up what a terminal shows (py-utils `cli` measures the same way). `clip()` never splits a wide character at the cut.
- One **region** at a time, by design (`assert`): two pinned regions can't share the bottom of one screen — compose into a single `render()`. A `spinner()` started *under* an active region is legitimate composition and degrades gracefully: its final line prints above the region.

Run the demo: `pnpm --filter @adriangalilea/utils demo:live` (and pipe it through `| cat` to see the non-TTY degradation).

### Command-line programs (`cli`)

A program is described once, as data, and everything a person meets is read from that table: the parse, the refusals, the values' types and the help. A flag cannot exist without its words, nor its words without the flag.

```typescript
import { main, program, WATCH_FLAGS } from '@adriangalilea/utils/cli'

const eid = program({
  name: 'eid',
  version: '1.0.0',
  says: 'your e-ID from a terminal',
  global: { json: { type: 'boolean', says: 'the answer as JSON on stdout' } },
  commands: {
    send: {
      args: '<path> [name]',
      says: 'send a file or a folder from this machine',
      flags: { to: { type: 'string', short: 't', value: '<people>', says: 'only for these accounts' } },
      examples: ['eid send notes.zip --to ada'],
      json: 'SendMade',
    },
    inbox: {
      says: 'what people are sending you',
      flags: { watch: { type: 'boolean', short: 'w', says: 'wait for sends' }, ...WATCH_FLAGS },
    },
  },
  sections: [['files', ['send', 'inbox', 'help']]],
})

main(() =>
  eid
    // built once from the call, given to every handler as its second argument
    .context(({ values }) => client({ json: values.json === true }))
    .run({
      // one handler per command, each given its own call: args, and values typed by its flags
      send: ({ args: [path], values }, api) => send(api, path, values.to),
      inbox: ({ values }, api) => inbox(api, values.watch, values.once),
    }),
)
```

`run` answers `help`, `--help` and `--version` itself (their data as JSON under `--json`) and gives any other command to its handler; a handler missing or a handler for no command is a type error, and screams when it runs. `context` is its own step so its type is settled before any handler is read; a program with nothing to share calls `run` straight on the program. `parse` is the same reading without the dispatch, for a program that routes its own calls.
- **A flag may be `required`**: absent, the command refuses, saying what the flag is for, and its value is typed as there.
- **A command may answer to aliases** (`aliases: ['msg']`), shown beside it as `message|msg`. They are input only: the handler, the help, the JSON and every message name the command itself. Use them sparingly. Their cost is two spellings of one command in scripts, transcripts and docs, so a skill written with `msg` and one written with `message` no longer grep alike; examples and skills should always use the name. A shell alias or a fish abbr is often the better tool for a shorter spelling: it is the person's own, and an abbr expands to the full command as it is typed, so history, transcripts and agents only ever see the name. Reach for `aliases` when the tool itself should accept a word, an obvious synonym people will guess (`del` for `rm`), not to save keystrokes.

- **The parse reads argv once, against the program's flag table**: short flags group (`-wo`, `-wd ~/x`, a flag taking a value last, glued or next), `--dir=x` works, `--` ends the flags, a lone `-` is an argument. A dash and a digit that no flag spells (`-5`, `--09-29`) is an argument, and a flag where a value should be leaves the value missing.
- **A flag is `boolean`, `string` or `integer`** (a whole number, typed `number`, `--limit lots` refused). `choices` are the only values a string flag takes, and its type narrows to them: pass the domain's own array (`choices: FOLDERS`) so the flag cannot drift from it, and `--folder spam` is refused naming the words. `list: true` reads `--to a,b` (and repeats, `--to a --to b`) as an array, trimmed, empties dropped, each item checked. `value` is only the placeholder the help shows; absent, the help shows the choices (`<credit|debit>`), and where a placeholder like `<kind>` hides them, the detail lists them after the words.
- **`args` types the handler**, one tuple per length the parse can hand over: `args: '<env> <version> [note]'` gives `[string, string] | [string, string, string]`, so `const [env, version, note] = args` has `env` and `version` as `string` and `note` as `string | undefined`, and `args` still passes as a `string[]`. A last `<x...>` adds at least one more, `[x...]` any number. A needed argument after one that may be missing (`[who] <msgId>`, where the handler decides whether the first word is a who) is allowed and typed `string[]`, since the positions are the handler's.
- **`choices` are the only words an argument takes**, by its name in `args`: `choices: { env: ENVS }` refuses `ship deploy local` naming the nearest (`"stagin" is no <env> of ship deploy: staging?`), narrows the argument's type to `ENVS[number]`, and lists the words under `arguments` in `help <command>`. Pass the domain's own array so the argument cannot drift from it, as with a flag's `choices`. `<on|off>` is the same, for words fixed in the grammar. A grammar whose positions are the handler's (`[who] <msgId>`) cannot have choices, refused at start. Any other value is the handler's to check.
- **A name may be words**, for a command with actions under it: `invoice` (show one), `'invoice create'`, `'invoice cancel'`, each in the same flat table with its own flags and handler. The leading words of argv spell the longest name they can, so `bank invoice create` is the action and `bank invoice F-12` the invoice; `help invoice` lists the actions under it.
- **A program may have a `default`**, for one whose main act needs no verb: `default: { command: 'pull', claims: (w) => w.includes('/') }` makes `hf-get owner/repo` run `hf-get pull owner/repo`. A first word goes to the default only when no command spells it and `claims` holds for it; a word it claims that is a slip of a command's name (`lss`) is refused naming both readings, so `claims` decides what the default takes, never which typos it swallows. The tighter the claim, the better the guard: a shape no command name can have (a `/`, a path, a number) leaves every mistake caught, while `() => true` (free text, as a message) catches only the slips. The command keeps its name, shown as `hf-get [pull] <repo>`, and scripts should say it.
- **A mistake throws `CliError` (code `usage`) saying what to type**: a flag of another command (`--watch is not a flag of eid send: it is eid inbox's`), a flag of none with the nearest spelling, a missing value, a command misspelt (`No command "sned": eid send?`), and arguments counted from `args`: each `<x>` is needed, each `[x]` may be given, a last `<x...>` takes the rest, `<on|off>` takes only those words.
- **`help`, `--help`, `-h` and `--version` are built in.** `call.kind === 'print'` carries the text and the same as `data` for `--json`. The overview lists every command in its section, then the global flags and the `env` variables in groups of their own, every description in one column and folded under it, never past 80 columns; `help <command>` adds `more`, the flags, `examples` and what `json` prints.
- **`version` is for a program that has releases** (one published to npm): it answers `--version` and stands beside the name. A program run from its source has no release to name, so it gives none and has no `--version`, rather than a number nobody bumps.
- **The spec is checked as the program starts**: a section missing a command, a short letter meaning two flags (one letter, one flag, across the program), one flag name with two types, `args` that cannot be counted. Each throws on the first run, never on the one command that trips it.

`main(run)` answers a failure one way for every program: a `CliError` is said in red (under `--json`, `{ error: { code, message, fields? } }` on stdout) and exits 1; anything else is a bug, thrown with its stack. `emit(json, data, human)` is the answer, JSON or for a person.

**Questions** (`ask`, `confirm`, `askHidden`) go to stderr, so stdout stays the answer. Ctrl-C at one is Ctrl-C, Ctrl-D is no answer, and `askHidden` reads key by key with the terminal raw, so a password is in no scrollback. With no terminal to ask in (a pipe, a script, an agent) each throws `CliError` (code `unconfirmed`) with what to type instead, never waiting on input nobody will give:

```typescript
if (!(await confirm('take it?', 'say --yes to take it'))) return
const password = await askHidden('password: ', '--password <words>')
```

### Watching (`cli`)

Every `watch` command keeps one contract, so an agent that learned one has learned them all: it streams every match until Ctrl-C; `--once` (`-o`) exits 0 at the first; `--until <t>` exits at the deadline, 0 if anything matched and 2 if nothing; `--since <t>` first considers what arrived after t; exit 1 is a real failure. Matches go to stdout (one JSON line each under `--json`), everything else to stderr, so an agent backgrounds the watch and branches on its exit code.

An exit 2 is read as "it did not happen", so the transport behind every watch owes four guarantees:

- **Concurrent watches each see every event.** A transport that admits one live subscriber (an MTProto auth key's update stream) is owned by one daemon writing a local log, and watches read the log.
- **Nothing between start and live is lost.** `armedAt(values.since)` is the moment the process started (or `--since`); every event after it belongs to the watch, and a poller's baseline is that instant, never its first poll.
- **`--since` works in every scope.** A supervisor re-arming a watch after a reboot appends `--since <armed>`, and the watch covers what arrived while nothing was watching; a transport that cannot reach that far back exits 1 saying so.
- **A dead source is exit 1**, never a deadline with no match.

```typescript
import { armedAt, deadlineFlag, matchFlag, WATCH_FLAGS, WatchClock } from '@adriangalilea/utils/cli'

// flags: { ...WATCH_FLAGS, match: { type: 'string', value: '<re>', says: '…' } }
const from = armedAt(values.since)   // everything after this is the watch's
const clock = new WatchClock({
  once: values.once === true,
  until: values.until ? deadlineFlag(values.until) : undefined,
  cleanup: () => imap.logout(),
})
for await (const m of stream) {
  if (!matchFlag(values.match ?? '').test(m.subject)) continue
  // emits the match unless the watch has ended, then counts it: a --once watch ends
  // here (after stdout drains), and a batch delivered at once still yields one match
  clock.hit(() => console.log(JSON.stringify(m)))
}
```

`whenFlag(flag, s, edge)` and `deadlineFlag(s)` read the time vocabulary (Time, below) and turn a mistake into a `CliError`.

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
    log.scope(e.source).error(e.operation, { err: e })  // source, operation, status, context, cause
    throw e
  }
  throw e                                                     // unknown — re-throw
}
```

Every `SourcedError` carries `source`, `operation`, `status`, `context`, and the original exception via `cause`. Call `.toJSON()` for serialization across process boundaries.

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

In a bot, `@adriangalilea/bot/language` adds `ctx.lang` + `ctx.say`. Both resolve stored explicit pick → Telegram client hint → configured default, at READ time — the hint is never persisted, and `session.language` is written only by an explicit pick (the plugin's menuItem action):

```typescript
ctx.say({ en: 'Continue', es: 'Continuar' })       // → string
await ctx.say.send({ en: 'Hi', es: 'Hola' })       // → ctx.send(resolved)
await ctx.say.edit({ en: 'Done', es: 'Listo' })    // → ctx.editText (callback only)
await ctx.say.answer({ en: 'OK', es: 'OK' })       // → ctx.answer (callback only)
```

## License

MIT
