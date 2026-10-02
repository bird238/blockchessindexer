// End-to-end test against the real (deployed-version) contracts on a history-pruned anvil.
//
//   CONTRACTS_OUT=/path/to/blockchess/out node e2e/run.ts
//
// 1. Starts anvil with --prune-history, so (like a public full node) any eth_call at an old
//    block fails -- asserted explicitly below.
// 2. Deploys ChessGameFactory + ChessEloRegistry (+ a test Forwarder) and plays scripted games
//    covering every reducer path: vacant-seat claim, Duel takeback, stake increase, resign, ELO,
//    Crowd group-vote takeback with several backers, Compound and Flat curves, and a table created
//    through a wrapper contract (calldata fallback path).
// 3. Mines past the pruning window, THEN starts the indexer from scratch: the whole sync is a
//    backfill over pruned history -- exactly what used to hang the old indexer.
// 4. Runs scripts/verify.ts (indexer vs contract at the same block) and UI-shaped GraphQL checks,
//    then plays more moves while the indexer is live and verifies again (realtime path).

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert/strict";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  parseEventLogs,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

const OUT = process.env.CONTRACTS_OUT ?? "";
if (!OUT) throw new Error("set CONTRACTS_OUT to the forge `out` dir of github.com/bird238/blockchess");
const ANVIL = process.env.ANVIL_BIN ?? `${process.env.HOME}/.foundry/bin/anvil`;
const RPC_PORT = Number(process.env.E2E_RPC_PORT ?? 8546);
const API_PORT = Number(process.env.E2E_API_PORT ?? 42169);
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;
const ROOT = new URL("..", import.meta.url).pathname;

const artifact = (name: string) => {
  const j = JSON.parse(readFileSync(`${OUT}/${name}.sol/${name}.json`, "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
};
const Factory = artifact("ChessGameFactory");
const Table = artifact("ChessGameTable");
const Elo = artifact("ChessEloRegistry");
const Forwarder = artifact("Forwarder");

// anvil's default dev keys (mnemonic "test test ... junk")
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
] as const;
type P = PrivateKeyAccount;
const accounts: P[] = KEYS.map((k) => privateKeyToAccount(k));
const acct = accounts as [P, P, P, P, P, P, P, P, P, P];
const account = (i: number) => {
  const a = accounts[i];
  if (!a) throw new Error(`no dev account ${i}`);
  return a;
};
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const E15 = 10n ** 15n;

const chain = defineChain({
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC), cacheTime: 0 });
const wallet = (i: number) => createWalletClient({ account: account(i), chain, transport: http(RPC) });

const children: ChildProcess[] = [];
const cleanup = () => children.forEach((c) => c.kill("SIGTERM"));
process.on("exit", cleanup);

async function send(i: number, address: Address, abi: Abi, functionName: string, args: unknown[] = [], value = 0n) {
  const hash = await wallet(i).writeContract({ address, abi, functionName, args, value, chain, account: account(i) });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `${functionName} reverted`);
  return receipt;
}

async function deploy(art: { abi: Abi; bytecode: Hex }, args: unknown[] = []) {
  const hash = await wallet(0).deployContract({ abi: art.abi, bytecode: art.bytecode, args, chain, account: acct[0] });
  const r = await pub.waitForTransactionReceipt({ hash });
  return r.contractAddress as Address;
}

const tableFromReceipt = (r: { logs: any[] }) =>
  (parseEventLogs({ abi: Factory.abi, logs: r.logs, eventName: "TableCreated" })[0] as any).args.table as Address;

async function move(i: number, table: Address, from: number, to: number) {
  const stake = (await pub.readContract({ address: table, abi: Table.abi, functionName: "currentStake" })) as bigint;
  return send(i, table, Table.abi, "makeMove", [from, to, 0], stake);
}

// squares: a1=0 ... h8=63
const SQ = (s: string) => (s.charCodeAt(0) - 97) + 8 * (Number(s[1]) - 1);

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data;
}

async function waitIndexed(minBlock: bigint, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ready = await fetch(`${API}/ready`);
      if (ready.ok) {
        const status = (await (await fetch(`${API}/status`)).json()) as Record<string, { block: { number: number } | null }>;
        const b = Object.values(status)[0]?.block?.number;
        if (b !== undefined && BigInt(b) >= minBlock) return;
      }
    } catch {
      // indexer not up yet
    }
    await sleep(1000);
  }
  throw new Error(`indexer did not reach block ${minBlock} in time`);
}

function runVerify(env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["scripts/verify.ts"], { cwd: ROOT, env, stdio: "inherit" });
    p.on("exit", (code) => resolve(code ?? 2));
  });
}

async function main() {
  // ---- 1. pruned anvil
  const anvil = spawn(ANVIL, ["--port", String(RPC_PORT), "--prune-history", "8", "--silent"], { stdio: "inherit" });
  children.push(anvil);
  for (let i = 0; i < 50; i++) {
    try {
      await pub.getBlockNumber();
      break;
    } catch {
      await sleep(200);
    }
  }

  // ---- 2. deploy + scripted games
  const factory = await deploy(Factory, [acct[0].address, acct[9].address, 250]);
  const elo = await deploy(Elo, [factory]);
  const forwarder = await deploy(Forwarder);
  const startBlock = (await pub.getBlockNumber()) - 3n;

  // Table A: Duel, Linear, black seat vacant (public challenge), created directly.
  const rA = await send(1, factory, Factory.abi, "createDuelTable", [
    acct[1].address, ZERO, E15, 20, 3600, 0, acct[8].address, 100, ZERO,
  ]);
  const A = tableFromReceipt(rA);
  await move(1, A, SQ("e2"), SQ("e4"));
  await move(2, A, SQ("e7"), SQ("e5")); // acct2 claims the vacant black seat
  await move(1, A, SQ("g1"), SQ("f3"));
  await move(2, A, SQ("b8"), SQ("c6"));
  await send(2, A, Table.abi, "proposeTakeback");
  await send(1, A, Table.abi, "acceptTakeback"); // undoes Nc6
  await move(2, A, SQ("g8"), SQ("f6"));
  await send(1, A, Table.abi, "proposeStakeIncrease", [3n * E15]);
  await send(2, A, Table.abi, "acceptStakeIncrease");
  await move(1, A, SQ("f1"), SQ("c4"));
  await move(2, A, SQ("f6"), SQ("e4")); // capture
  await send(1, A, Table.abi, "resign"); // black wins
  await send(3, elo, Elo.abi, "recordResult", [A]);

  // Table B: Crowd, Compound, several backers, group-vote takeback.
  const rB = await send(3, factory, Factory.abi, "createCrowdTable", [2n * E15, 30, 0, 1, acct[8].address, 0, ZERO]);
  const B = tableFromReceipt(rB);
  await move(3, B, SQ("e2"), SQ("e4"));
  await move(4, B, SQ("e7"), SQ("e5"));
  await move(5, B, SQ("d2"), SQ("d4"));
  await move(4, B, SQ("e5"), SQ("d4"));
  await send(3, B, Table.abi, "proposeTakeback");
  await send(3, B, Table.abi, "voteOnGroupProposal", [true]);
  await send(5, B, Table.abi, "voteOnGroupProposal", [true]);
  await send(4, B, Table.abi, "voteOnGroupProposal", [true]); // passes -> TakebackAccepted
  await move(6, B, SQ("g8"), SQ("f6")); // second black backer

  // Table C: Duel, Flat, both seats set, created THROUGH a wrapper contract.
  const createC = encodeFunctionData({
    abi: Factory.abi,
    functionName: "createDuelTable",
    args: [acct[1].address, acct[7].address, E15, 20, 600, 2, acct[8].address, 0, ZERO],
  });
  const rC = await send(1, forwarder, Forwarder.abi, "forward", [factory, createC]);
  const C = tableFromReceipt(rC);
  await move(1, C, SQ("e2"), SQ("e4"));
  await move(7, C, SQ("e7"), SQ("e5"));

  // ---- 3. move far past the pruning window and prove old state is gone
  await pub.request({ method: "anvil_mine" as any, params: ["0x12c"] as any }); // 300 blocks
  let historicalFailed = false;
  try {
    await pub.readContract({ address: A, abi: Table.abi, functionName: "pot", blockNumber: rA.blockNumber + 2n });
  } catch {
    historicalFailed = true;
  }
  assert.ok(historicalFailed, "anvil is expected to reject historical eth_call (pruned history)");
  console.log("[e2e] pruned history confirmed: historical eth_call fails, as on a public full node");

  const env = {
    ...process.env,
    CHAIN_ID: "31337",
    PONDER_RPC_URLS: RPC,
    FACTORY_ADDRESS: factory,
    ELO_REGISTRY_ADDRESS: elo,
    START_BLOCK: String(startBlock),
    INDEXER_URL: API,
    VERIFY_NO_MULTICALL: "1",
    DATABASE_URL: "",
    PGLITE_DIR: `${ROOT}/.ponder/e2e-pglite`,
  };
  if (process.env.E2E_STOP_AFTER_SETUP) {
    // Leaves anvil running with the scripted history, for pointing another indexer build at it.
    console.log(`[e2e] setup only: RPC=${RPC} FACTORY_ADDRESS=${factory} ELO_REGISTRY_ADDRESS=${elo} START_BLOCK=${startBlock}`);
    process.removeListener("exit", cleanup);
    anvil.unref();
    process.exit(0);
  }
  // Own PGlite directory: never touches a dev/indexer database in the default .ponder/pglite.
  rmSync(env.PGLITE_DIR, { recursive: true, force: true });
  const indexer = spawn(
    process.execPath,
    [`${ROOT}/node_modules/ponder/dist/esm/bin/ponder.js`, "start", "--schema", "e2e", "--port", String(API_PORT)],
    { cwd: ROOT, env, stdio: ["ignore", "inherit", "inherit"] },
  );
  children.push(indexer);
  await waitIndexed(await pub.getBlockNumber());
  console.log("[e2e] backfill over pruned history completed");

  // ---- 4. verification
  assert.equal(await runVerify(env), 0, "verify after backfill");

  const moves = (await gql<{ moves: { items: any[] } }>(
    `query ($table: String!) { moves(where: { tableId: $table }, orderBy: "blockNumber", orderDirection: "asc") {
      items { plyIndex mover fromSquare toSquare promotion stakePaid takenBack potAfter txHash } } }`,
    { table: A.toLowerCase() },
  )).moves.items;
  assert.deepEqual(moves.map((m) => [m.plyIndex, m.takenBack]), [
    [1, false], [2, false], [3, false], [4, true], [4, false], [5, false], [6, false],
  ]);
  const live = moves.filter((m) => !m.takenBack);
  const potBeforeFinish = live.reduce((s, m) => s + BigInt(m.stakePaid), 0n);
  assert.equal(BigInt(live.at(-1)!.potAfter), potBeforeFinish, "potAfter = sum of live stakes");

  const tables = (await gql<{ tables: { items: any[] } }>(
    `{ tables(orderBy: "createdAtBlock", orderDirection: "desc", limit: 1000) { items {
      id blackPlayer status result whiteBackerCount blackBackerCount configSource } } }`,
  )).tables.items;
  const byId: Record<string, any> = Object.fromEntries(tables.map((t) => [t.id, t]));
  const row = (addr: Address) => byId[addr.toLowerCase()]!;
  assert.equal(row(A).blackPlayer, acct[2].address.toLowerCase());
  assert.deepEqual([row(A).status, row(A).result], [1, 2]);
  assert.deepEqual([row(B).whiteBackerCount, row(B).blackBackerCount], [2, 2]);
  assert.equal(row(A).configSource, "calldata");
  assert.equal(row(C).configSource, "latest");

  const backers = (await gql<{ backers: { items: any[] } }>(
    `query ($table: String!) { backers(where: { tableId: $table }, limit: 1000) { items { id tableId address isWhite } } }`,
    { table: B.toLowerCase() },
  )).backers.items;
  assert.equal(backers.length, 4);
  const ratings = (await gql<{ ratings: { items: any[] } }>(`{ ratings(limit: 1000) { items { id value } } }`)).ratings.items;
  assert.equal(ratings.length, 2, "both Duel players rated");

  const addTable = async (txHash: string) =>
    (await fetch(`${API}/add-table`, { method: "POST", body: JSON.stringify({ txHash }) })).json() as Promise<any>;
  assert.deepEqual(await addTable(rA.transactionHash), { ok: true, table: A.toLowerCase(), indexed: true });
  assert.equal((await addTable(rC.transactionHash)).table, C.toLowerCase()); // wrapper tx still decodes
  assert.equal((await addTable("0x1234")).ok, false);
  console.log("[e2e] UI-shaped GraphQL + /add-table checks passed");

  // ---- 5. realtime: keep playing while the indexer is live
  await move(1, C, SQ("g1"), SQ("f3"));
  await move(7, C, SQ("b8"), SQ("c6"));
  await send(7, C, Table.abi, "proposeTakeback");
  await send(1, C, Table.abi, "acceptTakeback");
  await move(7, C, SQ("g8"), SQ("f6"));
  await move(5, B, SQ("g1"), SQ("f3"));
  await waitIndexed(await pub.getBlockNumber());
  assert.equal(await runVerify(env), 0, "verify after realtime moves");

  console.log("[e2e] ALL CHECKS PASSED");
  cleanup();
  process.exit(0);
}

main().catch((err) => {
  console.error("[e2e] FAILED:", err);
  cleanup();
  process.exit(1);
});
