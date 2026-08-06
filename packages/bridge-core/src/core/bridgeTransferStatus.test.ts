// Tests for the unified bridge status reader + resume router (Phase 1 shared
// engine). Two concerns:
//   1. getBridgeTransferStatus — ONE reader over all five persisted cursors: each in
//      isolation maps to the right (direction/phase/needsSignature/amount); multiple
//      present → most-advanced-wins priority; none → null; corrupt/disabled localStorage
//      → null (never throws). Real readers over real (jsdom) localStorage, like
//      poolDepositCursor.test.ts.
//   2. resumeBridgeTransfer — routes each phase to the right EXISTING orchestrator with
//      the right args (esp. resume:true for the into-pool composite) and NEVER starts a
//      new transfer. The orchestrators are mocked so we assert routing, not execution.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the two orchestrators the router drives so we can assert routing without running
// any value-moving code. The status READER does not touch these.
vi.mock('./moveIntoPool', () => ({
  moveIntoPool: vi.fn(async () => ({ depositedNetWei: 980_000n, deposited: true })),
}));
// recoverBridgeIn lives in returnIn now (fold-only recovery is cursor-driven). Spread the
// REAL module so the status reader's cursor readers (peekInflightReturn) stay real, and
// override ONLY recoverBridgeIn (the orchestrator the router drives).
vi.mock('./returnIn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./returnIn')>();
  return {
    ...actual,
    recoverBridgeIn: vi.fn(async () => ({ stuck: 500_000n, claimTxHash: '0xclaim' })),
  };
});
// The chain-sourced residual reader used by getBridgeTransferStatusAsync's fallback.
// Mocked so the async detector's on-chain read is controllable (no RPC); the constant
// mirrors residual.ts so the strict-> boundary matches production.
vi.mock('./residual', () => ({
  readUndepositedResidual: vi.fn(),
  RESIDUAL_DUST_THRESHOLD_WEI: 50_000n,
}));

import {
  getBridgeTransferStatus,
  getBridgeTransferStatusAsync,
  resumeBridgeTransfer,
  type BridgeTransferStatus,
} from './bridgeTransferStatus';
import { moveIntoPool } from './moveIntoPool';
import { recoverBridgeIn } from './returnIn';
import { recordPendingPoolDeposit } from './poolDepositCursor';
import { readUndepositedResidual } from './residual';
import { config } from './config';

const mMove = vi.mocked(moveIntoPool);
const mRecover = vi.mocked(recoverBridgeIn);
const mResidual = vi.mocked(readUndepositedResidual);

const SN = '0x1234abcd';
const EVM = `0x${'ab'.repeat(20)}`; // 40-hex EVM address
const SIGNATURE = `0x${'ab'.repeat(65)}` as const;

const KEY = {
  deposit: 'pmp.inflightDeposit',
  pool: 'pmp.inflightPoolDeposit',
  ret: 'pmp.inflightReturn',
  burn: 'pmp.inflightBurn',
  cash: 'pmp.inflightCashOut',
} as const;

// Write a per-address cursor record under a frozen key (the map shape every reader uses).
function put(key: string, addr: string, record: unknown): void {
  localStorage.setItem(key, JSON.stringify({ [addr.toLowerCase()]: record }));
}

// Valid cursor fixtures — each matches its module's validator.
const DEPOSIT = {
  burnTx: '0xdead',
  sourceDomain: 0,
  amountWei: '1000000',
  snRecipient: '0x1234',
  evmChainId: 1,
  maxFee: '20000', // net = 1_000_000 − 20_000 = 980_000
};
const RETURN = {
  phase: 'claim',
  accountIndex: 3,
  burnTx: '0xdead',
  sourceDomain: 0,
  amount: '500000',
  commitment: '123456',
  evmChainId: 1,
};
const BURN = {
  burnTxHash: '0xdead',
  eoaAddress: `0x${'cd'.repeat(20)}`,
  bidIndex: 2,
  amountHuman: '3', // → 3 × 10^decimals base units
  selection: {},
};
const CASH = {
  burnTxHash: '0xdead',
  destination: `0x${'ef'.repeat(20)}`,
  amount: '750000',
  evmChainId: 1,
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mMove.mockResolvedValue({ depositedNetWei: 980_000n, deposited: true });
  mRecover.mockResolvedValue({ stuck: 500_000n, claimTxHash: '0xclaim' });
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('getBridgeTransferStatus — per-cursor mapping', () => {
  it('pool-deposit cursor in isolation → into-pool / pool-deposit / no-signature', () => {
    recordPendingPoolDeposit(SN, 980_000n);
    const s = getBridgeTransferStatus({ snAddress: SN, evmAddress: EVM });
    expect(s).toEqual({
      direction: 'into-pool',
      phase: 'pool-deposit',
      needsSignature: false,
      amountWei: 980_000n,
      account: { snAddress: SN, evmAddress: EVM },
    });
  });

  it('cctp-mint-in cursor in isolation → into-pool / cctp-mint-in, net = gross − fee, snRecipient fallback', () => {
    put(KEY.deposit, EVM, DEPOSIT);
    const s = getBridgeTransferStatus({ evmAddress: EVM }); // no snAddress → fall back to snRecipient
    expect(s?.direction).toBe('into-pool');
    expect(s?.phase).toBe('cctp-mint-in');
    expect(s?.needsSignature).toBe(false);
    expect(s?.amountWei).toBe(980_000n);
    expect(s?.account.snAddress).toBe('0x1234');
    expect(s?.account.evmAddress).toBe(EVM);
  });

  it('return-to-pool cursor in isolation → into-pool / return-to-pool', () => {
    put(KEY.ret, EVM, RETURN);
    const s = getBridgeTransferStatus({ snAddress: SN, evmAddress: EVM });
    expect(s?.direction).toBe('into-pool');
    expect(s?.phase).toBe('return-to-pool');
    expect(s?.needsSignature).toBe(false);
    expect(s?.amountWei).toBe(500_000n);
  });

  it('cctp-mint-out cursor in isolation → from-pool / cctp-mint-out, amount parsed from human', () => {
    put(KEY.burn, EVM, BURN);
    const s = getBridgeTransferStatus({ snAddress: SN, evmAddress: EVM });
    expect(s?.direction).toBe('from-pool');
    expect(s?.phase).toBe('cctp-mint-out');
    expect(s?.needsSignature).toBe(false);
    expect(s?.amountWei).toBe(3n * 10n ** BigInt(config.depositToken.decimals));
  });

  it('cash-out cursor in isolation → from-pool / cash-out', () => {
    put(KEY.cash, EVM, CASH);
    const s = getBridgeTransferStatus({ snAddress: SN, evmAddress: EVM });
    expect(s?.direction).toBe('from-pool');
    expect(s?.phase).toBe('cash-out');
    expect(s?.needsSignature).toBe(false);
    expect(s?.amountWei).toBe(750_000n);
  });
});

describe('getBridgeTransferStatus — priority (most-advanced wins) + edge cases', () => {
  it('pool-deposit beats cctp-mint-in when both present', () => {
    recordPendingPoolDeposit(SN, 900_000n);
    put(KEY.deposit, EVM, DEPOSIT);
    expect(getBridgeTransferStatus({ snAddress: SN, evmAddress: EVM })?.phase).toBe('pool-deposit');
  });

  it('cash-out beats cctp-mint-out when both present', () => {
    put(KEY.cash, EVM, CASH);
    put(KEY.burn, EVM, BURN);
    expect(getBridgeTransferStatus({ snAddress: SN, evmAddress: EVM })?.phase).toBe('cash-out');
  });

  it('no cursors → null', () => {
    expect(getBridgeTransferStatus({ snAddress: SN, evmAddress: EVM })).toBeNull();
  });

  it('corrupt localStorage entry → null (no throw)', () => {
    localStorage.setItem(KEY.deposit, '{not json');
    expect(getBridgeTransferStatus({ snAddress: SN, evmAddress: EVM })).toBeNull();
  });

  it('disabled localStorage (getItem throws) → null (no throw)', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(() => getBridgeTransferStatus({ snAddress: SN, evmAddress: EVM })).not.toThrow();
    expect(getBridgeTransferStatus({ snAddress: SN, evmAddress: EVM })).toBeNull();
    spy.mockRestore();
  });
});

describe('getBridgeTransferStatusAsync — chain-aware fallback (#433)', () => {
  it('cursor present → returns the cursor status, chain read NOT called (hot path)', async () => {
    recordPendingPoolDeposit(SN, 980_000n);
    const s = await getBridgeTransferStatusAsync({ snAddress: SN, evmAddress: EVM });
    expect(s).toMatchObject({ direction: 'into-pool', phase: 'pool-deposit', amountWei: 980_000n });
    expect(mResidual).not.toHaveBeenCalled();
  });

  it('no cursor + residual > dust → synthesized pool-deposit status with amountWei === residual', async () => {
    mResidual.mockResolvedValue(120_000n);
    const s = await getBridgeTransferStatusAsync({ snAddress: SN, evmAddress: EVM });
    expect(mResidual).toHaveBeenCalledWith(SN);
    expect(s).toEqual({
      direction: 'into-pool',
      phase: 'pool-deposit',
      needsSignature: false,
      amountWei: 120_000n,
      account: { snAddress: SN, evmAddress: EVM },
    });
  });

  it('no cursor + residual <= dust → null (strict >; exactly the threshold is dust)', async () => {
    mResidual.mockResolvedValue(50_000n);
    expect(await getBridgeTransferStatusAsync({ snAddress: SN, evmAddress: EVM })).toBeNull();
  });

  it('chain read throws → null (fail-safe, does NOT throw)', async () => {
    mResidual.mockRejectedValue(new Error('rpc down'));
    await expect(
      getBridgeTransferStatusAsync({ snAddress: SN, evmAddress: EVM }),
    ).resolves.toBeNull();
  });

  it('no snAddress → null, chain read NOT called', async () => {
    expect(await getBridgeTransferStatusAsync({ evmAddress: EVM })).toBeNull();
    expect(mResidual).not.toHaveBeenCalled();
  });
});

describe('resumeBridgeTransfer — routing (never starts a new transfer)', () => {
  const status = (phase: BridgeTransferStatus['phase']): BridgeTransferStatus => ({
    direction: phase === 'cctp-mint-out' || phase === 'cash-out' ? 'from-pool' : 'into-pool',
    phase,
    needsSignature: false,
    amountWei: phase === 'return-to-pool' ? 500_000n : 980_000n,
    account: { snAddress: SN, evmAddress: EVM },
  });

  it('pool-deposit → moveIntoPool({ resume: true }), not recoverBridgeIn', async () => {
    const provider = { request: vi.fn() };
    const res = await resumeBridgeTransfer({ status: status('pool-deposit'), signature: SIGNATURE, provider });
    expect(mMove).toHaveBeenCalledTimes(1);
    expect(mMove.mock.calls[0][0]).toMatchObject({
      signature: SIGNATURE,
      funding: 'metamask',
      resume: true,
      provider,
    });
    expect(mRecover).not.toHaveBeenCalled();
    expect(res).toEqual({ completed: true, amountWei: 980_000n });
  });

  it('cctp-mint-in → moveIntoPool({ resume: true }) (same into-pool composite)', async () => {
    await resumeBridgeTransfer({ status: status('cctp-mint-in'), signature: SIGNATURE });
    expect(mMove).toHaveBeenCalledTimes(1);
    expect(mMove.mock.calls[0][0]).toMatchObject({ resume: true });
    expect(mRecover).not.toHaveBeenCalled();
  });

  it('return-to-pool → recoverBridgeIn({ signature, accountIndex }), not moveIntoPool', async () => {
    const res = await resumeBridgeTransfer({
      status: status('return-to-pool'),
      signature: SIGNATURE,
      accountIndex: 3,
    });
    expect(mRecover).toHaveBeenCalledTimes(1);
    expect(mRecover.mock.calls[0][0]).toMatchObject({ signature: SIGNATURE, accountIndex: 3 });
    expect(mMove).not.toHaveBeenCalled();
    expect(res).toEqual({ completed: true, amountWei: 500_000n });
  });

  it('return-to-pool WITHOUT accountIndex → fails closed (no orchestrator call)', async () => {
    await expect(
      resumeBridgeTransfer({ status: status('return-to-pool'), signature: SIGNATURE }),
    ).rejects.toThrow(/accountIndex/);
    expect(mRecover).not.toHaveBeenCalled();
    expect(mMove).not.toHaveBeenCalled();
  });

  it('cctp-mint-out → NOT_YET_RESUMABLE (deferred), neither orchestrator called', async () => {
    await expect(
      resumeBridgeTransfer({ status: status('cctp-mint-out'), signature: SIGNATURE }),
    ).rejects.toMatchObject({ code: 'NOT_YET_RESUMABLE', phase: 'cctp-mint-out' });
    expect(mMove).not.toHaveBeenCalled();
    expect(mRecover).not.toHaveBeenCalled();
  });

  it('cash-out → NOT_YET_RESUMABLE (deferred), neither orchestrator called', async () => {
    await expect(
      resumeBridgeTransfer({ status: status('cash-out'), signature: SIGNATURE }),
    ).rejects.toMatchObject({ code: 'NOT_YET_RESUMABLE', phase: 'cash-out' });
    expect(mMove).not.toHaveBeenCalled();
    expect(mRecover).not.toHaveBeenCalled();
  });
});
