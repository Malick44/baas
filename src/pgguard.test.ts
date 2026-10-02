import assert from "node:assert/strict";
import { describe, it } from "node:test";
import pg from "pg";
import { guard } from "./pgguard.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a checked-out connection whose backend is terminated", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  it("is an error on the next query, not an uncaught exception that kills the process", async () => {
    const pool = new pg.Pool({ connectionString: ADMIN, max: 2 });
    pool.on("error", () => {});
    const killer = new pg.Client({ connectionString: ADMIN });
    await killer.connect();
    const uncaught: Error[] = [];
    const listeners = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    process.on("uncaughtException", (e) => uncaught.push(e));
    try {
      for (const guarded of [true]) {
        const c = await pool.connect();
        let broken = false;
        const unguard = guarded ? guard(c, () => { broken = true; }) : () => {};
        await c.query("BEGIN");
        const pid = (c as unknown as { processID: number }).processID;
        await killer.query(`SELECT pg_terminate_backend($1)`, [pid]);
        await sleep(300); // between two queries, the way a request holding a connection sees it
        if (guarded) {
          assert.deepEqual(uncaught, [], "guarded: nothing escapes");
          assert.equal(broken, true, "and the caller is told, so the connection is discarded instead of reused");
          await assert.rejects(c.query("SELECT 1"));
        }
        unguard();
        c.release(true);
      }
    } finally {
      process.removeAllListeners("uncaughtException");
      for (const l of listeners) process.on("uncaughtException", l);
      await killer.end();
      await pool.end();
    }
  });
});
