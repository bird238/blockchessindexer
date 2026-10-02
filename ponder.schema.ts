import { index, onchainTable } from "ponder";

// Every row below is derived from event arguments only (see src/logic.ts) -- no historical
// eth_call -- so any block range can be (re)indexed on an ordinary pruned RPC node. The GraphQL
// shape blockchess-ui queries (tables / backers / moves / ratings / allowedTokens) is unchanged.

// One row per deployed ChessGameTable clone (Duel/Crowd).
export const table = onchainTable(
  "table",
  (t) => ({
    id: t.hex().primaryKey(), // table contract address
    mode: t.integer().notNull(), // 0=Duel, 1=Crowd
    creator: t.hex().notNull(), // msg.sender of the Factory create call
    frontendRecipient: t.hex().notNull(),
    createdAtBlock: t.bigint().notNull(),
    createdAtTimestamp: t.bigint().notNull(),

    // static config (immutable after initialize, except baseStake via StakeIncreaseAccepted)
    baseStake: t.bigint().notNull(),
    rampPly: t.integer().notNull(),
    moveTimeout: t.bigint().notNull(),
    curve: t.integer().notNull(), // 0=Linear, 1=Compound, 2=Flat
    compoundRateBps: t.bigint().notNull(), // computed exactly like _computeCompoundRateBps; 0 unless Compound
    protocolFeeBps: t.integer().notNull(),
    protocolFeeRecipient: t.hex().notNull(),
    referralFeeBps: t.integer().notNull(),
    // address(0) = native currency (POL); otherwise the allowlisted ERC20 of this table.
    token: t.hex().notNull(),

    // live state, maintained by the event reducers in src/logic.ts
    status: t.integer().notNull(), // 0=Active, 1=Finished
    result: t.integer().notNull(), // 0=None, 1=WhiteWon, 2=BlackWon, 3=Draw
    plyCount: t.integer().notNull(),
    pot: t.bigint().notNull(),
    currentStake: t.bigint().notNull(),
    whiteToMove: t.boolean().notNull(),
    lastMoveTimestamp: t.bigint().notNull(),

    // Duel seats (address(0) = vacancy, claimed by the first mover of that colour; never reverted
    // by a takeback). Always address(0) for Crowd. Crowd contribution totals (always 0 for Duel).
    whitePlayer: t.hex().notNull(),
    blackPlayer: t.hex().notNull(),
    totalWhiteContribution: t.bigint().notNull(),
    totalBlackContribution: t.bigint().notNull(),

    // Distinct Crowd backers per side -- lets the lobby show "N backers" without paging through
    // every backer row (backers(limit: 1000) across all tables stops scaling past 1000 rows).
    whiteBackerCount: t.integer().notNull(),
    blackBackerCount: t.integer().notNull(),

    // Indexer bookkeeping.
    lastMoveId: t.text(), // latest not-taken-back move (single-level undo target), null if none
    lastEventBlock: t.bigint().notNull(), // last block that changed this row
    // "calldata" = config decoded from the factory call; "latest" = factory called through a
    // wrapper (Safe / 4337 / 7702), config read from the table's getters at the latest block.
    configSource: t.text().notNull(),
  }),
  (t) => ({
    createdAtBlockIdx: index().on(t.createdAtBlock),
    statusIdx: index().on(t.status),
    modeIdx: index().on(t.mode),
  }),
);

// Distinct address that has contributed to one side of a Crowd table. Never removed, even if the
// address's only contribution is later taken back (cosmetic, accepted; totals stay exact).
export const backer = onchainTable(
  "backer",
  (t) => ({
    id: t.text().primaryKey(), // `${tableAddress}-${address}`
    tableId: t.hex().notNull(),
    address: t.hex().notNull(),
    isWhite: t.boolean().notNull(),
  }),
  (t) => ({
    tableIdx: index().on(t.tableId),
  }),
);

// One row per MoveMade. Keyed by block/log, not plyIndex: after a takeback a later move reuses
// the same plyIndex. `takenBack` marks the undone row instead of deleting it.
export const move = onchainTable(
  "move",
  (t) => ({
    id: t.text().primaryKey(), // `${tableAddress}-${blockNumber}-${logIndex}`
    tableId: t.hex().notNull(),
    plyIndex: t.integer().notNull(), // 1-based, equals on-chain plyCount after the move
    mover: t.hex().notNull(),
    fromSquare: t.integer().notNull(),
    toSquare: t.integer().notNull(),
    promotion: t.integer().notNull(),
    stakePaid: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
    takenBack: t.boolean().notNull(),

    // Derived economic/turn state after this move.
    whiteToMoveAfter: t.boolean().notNull(),
    currentStakeAfter: t.bigint().notNull(),
    potAfter: t.bigint().notNull(),

    // Board state after the move used to be read from the contract at the move's block, which
    // is exactly what required an archive node. No consumer reads these (the UI reads the live
    // board from the chain), so they are kept only for schema compatibility and left null.
    boardAfter: t.bigint(),
    castlingRightsAfter: t.integer(),
    enPassantAfterSquare: t.integer(),
    halfmoveClockAfter: t.integer(),
  }),
  (t) => ({
    tableBlockIdx: index().on(t.tableId, t.blockNumber),
  }),
);

// Terminal event for a table (checkmate/stalemate/draw/timeout/resign/etc).
export const gameFinishedEvent = onchainTable(
  "game_finished_event",
  (t) => ({
    id: t.text().primaryKey(), // `${tableAddress}-${blockNumber}-${logIndex}`
    tableId: t.hex().notNull(),
    result: t.integer().notNull(),
    triggeredBy: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (t) => ({
    tableIdx: index().on(t.tableId),
  }),
);

// Accepted takebacks (Duel two-party accept or Crowd group vote).
export const takeback = onchainTable(
  "takeback",
  (t) => ({
    id: t.text().primaryKey(), // `${tableAddress}-${blockNumber}-${logIndex}`
    tableId: t.hex().notNull(),
    proposer: t.hex().notNull(),
    accepter: t.hex().notNull(), // Duel: accepting opponent; Crowd: address refunded
    refunded: t.bigint().notNull(),
    undoneMoveId: t.text(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (t) => ({
    tableIdx: index().on(t.tableId),
  }),
);

// Accepted base-stake increases.
export const stakeIncrease = onchainTable(
  "stake_increase",
  (t) => ({
    id: t.text().primaryKey(),
    tableId: t.hex().notNull(),
    newBaseStake: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (t) => ({
    tableIdx: index().on(t.tableId),
  }),
);

// Crowd payout claims.
export const shareClaim = onchainTable(
  "share_claim",
  (t) => ({
    id: t.text().primaryKey(),
    tableId: t.hex().notNull(),
    contributor: t.hex().notNull(),
    amount: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (t) => ({
    tableIdx: index().on(t.tableId),
    contributorIdx: index().on(t.contributor),
  }),
);

// Owner-curated ERC20 allowlist (TokenAllowlistUpdated). address(0) is implicitly allowed and
// never stored. `allowed: false` = was allowlisted, later removed (kept for history).
export const allowedToken = onchainTable("allowed_token", (t) => ({
  id: t.hex().primaryKey(), // token address
  allowed: t.boolean().notNull(),
  updatedAtBlock: t.bigint().notNull(),
  updatedAtTimestamp: t.bigint().notNull(),
}));

// Current ELO rating per player (ChessEloRegistry.RatingUpdated, Duel only). A missing row means
// the registry's DEFAULT_RATING (1200).
export const rating = onchainTable("rating", (t) => ({
  id: t.hex().primaryKey(), // player address
  value: t.integer().notNull(),
  updatedAtBlock: t.bigint().notNull(),
  updatedAtTimestamp: t.bigint().notNull(),
}));
