import { Pool } from "pg";
import { migratePostgres } from "../dist/migrations.js";

const connectionString = process.env.EGY_PAY_DATABASE_URL;
if (!connectionString) {
  throw new Error("Set EGY_PAY_DATABASE_URL to the target database before running migrations.");
}

const pool = new Pool({ connectionString });
try {
  await migratePostgres(pool);
  process.stdout.write("egy-pay PostgreSQL migrations are current.\n");
} finally {
  await pool.end();
}
