import type { Policy } from "./config.ts";
import { createLiveFetcher, type JsonFetcher } from "./net.ts";
import { buildMarketOrderPayload } from "./payload.ts";
import type { OrderSender, RunDeps } from "./run.ts";
import { readInjectiveMarket } from "./sources/injective.ts";

// Deliberately not valid bech32 / hex, so a dry-run payload can never be signed as-is.
export const PLACEHOLDER_SENDER: OrderSender = {
  address: "inj1-dry-run-placeholder-sender",
  subaccountId: "0x-dry-run-placeholder-subaccount",
  isPlaceholder: true,
};

export function senderFromEnv(env: Record<string, string | undefined>): OrderSender {
  const address = env.BALLAST_SENDER;
  const subaccountId = env.BALLAST_SUBACCOUNT_ID;
  if (address && subaccountId) return { address, subaccountId, isPlaceholder: false };
  return PLACEHOLDER_SENDER;
}

export function createLiveDeps(
  policy: Policy,
  env: Record<string, string | undefined>,
  fetchJson: JsonFetcher = createLiveFetcher(policy.network),
): RunDeps {
  return {
    fetchJson,
    now: () => new Date(),
    killSwitch: env.BALLAST_KILL === "1",
    sender: senderFromEnv(env),
    readMarket: readInjectiveMarket,
    buildPayload: buildMarketOrderPayload,
  };
}
