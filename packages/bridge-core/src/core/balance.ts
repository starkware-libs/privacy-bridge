// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { getRpcProvider } from './provider.js';
import { config } from './config.js';
import { READ_BLOCK } from './tx.js';

// Reads the STRK balance (in wei, 18 decimals) of `address`.
//
// ERC-20 `balanceOf` returns a Cairo u256 serialised as two felts (low, high).
// starknet@10's callContract resolves to a CallContractResponse (string[]): the
// raw felt fields as hex strings. We recombine them into a single bigint.
export async function getStrkBalance(address: string): Promise<bigint> {
  const result = await getRpcProvider().callContract(
    {
      contractAddress: config.strkToken,
      entrypoint: 'balanceOf',
      calldata: [address],
    },
    READ_BLOCK,
  );

  const [low, high] = result;
  if (low === undefined || high === undefined) {
    throw new Error('getStrkBalance: unexpected balanceOf result shape');
  }
  return BigInt(low) + (BigInt(high) << 128n);
}
