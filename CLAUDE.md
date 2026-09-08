@README.md

## Metrics operations

Metrics core and reporting types are store-independent. Applications own their
connections and adapters: UI uses a dedicated Turso database; xtldr keeps D1.
Do not wire garden to UI's store or move historical data to adopt the shared API.
For the optional SQLite/libSQL adapter, provision `METRICS_SCHEMA` explicitly;
never create tables during requests. Use database-scoped credentials, table
read/add/update permissions for ingestion (upserts require reads), and read-only
credentials for reports. Ingestion cannot delete rows or change schema.
Daily aggregate rows are retained for long-term trends. Actor rows are opt-in;
products enabling them must implement deletion and retention before collecting IDs.
The registry website collects aggregate component counts only.

Public API and migration instructions belong in README.md, imported above.
