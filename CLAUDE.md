@README.md

## Metrics operations

The shared Turso `metrics` database is separate from site content/auth databases.
Each writer is scoped to a project. Provision `METRICS_SCHEMA` explicitly with the
Turso CLI; never create tables during requests. Use database-scoped credentials,
table read/add/update permissions for ingestion (upserts require reads), and
read-only credentials for reports. Ingestion cannot delete rows or change schema.
Daily aggregate rows are retained for long-term trends. Actor rows are opt-in;
products enabling them must implement deletion and retention before collecting IDs.
The registry website collects aggregate component counts only.

Public API and migration instructions belong in README.md, imported above.
