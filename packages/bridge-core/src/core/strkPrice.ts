// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Live STRK→USD spot price for the deposit fee estimate.
//
// The pool protocol fee is denominated in STRK (config.depositFeeStrk, default 4)
// but the deposit breakdown + on-chain amount are in USDC, so we need a STRK price
// to express the fee in USDC. This fetches a live spot price from a public,
// no-auth, CORS-friendly endpoint (Coinbase by default). Returns null on ANY
// failure (offline, CORS, rate-limit, bad shape) so callers fall back to the
// configured static price (config.depositFeeEstimate).
//
// Privacy: this is a generic price query — no address, amount, or identity leaves
// the browser, and it runs on provider mount (app load), decoupled from the
// deposit submit, so it can't be timing-correlated with a deposit.
import { config } from './config';

const DEFAULT_ENDPOINT = 'https://api.coinbase.com/v2/prices/STRK-USD/spot';

// Pull the price out of the common public-API response shapes so the endpoint can
// be overridden (Coinbase {data:{amount}}, Binance {price}, CoinGecko {starknet:{usd}}).
function extractPrice(json: unknown): number | null {
  if (!json || typeof json !== 'object') return null;
  const j = json as Record<string, unknown>;
  const data = j.data as Record<string, unknown> | undefined;
  const starknet = j.starknet as Record<string, unknown> | undefined;
  const raw = data?.amount ?? j.price ?? starknet?.usd;
  const price = Number(raw);
  return Number.isFinite(price) && price > 0 ? price : null;
}

export async function fetchStrkPriceUsd(
  endpoint: string = config.strkPriceUrl || DEFAULT_ENDPOINT,
  timeoutMs = 4000,
): Promise<number | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(endpoint, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return extractPrice(await res.json());
  } catch {
    return null;
  }
}
