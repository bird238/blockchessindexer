# Blockchess Indexer

[Ponder](https://ponder.sh) indexer for the Blockchess contracts ([bird238/blockchess](https://github.com/bird238/blockchess),
Polygon PoS mainnet). It indexes contract events into a PostgreSQL-compatible database and serves a GraphQL API for the
frontend: the lobby, move history, Crowd backers, ELO ratings and the token allowlist.

## Event sources

1. **`ChessGameFactory`** (fixed address): `TableCreated` for every new `ChessGameTable` clone (Duel or Crowd) and
   `TokenAllowlistUpdated` when the owner changes the allowed ERC20 stake tokens.
2. **`ChessGameTable` clones** (dynamic discovery): Ponder's factory resolver
   (`factory({ address: factory, event: TableCreated, parameter: "table" })`) picks up every clone automatically, with no
   hardcoded addresses. Each clone is followed for `MoveMade`, `TakebackAccepted`, `StakeIncreaseAccepted`,
   `GameFinished` and `ShareClaimed`.
3. **`ChessEloRegistry`** (fixed address): `RatingUpdated` whenever a finished Duel result is recorded.

## Design: event-sourced, no historical state reads

Ordinary Polygon full nodes keep contract state for only ~128 blocks (~4 minutes). An indexer that re-reads state with
`eth_call` at each event's block therefore needs an archive node for every backfill or restart after downtime. This
indexer never does that: all state is derived from **event arguments alone**, mirroring the contract's own bookkeeping
([src/logic.ts](src/logic.ts)):

| Event | State update (exactly what `ChessGameTable` does) |
|---|---|
| `MoveMade(mover, from, to, promotion, stakePaid)` | `pot += stakePaid`, `plyCount++`, turn flips, Crowd contribution of the mover's side `+= stakePaid`, a vacant Duel seat is claimed by the mover, next `currentStake` from the curve (Flat / Linear `+base*9/rampPly` / Compound `*(1+rate)`, capped at `10*base`) re-anchored on `stakePaid` every move |
| `TakebackAccepted(proposer, accepter, refunded)` | single-level undo: `currentStake = refunded`, `pot -= refunded`, `plyCount--`, side of the undone move to move again, Crowd contribution of that side `-= refunded`, seats unchanged; the undone `move` row gets `takenBack: true` |
| `StakeIncreaseAccepted(newBaseStake)` | `baseStake = new`, `currentStake` clamped into `[base, 10*base]` |
| `GameFinished(result, triggeredBy)` | `status = Finished`, `result`, `pot = 0` |

Static table config comes from the `createDuelTable` / `createCrowdTable` **calldata** of the transaction that emitted
`TableCreated`. The only RPC reads left are of getters that are immutable after `initialize` (protocol fee; for tables
created through a wrapper contract such as a Safe, the whole config), done at the **latest** block — which every node
serves. `compoundRateBps` is computed with an exact port of `_computeCompoundRateBps`.

The contracts remain the only source of truth. Chess rules are not re-implemented: the contract validates moves, and
the board is read live from the chain by the frontend. `boardAfter` & co. are kept in the schema as nullable columns for
compatibility only.

## Data model

| Table (GraphQL) | Contents |
|---|---|
| `table` (`tables`) | One row per clone: deployment parameters (base stake, ramp ply, move timeout, curve, `compoundRateBps`, protocol fee and recipient, referral fee, stake token) and live state (status, result, ply count, pot, current stake, side to move, last move time, seats, Crowd contribution totals, `whiteBackerCount` / `blackBackerCount`). `configSource` is `calldata` or `latest` (created through a wrapper contract) |
| `move` (`moves`) | One row per `MoveMade` with derived `potAfter`, `currentStakeAfter`, `whiteToMoveAfter`. Keyed by block and log index, not ply, because a takeback lets a later move reuse the same `plyIndex`; the undone row is kept and flagged `takenBack` so the full history stays visible |
| `takeback` (`takebacks`) | Accepted takebacks: proposer, accepter (Duel opponent / refunded Crowd backer), `refunded`, the undone move id |
| `stakeIncrease` (`stakeIncreases`) | Accepted base-stake increases |
| `gameFinishedEvent` (`gameFinishedEvents`) | Terminal outcome (checkmate, stalemate, draw, timeout, resignation, …) and who triggered it |
| `shareClaim` (`shareClaims`) | Crowd payout claims |
| `backer` (`backers`) | Distinct addresses per side of a Crowd table (the contract only stores per-side totals). A row is never removed, even if the backer's only contribution was later taken back; the totals stay exact |
| `allowedToken` (`allowedTokens`) | ERC20 allowlist history; `allowed: false` = removed later. Native currency (address zero) is always allowed and never stored |
| `rating` (`ratings`) | Current ELO per Duel player. A missing row means the registry's default rating (1200), not zero |

## Frontend integration

The frontend uses the indexer for data that is expensive to assemble from RPC: the cross-table lobby with filters,
complete move history, backer counts and lists, ELO leaderboards.

Values that condition transactions (current pot, required stake, side to move, withdrawable balances) should be read
**live from the chain**, never from the indexer, so that money never depends on indexer freshness or availability.

## API

- `POST /graphql` (also `/`) — Ponder's auto-generated GraphQL. Queries for `moves(...)` without an explicit `limit` get
  `limit: 1000` injected (Ponder's default page size is 50, which would truncate long games).
- `POST /add-table {"txHash": "0x..."}` — validates that the transaction created a table on this factory and returns
  `{ ok, table, indexed }`. Discovery itself is automatic (factory pattern); this backs a "paste creation tx" button in
  the frontend. Rate-limited per IP (`X-Real-IP` from the reverse proxy).
- `/health`, `/ready`, `/status`, `/metrics` — Ponder built-ins. Keep them on loopback.

## Execution and storage

The indexer keeps polling RPC nodes and maintains persistent database state, so it must run as **one long-lived process
per network**, not on a serverless platform. Each network needs its own instance with its own chain and contract
configuration.

Storage is embedded PGlite (`.ponder/`) by default, or PostgreSQL when `DATABASE_URL` is set.

## Running

Requires Node.js **>= 22.18** (tests and scripts use built-in TypeScript type stripping; on 22.6–22.17 run them with
`node --experimental-strip-types`).

```bash
npm install
npm run dev          # GraphQL at http://localhost:42069/graphql, embedded PGlite
```

Configuration lives in `.env.local` (committed values = live mainnet deployment):

| Variable | Meaning |
|---|---|
| `PONDER_RPC_URLS` | comma-separated RPC URLs; Ponder load-balances and routes around failing ones (`PONDER_RPC_URL_POLYGON` still accepted) |
| `ETH_GETLOGS_BLOCK_RANGE` | optional `eth_getLogs` range cap |
| `CHAIN_ID` | default 137 |
| `FACTORY_ADDRESS`, `ELO_REGISTRY_ADDRESS` | deployment addresses |
| `START_BLOCK` | factory deployment block `93290639` — never move it forward |
| `DATABASE_URL` | PostgreSQL connection string (production); unset = PGlite |
| `PONDER_SCHEMA` | database schema used by the systemd unit |

### Deploying (production)

1. Storage: PostgreSQL 14+ (Debian 12 ships 15) via `DATABASE_URL` in the host's `.env.local`, or embedded PGlite if
   unset (acceptable here: a full re-index takes minutes).
2. `ops/blockchess-indexer.service` runs `ponder start --schema $PONDER_SCHEMA --port 42069`, `Restart=always`.
   A crash or restart resumes from Ponder's checkpoint; **nothing ever deletes data**.
3. Schema changes (changed `ponder.schema.ts` / handlers) require a fresh `PONDER_SCHEMA` (e.g. `blockchess_v3`). It can
   run next to the old one on another port until `/ready` returns 200; then switch the reverse proxy. With PostgreSQL,
   `npx ponder db prune` the old schema afterwards.
4. Reverse proxy: expose only `/graphql` and `/add-table`. Do not add CORS headers — Ponder already sends
   `Access-Control-Allow-Origin: *`.
5. `ops/blockchess-indexer-verify.{service,timer}` — read-only consistency check every 15 minutes (below); alert on failure.

## Verification

- `npm test` — unit tests for the reducers, stake curves, calldata decoding and the `moves` limit rewrite.
- `npm run verify` — reads the block the indexer has fully processed from `/status`, reads every table's getters **at
  that same block** and compares 22 fields plus "not-taken-back moves == plyCount". Prints
  `REPLAY DIVERGENCE table=... block=... field=... local=... onchain=...`; exit code 0/1/2.
- `CONTRACTS_OUT=<blockchess>/out npm run e2e` — deploys the real contracts on an anvil started with
  `--prune-history` (historical `eth_call` fails, like a public node), plays scripted Duel/Crowd games covering every
  reducer path (vacant seat, takebacks incl. Crowd group vote, stake increase, resign, ELO, Linear/Compound/Flat, table
  created through a wrapper contract), backfills from scratch, runs `verify` and frontend-shaped GraphQL checks, then
  repeats after live moves.

## Migrating an existing deployment

This indexer serves everything the previous log-based lobby service answered (`tables`, `moves`, `backers`, `ratings`,
`POST /add-table`). To switch over:

1. Start it under a fresh `PONDER_SCHEMA` with `START_BLOCK=93290639` on a spare port; wait for `/ready` (a full mainnet
   backfill takes minutes).
2. Run `npm run verify` against it — expect `0 divergence(s)`.
3. Point the reverse proxy's `/graphql` and `/add-table` at the indexer, then stop the old lobby service and remove any
   watchdog that deletes `.ponder` or edits `START_BLOCK`.

## Note for frontend operators

A frontend that reads live contract state directly (as recommended above) depends on its own RPC endpoint, not on this
indexer. When that endpoint is overloaded (publicnode often answers `eth_call` with `529 upstream overloaded`), the
lobby still loads but table pages hang. Use a reliable endpoint for it, e.g. `https://gateway.tenderly.co/public/polygon`
(CORS-enabled) or a keyed provider.
