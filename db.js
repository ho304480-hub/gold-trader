// db.js — PostgreSQL / TimescaleDB connection layer
// Single shared pg.Pool for the whole process. Every route and job
// pulls connections from here so pool limits, timeouts and error
// handling stay in one place.
//
// Config resolution order:
//   1. DATABASE_URL (full connection string) — wins if present
//   2. Discrete DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD
//
// TimescaleDB note: the pool sets a statement_timeout so a runaway
// continuous-aggregate refresh can never pin a connection forever.

require("dotenv").config({ quiet: true });

const { Pool } = require("pg");

const num = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.DB_HOST || "localhost",
      port: num(process.env.DB_PORT, 5432),
      database: process.env.DB_NAME || "gold_terminal",
      user: process.env.DB_USER || "postgres",
      password: process.env.DB_PASSWORD || "",
    };

const pool = new Pool({
  ...poolConfig,
  max: num(process.env.DB_POOL_MAX, 10),
  idleTimeoutMillis: num(process.env.DB_IDLE_TIMEOUT_MS, 30000),
  connectionTimeoutMillis: num(process.env.DB_CONNECTION_TIMEOUT_MS, 5000),
  statement_timeout: num(process.env.DB_STATEMENT_TIMEOUT_MS, 15000),
  application_name: "gold-terminal-api",
});

// A pool-level error means an idle client died (server restart, network
// blip). Log it — never let it take the process down.
pool.on("error", (err) => {
  console.error("[db] idle client error:", err.message);
});

/**
 * Run a parameterised query on a pooled connection.
 * @param {string} text  SQL with $1, $2 ... placeholders
 * @param {Array}  params
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params = []) {
  const started = Date.now();
  try {
    const result = await pool.query(text, params);
    const elapsed = Date.now() - started;
    if (elapsed > 1000) {
      console.warn(`[db] slow query ${elapsed}ms: ${text.slice(0, 120)}`);
    }
    return result;
  } catch (err) {
    console.error(
      "[db] query failed:",
      err.message || err.code || err.name || String(err),
      "|",
      text.slice(0, 160)
    );
    throw err;
  }
}

/**
 * Run several statements inside one transaction. The callback receives a
 * dedicated client; every query inside must use it, not the pool.
 * Rolls back on any throw, always releases the client.
 *
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("[db] rollback failed:", rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Bulk insert helper using a single multi-row INSERT.
 * Builds ($1,$2),($3,$4) ... placeholders so one round trip covers
 * the whole batch. Returns the number of rows written.
 *
 * @param {string} table
 * @param {string[]} columns
 * @param {Array<Array<any>>} rows
 * @param {string} [conflictClause] e.g. "ON CONFLICT DO NOTHING"
 */
async function bulkInsert(table, columns, rows, conflictClause = "") {
  if (!rows.length) return 0;

  const values = [];
  const tuples = rows.map((row) => {
    const placeholders = row.map((value) => {
      values.push(value);
      return `$${values.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });

  const sql =
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES ` +
    `${tuples.join(", ")} ${conflictClause}`.trim();

  const result = await query(sql, values);
  return result.rowCount;
}

/** Liveness probe for /api/health. Returns server + TimescaleDB versions. */
async function healthCheck() {
  const { rows } = await query(
    `SELECT
       current_database()                       AS database,
       current_user                             AS db_user,
       version()                                AS server_version,
       (SELECT extversion FROM pg_extension
         WHERE extname = 'timescaledb')         AS timescaledb_version,
       now()                                    AS server_time`
  );
  return rows[0];
}

/** Close the pool — call from SIGINT/SIGTERM handlers. */
async function close() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  withTransaction,
  bulkInsert,
  healthCheck,
  close,
};
