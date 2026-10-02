// Differential check: event-derived indexer state vs. the contracts themselves, at the SAME block.
//
// Reads the block the indexer has fully processed from Ponder's /status, then reads every
// table's getters at exactly that block (multicall) and compares field by field, plus the number
// of not-taken-back moves against plyCount. Needs no archive node as long as the indexer is near
// the chain head (the read block is then within the ~128-block state window of a full node).
//
//   node scripts/verify.ts            # env: INDEXER_URL, PONDER_RPC_URLS | PONDER_RPC_URL_POLYGON, CHAIN_ID
//
// Exit codes: 0 = all tables match, 1 = divergence found, 2 = could not verify (RPC/indexer).

import { createPublicClient, defineChain, fallback, http, parseAbi, type Address } from "viem";

const INDEXER_URL = (process.env.INDEXER_URL ?? "http://127.0.0.1:42069").replace(/\/$/, "");
const RPC_URLS = (process.env.PONDER_RPC_URLS ?? process.env.PONDER_RPC_URL_POLYGON ?? "http://127.0.0.1:8545")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 137);
const MULTICALL3 = (process.env.MULTICALL3_ADDRESS ?? "0xcA11bde05977b3631167028862bE2a173976CA11") as Address;
const TABLES_PER_MULTICALL = Number(process.env.VERIFY_TABLES_PER_MULTICALL ?? 20);

const client = createPublicClient({
  chain: defineChain({
    id: CHAIN_ID,
    name: `chain-${CHAIN_ID}`,
    nativeCurrency: { name: "native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: RPC_URLS } },
    contracts: { multicall3: { address: MULTICALL3 } },
  }),
  transport: fallback(RPC_URLS.map((u) => http(u, { timeout: 30_000, retryCount: 2 }))),
});

// Field name in the indexer == getter name on ChessGameTable.
const GETTERS = parseAbi([
  "function mode() view returns (uint8)",
  "function status() view returns (uint8)",
  "function result() view returns (uint8)",
  "function plyCount() view returns (uint16)",
  "function pot() view returns (uint256)",
  "function currentStake() view returns (uint256)",
  "function baseStake() view returns (uint256)",
  "function whiteToMove() view returns (bool)",
  "function lastMoveTimestamp() view returns (uint64)",
  "function whitePlayer() view returns (address)",
  "function blackPlayer() view returns (address)",
  "function totalWhiteContribution() view returns (uint256)",
  "function totalBlackContribution() view returns (uint256)",
  "function rampPly() view returns (uint32)",
  "function moveTimeout() view returns (uint32)",
  "function curve() view returns (uint8)",
  "function compoundRateBps() view returns (uint256)",
  "function protocolFeeBps() view returns (uint16)",
  "function protocolFeeRecipient() view returns (address)",
  "function referralFeeBps() view returns (uint16)",
  "function token() view returns (address)",
  "function frontendRecipient() view returns (address)",
]);
const FIELDS = GETTERS.map((g) => g.name);

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${INDEXER_URL}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data as T;
}

type Row = Record<string, unknown> & { id: string };

async function allTables(): Promise<Row[]> {
  const rows: Row[] = [];
  let after: string | null = null;
  do {
    const data: { tables: { items: Row[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } =
      await gql(
        `query ($after: String) { tables(limit: 1000, after: $after) {
          items { id ${FIELDS.join(" ")} } pageInfo { hasNextPage endCursor } } }`,
        { after },
      );
    rows.push(...data.tables.items);
    after = data.tables.pageInfo.hasNextPage ? data.tables.pageInfo.endCursor : null;
  } while (after);
  return rows;
}

async function liveMoveCount(tableId: string): Promise<number> {
  let n = 0;
  let after: string | null = null;
  do {
    const data: { moves: { items: { takenBack: boolean }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } =
      await gql(
        `query ($t: String!, $after: String) { moves(where: { tableId: $t }, limit: 1000, after: $after) {
          items { takenBack } pageInfo { hasNextPage endCursor } } }`,
        { t: tableId, after },
      );
    n += data.moves.items.filter((m) => !m.takenBack).length;
    after = data.moves.pageInfo.hasNextPage ? data.moves.pageInfo.endCursor : null;
  } while (after);
  return n;
}

const norm = (v: unknown) =>
  typeof v === "string" && v.startsWith("0x") ? v.toLowerCase() : typeof v === "bigint" ? v.toString() : String(v);

async function main() {
  const statusRes = await fetch(`${INDEXER_URL}/status`);
  const status = (await statusRes.json()) as Record<string, { id: number; block: { number: number } | null }>;
  const chain = Object.values(status).find((c) => c.id === CHAIN_ID) ?? Object.values(status)[0];
  if (!chain?.block) throw new Error(`indexer reports no indexed block yet: ${JSON.stringify(status)}`);
  const blockNumber = BigInt(chain.block.number);
  const head = await client.getBlockNumber();
  console.log(`indexer block ${blockNumber}, chain head ${head}, lag ${head - blockNumber}`);

  const tables = await allTables();
  let divergences = 0;
  for (let i = 0; i < tables.length; i += TABLES_PER_MULTICALL) {
    const chunk = tables.slice(i, i + TABLES_PER_MULTICALL);
    const contracts = chunk.flatMap((t) =>
      GETTERS.map((g) => ({ address: t.id as Address, abi: GETTERS, functionName: g.name })),
    );
    // VERIFY_NO_MULTICALL=1 for chains without Multicall3 (e.g. a bare anvil).
    const results = process.env.VERIFY_NO_MULTICALL
      ? await Promise.all(contracts.map((c) => client.readContract({ ...c, blockNumber })))
      : await client.multicall({ contracts, blockNumber, allowFailure: false });
    for (const [j, t] of chunk.entries()) {
      for (const [k, field] of FIELDS.entries()) {
        const onchain = norm(results[j * FIELDS.length + k]);
        const local = norm(t[field]);
        if (onchain !== local) {
          divergences++;
          console.log(`REPLAY DIVERGENCE table=${t.id} block=${blockNumber} field=${field} local=${local} onchain=${onchain}`);
        }
      }
      const live = await liveMoveCount(t.id);
      if (live !== Number(t.plyCount)) {
        divergences++;
        console.log(`REPLAY DIVERGENCE table=${t.id} block=${blockNumber} field=liveMoves local=${live} plyCount=${t.plyCount}`);
      }
    }
  }
  console.log(`verified ${tables.length} table(s) x ${FIELDS.length + 1} checks at block ${blockNumber}: ${divergences} divergence(s)`);
  process.exit(divergences === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`verify failed: ${err?.shortMessage ?? err?.message ?? err}`);
  process.exit(2);
});
