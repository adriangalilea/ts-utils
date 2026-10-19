# @adriangalilea/metrics

Product metrics: declared counters and timings, bounded dimensions, optional actor IDs, and a schema for generic reporting, over one SQLite dialect and many stores. Part of [ts-utils](https://github.com/adriangalilea/ts-utils); it logs through [`@adriangalilea/utils`](https://github.com/adriangalilea/ts-utils/tree/main/packages/utils#readme).

## Installation

```bash
pnpm add @adriangalilea/metrics
```

No database client is bundled: install the one your store uses (`@libsql/client` for `metrics/libsql`; a D1 binding needs nothing).

## Product metrics

```ts
import { createClient } from "@libsql/client"
import { defineMetrics } from "@adriangalilea/metrics"
import { libsqlDriver } from "@adriangalilea/metrics/libsql"
import { metricsStore } from "@adriangalilea/metrics/sqlite"

const driver = libsqlDriver(createClient({ url: process.env.METRICS_DATABASE_URL!, authToken: process.env.METRICS_AUTH_TOKEN }))
const metrics = defineMetrics({
  installCopy: { kind: "counter", label: "install command copies", dimensions: { component: ["chat", "glass"] } },
}, { store: metricsStore(driver, "my-project") })

await metrics.installCopy.bump({ dimensions: { component: "chat" } })
```

| Subpath | What it does |
|---|---|
| `@adriangalilea/metrics` | Declared counters and timings, bounded dimensions, optional actor IDs, and a schema for generic reporting. Inject a store (`store: metricsStore(driver, project)`); measurement failures are reported without rejecting calls. |
| `@adriangalilea/metrics/sqlite` | Atomic SQLite driver, explicit provisioning schema, and inclusive UTC daily reports; libSQL is its own module (`metrics/libsql`) over the same driver shape. Connections and credentials belong to the application. |
| `@adriangalilea/metrics/libsql` | Wraps a Turso / libSQL client. |
| `@adriangalilea/metrics/d1` | Wraps a Cloudflare D1 binding (`d1Driver(env.DB)`). |
| `@adriangalilea/metrics/d1-rest` | Reads a D1 database over Cloudflare's REST API from a process with no binding (`d1RestReader({ accountId, databaseId, token })`). |
| `@adriangalilea/metrics/report` | `summarizeMetrics`, `metricWindows`, `compareMetrics` and the report types. |
| `@adriangalilea/metrics/cli` | `renderMetrics` and `renderMetricComparison`, on the ANSI-aware `cli.table` helpers. |

One SQLite dialect, many stores. `metrics/sqlite` holds the schema, the store and
the readers over a `MetricsDriver`: two verbs, `query(statement)` for rows and
`transact(statements)` for an all-or-nothing write batch. `metrics/libsql` wraps a
Turso / libSQL client, `metrics/d1` wraps a Cloudflare D1 binding (`d1Driver(env.DB)`),
each with the driver's native calls and structural types, so no database client is
bundled. Any other SQLite driver implements the two verbs in a few lines (the test
does it over `node:sqlite`). Readers need only `query`, a `MetricsReader`:
`metrics/d1-rest` reads a D1 database over Cloudflare's REST API from a process with
no binding (`d1RestReader({ accountId, databaseId, token })`). A store that does not
speak SQLite implements the `MetricsStore` contract, `declare(schema)` and
`write(measurement)`, and its own readers returning the `metrics/report` types.

**The store describes itself.** `declare` runs once per process before the first
sample and carries the whole schema: kinds, labels, help, units, per-user flags and
overlaps. Every later sample is one small transaction. A reader therefore never needs
the declaring code: `readSchema(reader, project)` returns what a project declared,
and `readReport(reader, { project, days, includeToday? })` returns everything a panel
renders in one call, `{ project, window, schema, daily, audience }`. A changed kind or
unit is refused at declaration and every sample of that process fails loudly; a store
that was briefly away is asked again by the next sample.

Provision the exported `METRICS_SCHEMA` once before collecting. `readMetrics(reader,
{ from, to, project? })` returns daily rows with labels and dimensions, using inclusive
UTC dates. `readAudience(reader, { from, to, project }, schema)` answers who did it
from the opt-in per-user rows: one row per declared per-user metric (zeros when nobody
touched it), with distinct actors, actors with more than one sample on a single day,
actors seen on more than one day, then each declared overlap as `fromUsers` and
`bothUsers`. Readers propagate database errors rather than presenting missing data
as zero.
`summarizeMetrics(rows)` from `metrics/report` produces one generic report shape;
`renderMetrics(rows, { daily? })` from `metrics/cli` renders it with the existing
ANSI-aware `cli.table` helpers. Both discover every recorded metric from its
declaration metadata. No product-specific metric list belongs in a renderer.

For period comparisons, `metricWindows(days, { now?, includeToday? })` from
`metrics/report` returns adjacent equal-length `current` and `previous` UTC ranges.
By default both contain completed days; `includeToday` marks the current window
`partial`. Fetch those ranges through your adapter, then call
`compareMetrics(currentRows, previousRows)` and
`renderMetricComparison(comparisons)` from `metrics/cli`. Comparisons include
disappearing series, count changes and weighted timing-average changes. Percent
change is null without a nonzero baseline; missing timing samples stay null.
Changing a metric's kind or unit across the inputs is rejected. Missing observations
are not proof that collection was running: deltas compare recorded data only.
Use a new key for a new meaning; labels, help and the per-user flag can be edited.

Measurements validate finite nonnegative samples, positive integer counts, and
declared dimension values. Calls resolve even when validation or storage fails;
`onError(error, key)` observes failures (the default logs a warning without actor
data). Await calls or attach them to the runtime's request lifetime (`after` in
Next.js, `waitUntil` in Workers). Unattached promises are not reliable delivery.
Counters are best-effort observations, not exactly-once ledgers; retries can count
twice. Money and successful-install accounting belong elsewhere.

`perUser: true` accepts an optional string or numeric `user` for daily actor rows.
Enable it only with a deletion and retention policy; no identity is inferred.
`overlaps: [["a", "b"]]` declares unordered audience overlap, not an ordered funnel.
Daily totals support counts and averages, not percentile latency or event ordering.

## Visits

A site's own visits live in the [ui registry](https://ui.adriangalilea.com/visits) as one family: `page-sensor` (the page), `visits` (the route, the store, the readers) and `user-flows` (the views), installed into the site as code it owns (`npx shadcn add @ag/page-sensor` brings `visits`). They build on the logger of `@adriangalilea/utils` (the event stream the pages write) and this package's metrics drivers (the store).

## License

MIT
