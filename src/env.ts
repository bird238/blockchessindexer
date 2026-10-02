// Environment shared by ponder.config.ts, the indexing functions and the API. Imported with a
// relative path from ponder.config.ts, so keep it free of ponder imports.

export const ZERO = "0x0000000000000000000000000000000000000000" as const;

export const CHAIN_ID = Number(process.env.CHAIN_ID ?? 137);

/**
 * Comma-separated RPC list. Ponder spreads load across all of them and routes around unhealthy
 * ones, so listing several independent free endpoints is the cheap substitute for a paid node.
 * PONDER_RPC_URL_POLYGON is still honoured for existing deployments.
 */
export const RPC_URLS = (process.env.PONDER_RPC_URLS ?? process.env.PONDER_RPC_URL_POLYGON ?? "http://127.0.0.1:8545")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

export const FACTORY_ADDRESS = (process.env.FACTORY_ADDRESS ?? ZERO) as `0x${string}`;
export const ELO_REGISTRY_ADDRESS = (process.env.ELO_REGISTRY_ADDRESS ?? ZERO) as `0x${string}`;
export const START_BLOCK = Number(process.env.START_BLOCK ?? 0);

/** Optional cap on eth_getLogs ranges (publicnode: 10000). Unset = Ponder's adaptive default. */
export const ETH_GETLOGS_BLOCK_RANGE = process.env.ETH_GETLOGS_BLOCK_RANGE
  ? Number(process.env.ETH_GETLOGS_BLOCK_RANGE)
  : undefined;
