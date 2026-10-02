import { ponder } from "ponder:registry";
import * as schema from "ponder:schema";

import { ChessGameTableAbi } from "../abis/ChessGameTableAbi";
import { FACTORY_ADDRESS } from "./env";
import {
  applyFinish,
  applyMove,
  applyStakeIncrease,
  applyTakeback,
  decodeCreateCalldata,
  initialState,
  Mode,
  type CreateConfig,
  type TableState,
} from "./logic";
import { readLatest } from "./rpc";

// Event-sourced indexing: every handler applies a pure reducer from ./logic to the table row and
// writes the result. No handler reads contract state at an event's block, so no archive node is
// needed for backfills.

type TableRow = typeof schema.table.$inferSelect;

const toState = (r: TableRow): TableState => ({
  mode: r.mode,
  status: r.status,
  result: r.result,
  curve: r.curve,
  rampPly: r.rampPly,
  compoundRateBps: r.compoundRateBps,
  baseStake: r.baseStake,
  currentStake: r.currentStake,
  plyCount: r.plyCount,
  pot: r.pot,
  whiteToMove: r.whiteToMove,
  lastMoveTimestamp: r.lastMoveTimestamp,
  whitePlayer: r.whitePlayer,
  blackPlayer: r.blackPlayer,
  totalWhiteContribution: r.totalWhiteContribution,
  totalBlackContribution: r.totalBlackContribution,
});

const eventId = (address: string, blockNumber: bigint, logIndex: number) =>
  `${address.toLowerCase()}-${blockNumber}-${logIndex}`;

async function getTable(db: { find: Function }, address: `0x${string}`): Promise<TableRow> {
  const row = (await db.find(schema.table, { id: address })) as TableRow | null;
  // Unreachable unless TableCreated was skipped: the factory source starts at the same block as
  // the table source, and Ponder delivers TableCreated before any event of that clone.
  if (!row) throw new Error(`table ${address} not indexed before its first event`);
  return row;
}

ponder.on("ChessGameFactory:TableCreated", async ({ event, context }) => {
  const tableAddress = event.args.table;

  let config: CreateConfig | null = decodeCreateCalldata(event.transaction, FACTORY_ADDRESS);
  let configSource = "calldata";
  if (!config) {
    // Factory reached through a wrapper (Safe, 4337 bundler, 7702 batch): read the table's own
    // getters at the latest block. All are immutable after initialize except baseStake and the
    // seats; those may show a later value until the next event re-anchors them (see README).
    const [whitePlayer, blackPlayer, baseStake, rampPly, moveTimeout, curve, referralFeeBps, token] =
      await readLatest(tableAddress, ChessGameTableAbi, [
        "whitePlayer",
        "blackPlayer",
        "baseStake",
        "rampPly",
        "moveTimeout",
        "curve",
        "referralFeeBps",
        "token",
      ] as const);
    config = {
      mode: event.args.mode,
      whitePlayer: whitePlayer as `0x${string}`,
      blackPlayer: blackPlayer as `0x${string}`,
      baseStake: baseStake as bigint,
      rampPly: Number(rampPly),
      moveTimeout: BigInt(moveTimeout as number | bigint),
      curve: Number(curve),
      frontendRecipient: event.args.frontendRecipient,
      referralFeeBps: Number(referralFeeBps),
      token: token as `0x${string}`,
    };
    configSource = "latest";
  }

  // The table copies the factory's protocol fee into its own storage at creation and never
  // changes it, so the latest value is the creation-time value.
  const [protocolFeeRecipient, protocolFeeBps] = await readLatest(tableAddress, ChessGameTableAbi, [
    "protocolFeeRecipient",
    "protocolFeeBps",
  ] as const);

  const state = initialState({ ...config, mode: event.args.mode }, event.block.timestamp);

  await context.db.insert(schema.table).values({
    id: tableAddress,
    creator: event.args.creator,
    frontendRecipient: event.args.frontendRecipient,
    createdAtBlock: event.block.number,
    createdAtTimestamp: event.block.timestamp,
    moveTimeout: config.moveTimeout,
    protocolFeeBps: Number(protocolFeeBps),
    protocolFeeRecipient: protocolFeeRecipient as `0x${string}`,
    referralFeeBps: config.referralFeeBps,
    token: config.token,
    ...state,
    whiteBackerCount: 0,
    blackBackerCount: 0,
    lastMoveId: null,
    lastEventBlock: event.block.number,
    configSource,
  });
});

ponder.on("ChessGameTable:MoveMade", async ({ event, context }) => {
  const tableAddress = event.log.address;
  const row = await getTable(context.db, tableAddress);
  const { state, moverWasWhite } = applyMove(toState(row), {
    mover: event.args.mover,
    stakePaid: event.args.stakePaid,
    timestamp: event.block.timestamp,
  });
  const moveId = eventId(tableAddress, event.block.number, event.log.logIndex);

  await context.db.insert(schema.move).values({
    id: moveId,
    tableId: tableAddress,
    plyIndex: state.plyCount,
    mover: event.args.mover,
    fromSquare: event.args.from,
    toSquare: event.args.to,
    promotion: event.args.promotion,
    stakePaid: event.args.stakePaid,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
    takenBack: false,
    whiteToMoveAfter: state.whiteToMove,
    currentStakeAfter: state.currentStake,
    potAfter: state.pot,
  });

  let { whiteBackerCount, blackBackerCount } = row;
  if (state.mode === Mode.Crowd) {
    // A Crowd wallet is locked to one colour for the whole game (colorOf), so one row per
    // (table, address) is enough.
    const backerId = `${tableAddress.toLowerCase()}-${event.args.mover.toLowerCase()}`;
    const existing = await context.db.find(schema.backer, { id: backerId });
    if (!existing) {
      await context.db.insert(schema.backer).values({
        id: backerId,
        tableId: tableAddress,
        address: event.args.mover,
        isWhite: moverWasWhite,
      });
      if (moverWasWhite) whiteBackerCount += 1;
      else blackBackerCount += 1;
    }
  }

  await context.db.update(schema.table, { id: tableAddress }).set({
    ...state,
    whiteBackerCount,
    blackBackerCount,
    lastMoveId: moveId,
    lastEventBlock: event.block.number,
  });
});

// Single-level undo on-chain (prevSnapshot.valid is cleared by a takeback and only re-armed by a
// move), so the undone move is always the table's lastMoveId.
ponder.on("ChessGameTable:TakebackAccepted", async ({ event, context }) => {
  const tableAddress = event.log.address;
  const row = await getTable(context.db, tableAddress);
  const { state } = applyTakeback(toState(row), {
    refunded: event.args.refunded,
    timestamp: event.block.timestamp,
  });

  if (row.lastMoveId) {
    await context.db.update(schema.move, { id: row.lastMoveId }).set({ takenBack: true });
  }
  await context.db.insert(schema.takeback).values({
    id: eventId(tableAddress, event.block.number, event.log.logIndex),
    tableId: tableAddress,
    proposer: event.args.proposer,
    accepter: event.args.accepter,
    refunded: event.args.refunded,
    undoneMoveId: row.lastMoveId,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
  await context.db.update(schema.table, { id: tableAddress }).set({
    ...state,
    lastMoveId: null,
    lastEventBlock: event.block.number,
  });
});

ponder.on("ChessGameTable:StakeIncreaseAccepted", async ({ event, context }) => {
  const tableAddress = event.log.address;
  const row = await getTable(context.db, tableAddress);
  const state = applyStakeIncrease(toState(row), event.args.newBaseStake);

  await context.db.insert(schema.stakeIncrease).values({
    id: eventId(tableAddress, event.block.number, event.log.logIndex),
    tableId: tableAddress,
    newBaseStake: event.args.newBaseStake,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
  await context.db.update(schema.table, { id: tableAddress }).set({
    baseStake: state.baseStake,
    currentStake: state.currentStake,
    lastEventBlock: event.block.number,
  });
});

ponder.on("ChessGameTable:GameFinished", async ({ event, context }) => {
  const tableAddress = event.log.address;
  const row = await getTable(context.db, tableAddress);
  const state = applyFinish(toState(row), event.args.result);

  await context.db.insert(schema.gameFinishedEvent).values({
    id: eventId(tableAddress, event.block.number, event.log.logIndex),
    tableId: tableAddress,
    result: event.args.result,
    triggeredBy: event.args.triggeredBy,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });
  await context.db.update(schema.table, { id: tableAddress }).set({
    status: state.status,
    result: state.result,
    pot: state.pot,
    lastEventBlock: event.block.number,
  });
});

ponder.on("ChessGameTable:ShareClaimed", async ({ event, context }) => {
  await context.db.insert(schema.shareClaim).values({
    id: eventId(event.log.address, event.block.number, event.log.logIndex),
    tableId: event.log.address,
    contributor: event.args.contributor,
    amount: event.args.amount,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
});

ponder.on("ChessGameFactory:TokenAllowlistUpdated", async ({ event, context }) => {
  await context.db
    .insert(schema.allowedToken)
    .values({
      id: event.args.token,
      allowed: event.args.allowed,
      updatedAtBlock: event.block.number,
      updatedAtTimestamp: event.block.timestamp,
    })
    .onConflictDoUpdate({
      allowed: event.args.allowed,
      updatedAtBlock: event.block.number,
      updatedAtTimestamp: event.block.timestamp,
    });
});

// `newRating` is exactly what effectiveRating() returns from this block on -- stored as-is.
ponder.on("ChessEloRegistry:RatingUpdated", async ({ event, context }) => {
  await context.db
    .insert(schema.rating)
    .values({
      id: event.args.player,
      value: event.args.newRating,
      updatedAtBlock: event.block.number,
      updatedAtTimestamp: event.block.timestamp,
    })
    .onConflictDoUpdate({
      value: event.args.newRating,
      updatedAtBlock: event.block.number,
      updatedAtTimestamp: event.block.timestamp,
    });
});
