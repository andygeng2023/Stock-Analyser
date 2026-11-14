import pg from "pg";
import worker from "../cloudflare/worker.js";

const { Pool } = pg;
let pool;

function getPool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured.");
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 4,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
      statement_timeout: 25000,
      application_name: "stock-analyser-api"
    });
    pool.on("error", (error) => console.error("TiDB pool error:", error));
  }
  return pool;
}

function translateSql(source) {
  let sql = String(source).trim();
  let ignoreConflict = false;

  if (/^INSERT\\s+OR\\s+IGNORE\\s+INTO/i.test(sql)) {
    sql = sql.replace(/^INSERT\\s+OR\\s+IGNORE\\s+INTO/i, "INSERT INTO");
    ignoreConflict = true;
  }

  // Emails are normalized to lowercase on account creation and login.
  sql = sql.replace(/\\s+COLLATE\\s+NOCASE/ig, "");

  let index = 0;
  sql = sql.replace(/\\?/g, () => "$" + (++index));

  if (ignoreConflict && !/ON\\s+CONFLICT/i.test(sql)) sql += " ON CONFLICT DO NOTHING";
  return sql;
}

class PGStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }
  bind(...values) {
    this.values = values;
    return this;
  }
  async first() {
    const result = await this.database.pool.query(translateSql(this.sql), this.values);
    return result.rows[0] ?? null;
  }
  async all() {
    const result = await this.database.pool.query(translateSql(this.sql), this.values);
    return { results: result.rows };
  }
  async run() {
    const result = await this.database.pool.query(translateSql(this.sql), this.values);
    return { meta: { changes: result.rowCount ?? 0 } };
  }
}

class PGDatabase {
  constructor(pool) {
    this.pool = pool;
  }
  prepare(sql) {
    return new PGStatement(this, sql);
  }
  async batch(statements) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const results = [];
      for (const statement of statements) {
        const result = await client.query(translateSql(statement.sql), statement.values);
        results.push({ meta: { changes: result.rowCount ?? 0 } });
      }
      await client.query("COMMIT");
      return results;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export default {
  async fetch(request) {
    try {
      const env = {
        DB: new PGDatabase(getPool()),
        ADMIN_API_TOKEN: process.env.ADMIN_API_TOKEN,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN
      };
      return await worker.fetch(request, env, { waitUntil() {} });
    } catch (error) {
      console.error("Stock Analyser API bootstrap error:", error);
      return new Response(JSON.stringify({ error: "The API is not configured correctly." }), {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store"
        }
      });
    }
  }
};
