import { createPublicClient, defineChain, fallback, http, type Abi, type Address } from "viem";

import { CHAIN_ID, RPC_URLS } from "./env";

// A plain viem client for the few reads that must NOT be pinned to an event's block:
// table getters that are immutable after initialize (so "latest" == "at creation"), and
// receipt lookups for POST /add-table. Never used for mutable state.
export const latestClient = createPublicClient({
  chain: defineChain({
    id: CHAIN_ID,
    name: `chain-${CHAIN_ID}`,
    nativeCurrency: { name: "native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: RPC_URLS } },
  }),
  transport: fallback(RPC_URLS.map((url) => http(url, { timeout: 20_000, retryCount: 1 }))),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Reads getters at the latest block, retrying with backoff. Retries matter because a
 * load-balanced public RPC can route the call to a backend that is a few blocks behind the
 * table's creation block, which surfaces as "returned no data".
 */
export async function readLatest<const fns extends readonly string[]>(
  address: Address,
  abi: Abi,
  functionNames: fns,
  attempts = 6,
): Promise<{ [K in keyof fns]: unknown }> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return (await Promise.all(
        functionNames.map((functionName) => latestClient.readContract({ address, abi, functionName })),
      )) as { [K in keyof fns]: unknown };
    } catch (err) {
      lastErr = err;
      await sleep(500 * 2 ** i);
    }
  }
  throw lastErr;
}
