// migrate.js — idempotent SQL migration runner
// Applies every sql/NNN_*.sql file in lexical order, once, inside its own
// transaction, and records the result in schema_migrations.
//
// Usage:
//   node migrate.js            apply pending migrations
//   node migrate.js --status   list applied / pending, change nothing
//   node migrate.js --dry-run  print what would run, change nothing
//
// Design notes:
//   * Each file runs in ONE transaction. TimescaleDB DDL is transactional,
//     so a failed migration leaves no half-built hypertable behind.
//   * Files are hashed (sha256). If an already-applied file changes on disk,
//     the runner refuses to continue rather than silently diverging.
//   * The bootstrap table is created before anything else, so a fresh
//     database needs no manual setup.

require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pool, query, close } = require("./db");

const SQL_DIR = path.join(__dirname, "sql");

const BOOTSTRAP = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id            SERIAL PRIMARY KEY,
    filename      TEXT        NOT NULL UNIQUE,
    checksum      TEXT        NOT NULL,
    applied_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_ms   INTEGER,
    success       BOOLEAN     NOT NULL DEFAULT TRUE,
    error_message TEXT
  );
`;

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** Read sql/*.sql, sorted so 001_ runs before 002_. */
function discoverMigrations() {
  if (!fs.existsSync(SQL_DIR)) {
    throw new Error(`Migration directory not found: ${SQL_DIR}`);
  }

  return fs
    .readdirSync(SQL_DIR)
    .filter((name) => /^\d+_.+\.sql$/i.test(name))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((name) => {
      const fullPath = path.join(SQL_DIR, name);
      const sql = fs.readFileSync(fullPath, "utf8");
      return { name, fullPath, sql, checksum: sha256(sql) };
    });
}

async function ensureBootstrap() {
  await query(BOOTSTRAP);
}

async function loadApplied() {
  const { rows } = await query(
    `SELECT filename, checksum, applied_at, success
       FROM schema_migrations
      ORDER BY id`
  );
  return new Map(rows.map((row) => [row.filename, row]));
}

/** Apply one migration file inside a single transaction. */
async function applyMigration(migration) {
  const client = await pool.connect();
  const started = Date.now();

  try {
    await client.query("BEGIN");
    await client.query(migration.sql);
    const durationMs = Date.now() - started;

    await client.query(
      `INSERT INTO schema_migrations (filename, checksum, duration_ms, success)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (filename) DO UPDATE
         SET checksum = EXCLUDED.checksum,
             applied_at = now(),
             duration_ms = EXCLUDED.duration_ms,
             success = TRUE,
             error_message = NULL`,
      [migration.name, migration.checksum, durationMs]
    );

    await client.query("COMMIT");
    return durationMs;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* connection already dead — nothing to roll back */
    }

    // Record the failure on a fresh connection so the audit trail survives.
    try {
      await query(
        `INSERT INTO schema_migrations (filename, checksum, success, error_message)
         VALUES ($1, $2, FALSE, $3)
         ON CONFLICT (filename) DO UPDATE
           SET success = FALSE,
               error_message = EXCLUDED.error_message,
               applied_at = now()`,
        [migration.name, migration.checksum, err.message]
      );
    } catch (recordErr) {
      console.error("[migrate] could not record failure:", recordErr.message);
    }

    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const statusOnly = args.includes("--status");
  const dryRun = args.includes("--dry-run");

  console.log("[migrate] connecting to database...");
  const health = await query("SELECT current_database() AS db, current_user AS usr");
  console.log(
    `[migrate] connected: db=${health.rows[0].db} user=${health.rows[0].usr}`
  );

  await ensureBootstrap();
  const applied = await loadApplied();
  const migrations = discoverMigrations();

  const pending = [];
  const drifted = [];

  for (const migration of migrations) {
    const record = applied.get(migration.name);
    if (!record) {
      pending.push(migration);
    } else if (record.checksum !== migration.checksum) {
      drifted.push(migration);
    }
  }

  if (statusOnly) {
    console.log("\n[migrate] status:");
    for (const migration of migrations) {
      const record = applied.get(migration.name);
      const state = !record
        ? "PENDING"
        : record.success
        ? `APPLIED ${new Date(record.applied_at).toISOString()}`
        : "FAILED";
      console.log(`  ${migration.name.padEnd(34)} ${state}`);
    }
    console.log(
      `\n[migrate] ${applied.size} recorded, ${pending.length} pending, ${drifted.length} drifted`
    );
    return;
  }

  if (drifted.length) {
    console.error("\n[migrate] checksum drift detected — refusing to continue:");
    for (const migration of drifted) {
      console.error(`  ${migration.name}`);
    }
    console.error(
      "[migrate] An applied migration changed on disk. Add a new numbered\n" +
        "          migration instead of editing history, or reset the row in\n" +
        "          schema_migrations if the change is intentional."
    );
    process.exitCode = 1;
    return;
  }

  if (!pending.length) {
    console.log("[migrate] nothing to do — schema is up to date");
    return;
  }

  console.log(`\n[migrate] ${pending.length} migration(s) to apply:`);
  for (const migration of pending) {
    console.log(`  - ${migration.name}`);
  }

  if (dryRun) {
    console.log("\n[migrate] dry run — no changes made");
    return;
  }

  console.log("");
  for (const migration of pending) {
    process.stdout.write(`[migrate] applying ${migration.name} ... `);
    try {
      const durationMs = await applyMigration(migration);
      console.log(`ok (${durationMs}ms)`);
    } catch (err) {
      console.log("FAILED");
      console.error(`[migrate] ${migration.name}: ${err.message}`);
      if (err.detail) console.error(`[migrate] detail: ${err.detail}`);
      if (err.hint) console.error(`[migrate] hint: ${err.hint}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log("\n[migrate] all migrations applied");
}

main()
  .catch((err) => {
    const detail = err.message || err.code || err.name || String(err);
    console.error("[migrate] fatal:", detail);
    if (err.code === "ECONNREFUSED") {
      console.error(
        "[migrate] no PostgreSQL server is listening. Start it, or point\n" +
          "          DB_HOST / DB_PORT at a running instance in .env."
      );
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await close();
  });
