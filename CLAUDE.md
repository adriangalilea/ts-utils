@README.md

## Metrics operations

Metrics core and reporting types are store-independent; the SQLite dialect is one
module over a two-verb driver, and every store gets a driver of its own (libSQL, D1),
never a client shaped like another client's. Applications own their connections and
their database: ui writes to a dedicated Turso database, xtldr to its bot's D1, both
through `METRICS_SCHEMA`, so one reader and one report serve every product. A new
SQLite store is a new `metrics/<driver>.ts` implementing `query` and `transact` with
that driver's native calls; a read-only path (REST) implements `query` alone. The
store is self-describing: `declare` writes the schema rows once per process, so a
console reads any product's database with `readReport` and no product endpoint sits
between them. Provision `METRICS_SCHEMA` explicitly;
never create tables during requests. Use database-scoped credentials, table
read/add/update permissions for ingestion (upserts require reads), and read-only
credentials for reports. Ingestion cannot delete rows or change schema.
Daily aggregate rows are retained for long-term trends. Actor rows are opt-in;
products enabling them must implement deletion and retention before collecting IDs.
The registry website collects aggregate component counts only.

Public API and migration instructions belong in README.md, imported above.
