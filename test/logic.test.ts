import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";

import {
  applyFinish,
  applyMove,
  applyStakeIncrease,
  applyTakeback,
  computeCompoundRateBps,
  Curve,
  decodeCreateCalldata,
  FACTORY_CREATE_ABI,
  initialState,
  injectMovesLimit,
  Mode,
  nextStake,
  ZERO_ADDRESS,
  type CreateConfig,
} from "../src/logic.ts";

const A = "0x00000000000000000000000000000000000000aa" as const;
const B = "0x00000000000000000000000000000000000000bb" as const;
const C = "0x00000000000000000000000000000000000000cc" as const;
const FACTORY = "0x532408070454d13ed7ef142fb0fb86247ea3d7e0" as const;
const E18 = 10n ** 18n;

const duel = (over: Partial<CreateConfig> = {}): CreateConfig => ({
  mode: Mode.Duel,
  whitePlayer: A,
  blackPlayer: ZERO_ADDRESS,
  baseStake: E18,
  rampPly: 20,
  moveTimeout: 600n,
  curve: Curve.Linear,
  frontendRecipient: C,
  referralFeeBps: 100,
  token: ZERO_ADDRESS,
  ...over,
});

test("linear stake grows by baseStake*9/rampPly and caps at 10x", () => {
  const s = initialState(duel(), 1n);
  assert.equal(nextStake(s, E18), E18 + (E18 * 9n) / 20n);
  assert.equal(nextStake(s, 10n * E18), 10n * E18);
});

test("flat stake never grows", () => {
  const s = initialState(duel({ curve: Curve.Flat }), 1n);
  assert.equal(nextStake(s, E18), E18);
});

test("compound rate reaches 10x within rampPly and stake follows it", () => {
  for (const ramp of [20, 50, 200, 9999]) {
    const r = computeCompoundRateBps(ramp);
    assert.ok(r >= 1n && r <= 5000n, `rate for ${ramp} = ${r}`);
    // (1+r)^ramp >= 10 but (1+(r-1))^ramp < 10 -- the binary search's defining property
    const grow = (bps: bigint) => {
      let g = E18;
      for (let i = 0; i < ramp && g < 1000n * E18; i++) g = (g * (E18 + (bps * E18) / 10000n)) / E18;
      return g;
    };
    assert.ok(grow(r) >= 10n * E18);
    if (r > 1n) assert.ok(grow(r - 1n) < 10n * E18);
  }
  const s = initialState(duel({ curve: Curve.Compound, rampPly: 50 }), 1n);
  assert.equal(s.compoundRateBps, computeCompoundRateBps(50));
  assert.equal(nextStake(s, E18), (E18 * (10000n + s.compoundRateBps)) / 10000n);
});

test("duel move claims the vacant seat, accumulates pot, flips turn", () => {
  let s = initialState(duel(), 100n);
  ({ state: s } = applyMove(s, { mover: A, stakePaid: E18, timestamp: 101n }));
  assert.equal(s.whitePlayer, A);
  assert.equal(s.blackPlayer, ZERO_ADDRESS);
  const r = applyMove(s, { mover: B, stakePaid: s.currentStake, timestamp: 102n });
  assert.equal(r.moverWasWhite, false);
  assert.equal(r.state.blackPlayer, B);
  assert.equal(r.state.plyCount, 2);
  assert.equal(r.state.whiteToMove, true);
  assert.equal(r.state.pot, E18 + s.currentStake);
  assert.equal(r.state.lastMoveTimestamp, 102n);
  assert.equal(r.state.totalWhiteContribution, 0n); // Duel never tracks contributions
});

test("takeback restores snapshot: stake=refunded, pot, ply, turn; seat kept", () => {
  let s = initialState(duel(), 100n);
  ({ state: s } = applyMove(s, { mover: A, stakePaid: E18, timestamp: 101n }));
  const before = s;
  ({ state: s } = applyMove(s, { mover: B, stakePaid: before.currentStake, timestamp: 102n }));
  const { state: t, undoneMoveWasWhite } = applyTakeback(s, { refunded: before.currentStake, timestamp: 103n });
  assert.equal(undoneMoveWasWhite, false);
  assert.equal(t.pot, before.pot);
  assert.equal(t.plyCount, before.plyCount);
  assert.equal(t.whiteToMove, before.whiteToMove);
  assert.equal(t.currentStake, before.currentStake);
  assert.equal(t.blackPlayer, B); // seats are never reverted on-chain
  assert.equal(t.lastMoveTimestamp, 103n);
});

test("crowd contributions follow mover side and takeback refunds that side", () => {
  let s = initialState({ ...duel(), mode: Mode.Crowd, whitePlayer: ZERO_ADDRESS }, 1n);
  ({ state: s } = applyMove(s, { mover: A, stakePaid: E18, timestamp: 2n }));
  ({ state: s } = applyMove(s, { mover: B, stakePaid: 2n * E18, timestamp: 3n }));
  assert.equal(s.totalWhiteContribution, E18);
  assert.equal(s.totalBlackContribution, 2n * E18);
  assert.equal(s.whitePlayer, ZERO_ADDRESS);
  const { state: t } = applyTakeback(s, { refunded: 2n * E18, timestamp: 4n });
  assert.equal(t.totalBlackContribution, 0n);
  assert.equal(t.totalWhiteContribution, E18);
  assert.equal(t.pot, E18);
});

test("stake increase clamps current stake into [base, 10*base]", () => {
  const s = { ...initialState(duel(), 1n), currentStake: 3n * E18 };
  assert.equal(applyStakeIncrease(s, 5n * E18).currentStake, 5n * E18);
  assert.equal(applyStakeIncrease(s, 2n * E18).currentStake, 3n * E18);
  assert.equal(applyStakeIncrease({ ...s, currentStake: 100n * E18 }, 2n * E18).currentStake, 20n * E18);
  assert.equal(applyStakeIncrease(s, 5n * E18).baseStake, 5n * E18);
});

test("finish zeroes pot", () => {
  const s = { ...initialState(duel(), 1n), pot: 7n };
  const f = applyFinish(s, 2);
  assert.deepEqual([f.status, f.result, f.pot], [1, 2, 0n]);
});

test("decodes createDuelTable / createCrowdTable calldata, rejects wrappers", () => {
  const duelInput = encodeFunctionData({
    abi: FACTORY_CREATE_ABI,
    functionName: "createDuelTable",
    args: [A, ZERO_ADDRESS, E18, 30, 600, 1, C, 50, ZERO_ADDRESS],
  });
  const d = decodeCreateCalldata({ to: FACTORY, input: duelInput }, FACTORY);
  assert.ok(d);
  assert.equal(d.mode, Mode.Duel);
  assert.equal(d.whitePlayer.toLowerCase(), A);
  assert.equal(d.baseStake, E18);
  assert.equal(d.rampPly, 30);
  assert.equal(d.moveTimeout, 600n);
  assert.equal(d.curve, 1);
  assert.equal(d.referralFeeBps, 50);

  const crowdInput = encodeFunctionData({
    abi: FACTORY_CREATE_ABI,
    functionName: "createCrowdTable",
    args: [2n * E18, 40, 0, 2, C, 0, B],
  });
  const c = decodeCreateCalldata({ to: FACTORY.toUpperCase().replace("0X", "0x") as `0x${string}`, input: crowdInput }, FACTORY);
  assert.ok(c);
  assert.equal(c.mode, Mode.Crowd);
  assert.equal(c.whitePlayer, ZERO_ADDRESS);
  assert.equal(c.token.toLowerCase(), B);

  assert.equal(decodeCreateCalldata({ to: C, input: duelInput }, FACTORY), null); // via wrapper
  assert.equal(decodeCreateCalldata({ to: null, input: duelInput }, FACTORY), null);
  assert.equal(decodeCreateCalldata({ to: FACTORY, input: "0xdeadbeef" }, FACTORY), null);
});

test("injectMovesLimit adds limit only where missing", () => {
  const ui = `query ($table: String!) { moves(where: { tableId: $table }, orderBy: "blockNumber", orderDirection: "asc") { items { plyIndex } } }`;
  assert.match(injectMovesLimit(ui), /moves\(limit: 1000, where: \{ tableId: \$table \}, orderBy/);
  const limited = `{ moves(limit: 5) { items { id } } }`;
  assert.equal(injectMovesLimit(limited), limited);
  assert.equal(injectMovesLimit(`{ moves { items { id } } }`), `{ moves(limit: 1000) { items { id } } }`);
  assert.equal(injectMovesLimit(`{ moves() { items { id } } }`), `{ moves(limit: 1000) { items { id } } }`);
  const other = `{ tables(limit: 1000) { items { id } } }`;
  assert.equal(injectMovesLimit(other), other);
});
