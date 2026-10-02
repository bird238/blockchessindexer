import { createConfig, factory } from "ponder";
import { parseAbiItem } from "viem";

import { ChessGameFactoryAbi } from "./abis/ChessGameFactoryAbi";
import { ChessGameTableAbi } from "./abis/ChessGameTableAbi";
import { ChessEloRegistryAbi } from "./abis/ChessEloRegistryAbi";
import {
  CHAIN_ID,
  ELO_REGISTRY_ADDRESS,
  ETH_GETLOGS_BLOCK_RANGE,
  FACTORY_ADDRESS,
  RPC_URLS,
  START_BLOCK,
} from "./src/env";

// Storage: set DATABASE_URL (PostgreSQL) in production; without it Ponder falls back to embedded
// PGlite, which is fine for local development only (PGLITE_DIR lets tests use their own copy).
export default createConfig({
  ...(!process.env.DATABASE_URL && process.env.PGLITE_DIR
    ? { database: { kind: "pglite" as const, directory: process.env.PGLITE_DIR } }
    : {}),
  chains: {
    polygon: {
      id: CHAIN_ID,
      rpc: RPC_URLS,
      ...(ETH_GETLOGS_BLOCK_RANGE ? { ethGetLogsBlockRange: ETH_GETLOGS_BLOCK_RANGE } : {}),
    },
  },
  contracts: {
    ChessGameFactory: {
      chain: "polygon",
      abi: ChessGameFactoryAbi,
      address: FACTORY_ADDRESS,
      startBlock: START_BLOCK,
    },
    ChessGameTable: {
      chain: "polygon",
      abi: ChessGameTableAbi,
      address: factory({
        address: FACTORY_ADDRESS,
        event: parseAbiItem(
          "event TableCreated(address indexed table, uint8 mode, address indexed creator, address frontendRecipient)",
        ),
        parameter: "table",
      }),
      startBlock: START_BLOCK,
    },
    ChessEloRegistry: {
      chain: "polygon",
      abi: ChessEloRegistryAbi,
      address: ELO_REGISTRY_ADDRESS,
      startBlock: START_BLOCK,
    },
  },
});
