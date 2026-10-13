import { readFile } from "node:fs/promises";
import type { Pool } from "pg";

const MIGRATIONS = [
  {
    version: "001_initial",
    url: new URL("../migrations/001_initial.sql", import.meta.url),
  },
  {
    version: "002_outbox_delivery",
    url: new URL("../migrations/002_outbox_delivery.sql", import.meta.url),
  },
  {
    version: "003_trusted_reconciliation",
    url: new URL("../migrations/003_trusted_reconciliation.sql", import.meta.url),
  },
];

export async function migratePostgres(pool: Pool): Promise<void> {
  const client = await pool.connect();
  let destroyClient = false;
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      ["egy-pay-schema-migrations", "main"],
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS egy_pay_schema_migrations " +
        "(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())",
    );
    for (const migration of MIGRATIONS) {
      const applied = await client.query(
        "SELECT version FROM egy_pay_schema_migrations WHERE version = $1",
        [migration.version],
      );
      if (applied.rows.length > 0) continue;
      const sql = await readFile(migration.url, "utf8");
      await client.query(sql);
      await client.query(
        "INSERT INTO egy_pay_schema_migrations (version) VALUES ($1)",
        [migration.version],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      destroyClient = true;
    }
    throw error;
  } finally {
    client.release(destroyClient);
  }
}
