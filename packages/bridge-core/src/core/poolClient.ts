// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// The pool's PrivateTransfers client (SDK proof builder + indexer discovery), wired in
// ONE place. Every orchestrator that proves a pool action needs an identically-wired
// client — same prover, chain, indexer and pool — and a per-call copy is how that wiring
// drifts.

import type { Account, constants } from 'starknet';
import {
  createPrivateTransfers,
  IndexerDiscoveryProvider,
  type PrivateTransfersInterface,
} from '@starkware-libs/starknet-privacy-sdk';
import { config } from './config.js';

export function makePoolTransfers(account: Account, viewingKey: bigint): PrivateTransfersInterface {
  return createPrivateTransfers({
    account,
    viewingKeyProvider: { getViewingKey: async () => viewingKey },
    provingProvider: {
      url: config.proverUrl,
      chainId: config.chainId as constants.StarknetChainId,
    },
    discoveryProvider: new IndexerDiscoveryProvider(config.indexerUrl, config.poolAddress),
    poolContractAddress: config.poolAddress,
  });
}
