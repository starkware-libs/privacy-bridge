// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Tests for the chain-sourced undeposited-residual reader (#433). readUndepositedResidual
// is a thin delegate to readDepositTokenBalance (the SN account's on-chain deposit-token
// balance); the dust threshold's strict-`>` semantics are the shared contract both the
// moveIntoPool fail-closed and the status synth compare against.

import { describe, expect, it, vi } from 'vitest';

vi.mock('./deposit', () => ({
  readDepositTokenBalance: vi.fn(),
}));

import { readUndepositedResidual, RESIDUAL_DUST_THRESHOLD_WEI } from './residual';
import { readDepositTokenBalance } from './deposit';

const mReadBalance = vi.mocked(readDepositTokenBalance);

const SN = '0xSNACCOUNT';

describe('readUndepositedResidual', () => {
  it('delegates to readDepositTokenBalance with the SN address and returns its balance', async () => {
    mReadBalance.mockResolvedValue(123_456n);
    const residual = await readUndepositedResidual(SN);
    expect(mReadBalance).toHaveBeenCalledTimes(1);
    expect(mReadBalance).toHaveBeenCalledWith(SN);
    expect(residual).toBe(123_456n);
  });
});

describe('RESIDUAL_DUST_THRESHOLD_WEI (strict-> boundary)', () => {
  it('is 0.05 USDC @ 6dp', () => {
    expect(RESIDUAL_DUST_THRESHOLD_WEI).toBe(50_000n);
  });

  it('treats exactly the threshold as NOT resumable (strict >)', () => {
    expect(50_000n > RESIDUAL_DUST_THRESHOLD_WEI).toBe(false);
  });

  it('treats one wei above the threshold as resumable', () => {
    expect(50_001n > RESIDUAL_DUST_THRESHOLD_WEI).toBe(true);
  });
});
