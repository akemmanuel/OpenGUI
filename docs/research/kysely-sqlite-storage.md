# Kysely and native SQLite for OpenGUI Harness storage

Research captured 2026-07-10 from primary project documentation and source-linked API docs.

## Findings

- Kysely describes itself as a type-safe TypeScript SQL query builder rather than a stateful ORM.
  It provides typed query construction, query execution, transactions, schema operations, and
  optional migration primitives. [Kysely introduction](https://kysely.dev/docs/intro)
- Kysely migrations are ordinary modules with `up` and `down` functions. They can use either the
  schema builder or normal/raw queries. The documentation explicitly says migrations must not
  depend on current application code because they need to remain “frozen in time.”
  [Kysely migrations](https://kysely.dev/docs/migrations)
- Migration names execute in alphanumeric order. Kysely checks that this order agrees with the
  order already recorded in the database unless unordered migrations are explicitly enabled.
  [Kysely migrations: execution order](https://kysely.dev/docs/migrations#execution-order)
- Kysely's built-in SQLite dialect targets `better-sqlite3`, not Node's built-in `node:sqlite`.
  [SqliteDialect API](https://kysely-org.github.io/kysely-apidoc/classes/SqliteDialect.html)
- Kysely's official dialect list links `kysely-node-native-sqlite` as the community “Node SQLite”
  dialect. [Kysely dialect list](https://kysely.dev/docs/dialects)
- `kysely-node-native-sqlite` accepts the same constructor arguments as `node:sqlite`'s
  `DatabaseSync`, requires Node 22.5 or newer, and implements Kysely's SQLite adapter/compiler over
  the native driver. [Dialect repository](https://github.com/wolfie/kysely-node-native-sqlite)
- Kysely's migrator maintains its own migration and migration-lock tables rather than relying on
  SQLite `PRAGMA user_version`. The source constants are `kysely_migration` and
  `kysely_migration_lock`. [Kysely migrator source](https://github.com/kysely-org/kysely/blob/master/src/migration/migrator.ts)

## OpenGUI decision

Use Kysely with `kysely-node-native-sqlite` in `@opengui/harness`:

- retain native `node:sqlite` and avoid another native binary in Electron/Docker packages;
- define the current query schema in `packages/harness/src/storage/schema.ts`;
- keep immutable migrations in `packages/harness/src/storage/migrations.ts`;
- run Kysely's `Migrator` before any store operation;
- keep semantic JSON payloads explicit at the storage boundary;
- perform multi-write Session operations in Kysely transactions; and
- test fresh installation, restart replay, and upgrade from the historical prerelease v1 shape.

The first migration is deliberately compatibility-aware because two prerelease database shapes
already existed before a Kysely migration ledger was introduced. It adopts either shape, removes
the obsolete `sessions.model_json` and `sessions.reasoning` columns when present, and then records
the migration in Kysely's ledger. All future migrations must be additive, uniquely named, and
never edited after release.

## What Kysely prevents—and what it does not

Typed inserts now fail project checks when required columns in the TypeScript database interface
are omitted. The migration ledger prevents silently reusing one migration name for a later schema
step. Transactions remain explicit and reviewable.

Kysely cannot detect a database shape that was changed outside its migration history, nor can it
guarantee that a migration preserves semantic data. Historical upgrade fixtures and public Harness
acceptance tests remain mandatory.
