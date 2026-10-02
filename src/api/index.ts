import { db } from "ponder:api";
import schema from "ponder:schema";
import { client, eq, graphql } from "ponder";
import { Hono, type MiddlewareHandler } from "hono";
import { decodeEventLog, parseAbiItem } from "viem";

import { FACTORY_ADDRESS } from "../env";
import { injectMovesLimit } from "../logic";
import { latestClient } from "../rpc";

const app = new Hono();

app.use("/sql/*", client({ db, schema }));

// blockchess-ui sends `moves(...)` without `limit`; Ponder's GraphQL default is 50 rows, which
// would truncate long games. Rewrite the query before handing the request to Ponder's handler.
const gql = graphql({ db, schema });
const MAX_BODY_BYTES = 64 * 1024;

const graphqlWithMovesLimit: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "POST") {
    if (Number(c.req.header("content-length") ?? 0) > MAX_BODY_BYTES) {
      return c.json({ errors: [{ message: "request too large" }] }, 413);
    }
    const raw = await c.req.raw.clone().text();
    if (raw.length > MAX_BODY_BYTES) return c.json({ errors: [{ message: "request too large" }] }, 413);
    try {
      const body = JSON.parse(raw);
      if (body && typeof body.query === "string" && /\bmoves\b/.test(body.query)) {
        body.query = injectMovesLimit(body.query);
        c.req.raw = new Request(c.req.raw.url, {
          method: "POST",
          headers: c.req.raw.headers,
          body: JSON.stringify(body),
        });
      }
    } catch {
      // not JSON -- let Ponder's handler produce the proper GraphQL error
    }
  }
  return gql(c, next);
};

app.use("/", graphqlWithMovesLimit);
app.use("/graphql", graphqlWithMovesLimit);

// POST /add-table {txHash} -- backs blockchess-ui's "paste creation tx" button. The factory
// pattern discovers every table by itself, so this only validates the transaction and reports
// whether the table is already indexed; it never mutates indexer state.
const TABLE_CREATED = parseAbiItem(
  "event TableCreated(address indexed table, uint8 mode, address indexed creator, address frontendRecipient)",
);
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

// Tiny fixed-window rate limit per client IP: each call costs one RPC request.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;
const hits = new Map<string, { count: number; resetAt: number }>();
let nextSweepAt = 0;

// The client controls the FIRST X-Forwarded-For entry, so key on what the reverse proxy itself
// sets: X-Real-IP, else the last XFF hop.
const clientIp = (realIp?: string, xff?: string) => realIp?.trim() || xff?.split(",").at(-1)?.trim() || "local";

app.post("/add-table", async (c) => {
  const now = Date.now();
  if (now >= nextSweepAt) {
    for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
    nextSweepAt = now + RATE_WINDOW_MS;
  }
  const ip = clientIp(c.req.header("x-real-ip"), c.req.header("x-forwarded-for"));
  const h = hits.get(ip);
  if (!h || h.resetAt < now) hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
  else if (++h.count > RATE_MAX) return c.json({ ok: false, error: "rate limited" }, 429);

  if (Number(c.req.header("content-length") ?? 0) > 1024) {
    return c.json({ ok: false, error: "request too large" }, 413);
  }
  let txHash: unknown;
  try {
    const raw = await c.req.text();
    if (raw.length > 1024) return c.json({ ok: false, error: "request too large" }, 413);
    txHash = JSON.parse(raw || "{}").txHash;
  } catch {
    return c.json({ ok: false, error: "invalid JSON body" }, 400);
  }
  if (typeof txHash !== "string" || !TX_HASH_RE.test(txHash)) {
    return c.json({ ok: false, error: "not a valid transaction hash" }, 400);
  }

  let receipt;
  try {
    receipt = await latestClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
  } catch {
    return c.json({ ok: false, error: "transaction not found" }, 400);
  }

  let table: `0x${string}` | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== FACTORY_ADDRESS.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: [TABLE_CREATED], data: log.data, topics: log.topics });
      table = decoded.args.table.toLowerCase() as `0x${string}`;
      break;
    } catch {
      // another factory event (e.g. TokenAllowlistUpdated)
    }
  }
  if (!table) {
    return c.json({ ok: false, error: "this transaction did not create a table on this factory" }, 400);
  }

  const rows = await db.select({ id: schema.table.id }).from(schema.table).where(eq(schema.table.id, table));
  return c.json({ ok: true, table, indexed: rows.length > 0 });
});

export default app;
