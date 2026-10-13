import { readFile } from "node:fs/promises";
import type { Pool } from "pg";

const INITIAL_MIGRATION = {
  version: "001_initial",
  url: new URL("../migrations/001_initial.sql", import.meta.url),
};

export async function migratePostgres(pool: Pool): Promise<void> {
  const client = await pool.connect();
  let destroyClient = false;
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      ["egy-pay-schema-migrations", "initial"],
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS egy_pay_schema_migrations " +
        "(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())",
    );
    const applied = await client.query(
      "SELECT version FROM egy_pay_schema_migrations WHERE version = $1",
      [INITIAL_MIGRATION.version],
    );
    if (applied.rowCount === 0) {
      const sql = await readFile(INITIAL_MIGRATION.url, "utf8");
      await client.query(sql);
      await client.query(
        "INSERT INTO egy_pay_schema_migrations (version) VALUES ($1)",
        [INITIAL_MIGRATION.version],
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
