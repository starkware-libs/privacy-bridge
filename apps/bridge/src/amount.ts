// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

/** Shared USDC amount parsing for apps/bridge's flow components. */

export const USDC_DECIMALS = 6;

/** Parses a human-entered USDC amount into base units, or null if invalid/non-positive. */
export function parseUsdcAmount(input: string): bigint | null {
  const n = Number.parseFloat(input);
  if (!Number.isFinite(n) || n <= 0) return null;
  return BigInt(Math.round(n * 10 ** USDC_DECIMALS));
}
