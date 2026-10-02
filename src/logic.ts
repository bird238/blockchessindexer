// Pure, dependency-light state machine for one ChessGameTable, mirroring the deployed contract
// (github.com/bird238/blockchess, src/ChessGameTable.sol) event by event. Everything here is
// derived from event arguments alone -- no historical eth_call -- which is what lets the indexer
// backfill any block range on an ordinary pruned full node.
//
// Deliberately NOT re-implemented: chess rules / board state (ChessEngine.sol). The contract
// validates moves; the indexer only does the economic and turn bookkeeping that the contract
// fully exposes through MoveMade / TakebackAccepted / StakeIncreaseAccepted / GameFinished.
//
// Kept free of ponder imports (and of relative imports) so it runs directly under
// `node --test` for unit tests.

import { decodeFunctionData, parseAbi, type Address, type Hex } from "viem";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
export const MAX_STAKE_MULTIPLIER = 10n; // ChessGameTable.MAX_STAKE_MULTIPLIER

export const Mode = { Duel: 0, Crowd: 1 } as const;
export const Curve = { Linear: 0, Compound: 1, Flat: 2 } as const;
export const Status = { Active: 0, Finished: 1 } as const;

export type TableState = {
  mode: number;
  status: number;
  result: number;
  curve: number;
  rampPly: number;
  compoundRateBps: bigint;
  baseStake: bigint;
  currentStake: bigint;
  plyCount: number;
  pot: bigint;
  whiteToMove: boolean;
  lastMoveTimestamp: bigint;
  whitePlayer: Address;
  blackPlayer: Address;
  totalWhiteContribution: bigint;
  totalBlackContribution: bigint;
};

// ---------------------------------------------------------------------------------------------
// Stake curve -- exact integer ports of the contract's math.

/** Port of ChessGameTable._powWadCapped. */
function powWadCapped(baseWad: bigint, n: number, cap: bigint): bigint {
  let grown = 10n ** 18n;
  for (let i = 0; i < n; i++) {
    grown = (grown * baseWad) / 10n ** 18n;
    if (grown >= cap) return cap;
  }
  return grown;
}

/** Port of ChessGameTable._computeCompoundRateBps (fixed 40-iteration binary search). */
export function computeCompoundRateBps(rampPly: number): bigint {
  let lo = 1n;
  let hi = 5000n;
  for (let iter = 0; iter < 40; iter++) {
    const mid = (lo + hi) / 2n;
    const baseWad = 10n ** 18n + (mid * 10n ** 18n) / 10000n;
    const grown = powWadCapped(baseWad, rampPly, 1000n * 10n ** 18n);
    if (grown < 10n * 10n ** 18n) {
      lo = mid + 1n;
    } else {
      hi = mid;
    }
  }
  return hi;
}

/** Stake owed by the NEXT move, given the stake the current move just paid (makeMove tail). */
export function nextStake(
  s: Pick<TableState, "curve" | "baseStake" | "rampPly" | "compoundRateBps">,
  stakePaid: bigint,
): bigint {
  const cap = s.baseStake * MAX_STAKE_MULTIPLIER;
  let next: bigint;
  if (s.curve === Curve.Flat) {
    next = stakePaid;
  } else if (s.curve === Curve.Linear) {
    next = stakePaid + (s.baseStake * (MAX_STAKE_MULTIPLIER - 1n)) / BigInt(s.rampPly);
  } else {
    next = (stakePaid * (10000n + s.compoundRateBps)) / 10000n;
  }
  return next > cap ? cap : next;
}

// ---------------------------------------------------------------------------------------------
// Event reducers. Each returns a new state; callers persist it.

export type MoveOutcome = {
  state: TableState;
  /** Colour that made this move (= whiteToMove BEFORE the move). */
  moverWasWhite: boolean;
};

/** MoveMade(mover, from, to, promotion, stakePaid). */
export function applyMove(
  s: TableState,
  e: { mover: Address; stakePaid: bigint; timestamp: bigint },
): MoveOutcome {
  const moverWasWhite = s.whiteToMove;
  const next: TableState = { ...s };

  // Duel: a vacant seat (public challenge) is permanently claimed by whoever moves first for
  // that colour. Crowd tables never set whitePlayer/blackPlayer on-chain.
  if (s.mode === Mode.Duel) {
    if (moverWasWhite && s.whitePlayer === ZERO_ADDRESS) next.whitePlayer = e.mover;
    if (!moverWasWhite && s.blackPlayer === ZERO_ADDRESS) next.blackPlayer = e.mover;
  } else {
    if (moverWasWhite) next.totalWhiteContribution = s.totalWhiteContribution + e.stakePaid;
    else next.totalBlackContribution = s.totalBlackContribution + e.stakePaid;
  }

  next.pot = s.pot + e.stakePaid;
  next.plyCount = s.plyCount + 1;
  next.whiteToMove = !s.whiteToMove;
  next.lastMoveTimestamp = e.timestamp;
  // stakePaid IS the contract's currentStake at the time of the move, so re-anchoring on it
  // every move means any earlier drift can never outlive a single ply.
  next.currentStake = nextStake(s, e.stakePaid);
  return { state: next, moverWasWhite };
}

/**
 * TakebackAccepted(proposer, accepter|refundTo, refunded) -- both the Duel two-party path and the
 * Crowd group-vote path. Restores the single pre-move snapshot: currentStake = refunded, one ply
 * back, side to move = the side of the undone move. Seats are NOT reverted on-chain.
 */
export function applyTakeback(
  s: TableState,
  e: { refunded: bigint; timestamp: bigint },
): { state: TableState; undoneMoveWasWhite: boolean } {
  const undoneMoveWasWhite = !s.whiteToMove;
  const next: TableState = { ...s };
  next.pot = s.pot - e.refunded;
  next.plyCount = s.plyCount - 1;
  next.whiteToMove = undoneMoveWasWhite;
  next.currentStake = e.refunded;
  next.lastMoveTimestamp = e.timestamp;
  if (s.mode === Mode.Crowd) {
    if (undoneMoveWasWhite) next.totalWhiteContribution = s.totalWhiteContribution - e.refunded;
    else next.totalBlackContribution = s.totalBlackContribution - e.refunded;
  }
  return { state: next, undoneMoveWasWhite };
}

/** StakeIncreaseAccepted(newBaseStake) -- ChessGameTable._applyStakeIncrease. */
export function applyStakeIncrease(s: TableState, newBaseStake: bigint): TableState {
  let currentStake = s.currentStake < newBaseStake ? newBaseStake : s.currentStake;
  const cap = newBaseStake * MAX_STAKE_MULTIPLIER;
  if (currentStake > cap) currentStake = cap;
  return { ...s, baseStake: newBaseStake, currentStake };
}

/** GameFinished(result, triggeredBy) -- _finalize zeroes pot (it moves into withdrawable). */
export function applyFinish(s: TableState, result: number): TableState {
  return { ...s, status: Status.Finished, result, pot: 0n };
}

// ---------------------------------------------------------------------------------------------
// TableCreated: static config from the factory call's own calldata.

export const FACTORY_CREATE_ABI = parseAbi([
  "function createDuelTable(address white, address black, uint256 baseStake, uint32 rampPly, uint32 moveTimeout, uint8 curve, address frontendRecipient, uint16 referralFeeBps, address token) returns (address)",
  "function createCrowdTable(uint256 baseStake, uint32 rampPly, uint32 moveTimeout, uint8 curve, address frontendRecipient, uint16 referralFeeBps, address token) returns (address)",
]);

export type CreateConfig = {
  mode: number;
  whitePlayer: Address;
  blackPlayer: Address;
  baseStake: bigint;
  rampPly: number;
  moveTimeout: bigint;
  curve: number;
  frontendRecipient: Address;
  referralFeeBps: number;
  token: Address;
};

/**
 * Decodes createDuelTable/createCrowdTable arguments from the transaction that emitted
 * TableCreated. Returns null when the factory was not the transaction's direct target (Safe,
 * ERC-4337 bundler, EIP-7702 batch, any wrapper contract) -- the caller then falls back to
 * reading the table's own getters at the latest block.
 */
export function decodeCreateCalldata(
  tx: { to: Address | null; input: Hex },
  factory: Address,
): CreateConfig | null {
  if (!tx.to || tx.to.toLowerCase() !== factory.toLowerCase()) return null;
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: FACTORY_CREATE_ABI, data: tx.input });
  } catch {
    return null;
  }
  if (decoded.functionName === "createDuelTable") {
    const [white, black, baseStake, rampPly, moveTimeout, curve, frontendRecipient, referralFeeBps, token] =
      decoded.args;
    return {
      mode: Mode.Duel,
      whitePlayer: white,
      blackPlayer: black,
      baseStake,
      rampPly,
      moveTimeout: BigInt(moveTimeout),
      curve,
      frontendRecipient,
      referralFeeBps,
      token,
    };
  }
  const [baseStake, rampPly, moveTimeout, curve, frontendRecipient, referralFeeBps, token] = decoded.args;
  return {
    mode: Mode.Crowd,
    whitePlayer: ZERO_ADDRESS,
    blackPlayer: ZERO_ADDRESS,
    baseStake,
    rampPly,
    moveTimeout: BigInt(moveTimeout),
    curve,
    frontendRecipient,
    referralFeeBps,
    token,
  };
}

/** Fresh state right after ChessGameTable.initialize. */
export function initialState(c: CreateConfig, createdAtTimestamp: bigint): TableState {
  return {
    mode: c.mode,
    status: Status.Active,
    result: 0,
    curve: c.curve,
    rampPly: c.rampPly,
    compoundRateBps: c.curve === Curve.Compound ? computeCompoundRateBps(c.rampPly) : 0n,
    baseStake: c.baseStake,
    currentStake: c.baseStake,
    plyCount: 0,
    pot: 0n,
    whiteToMove: true,
    lastMoveTimestamp: createdAtTimestamp,
    whitePlayer: c.whitePlayer,
    blackPlayer: c.blackPlayer,
    totalWhiteContribution: 0n,
    totalBlackContribution: 0n,
  };
}

// ---------------------------------------------------------------------------------------------
// GraphQL compatibility: blockchess-ui sends `moves(...)` without `limit`, and Ponder's GraphQL
// defaults to 50 rows -- long games would be silently truncated. Inject the maximum (1000)
// wherever a `moves(` call has no explicit limit.

export const MOVES_DEFAULT_LIMIT = 1000;

export function injectMovesLimit(query: string): string {
  return query
    .replace(/\bmoves\s*\(([^)]*)\)/g, (match, args: string) =>
      /\blimit\s*:/.test(args) ? match : `moves(limit: ${MOVES_DEFAULT_LIMIT}${args.trim() ? `, ${args}` : ""})`,
    )
    .replace(/\bmoves(\s*\{)/g, `moves(limit: ${MOVES_DEFAULT_LIMIT})$1`);
}
