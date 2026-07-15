// Tests for recoverBridgeIn — FOLD-ONLY, CURSOR-DRIVEN recovery of a return that BURNED
// but whose folded claim never landed. Recovery matches THIS identity's persisted burn
// cursor by commitment, re-fetches the attestation, checks the CCTP nonce, and either
// no-ops (already claimed) or runs the SAME folded claim. There is no cross-device
// claimable_of scan anymore (the fold-only InboundAnonymizer has no ledger; the folded
// claim needs the CCTP message, obtainable only from the persisted burn tx via Iris).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { waitForAttestation, callContract, claimToPool, attestedMessage } = vi.hoisted(() => ({
  waitForAttestation: vi.fn<
    (
      burnTx: string,
      opts: { sourceDomain?: number; onStatus?: (s: string) => void },
    ) => Promise<{ message: `0x${string}`; attestation: `0x${string}` }>
  >(),
  callContract: vi.fn(async () => ['0x0'] as string[]),
  claimToPool: vi.fn(async () => ({ claimTxHash: '0xc1a1m' })),
  attestedMessage: { value: '0x' as `0x${string}` },
}));

function buildCctpMessage(recipientField64: string): `0x${string}` {
  const u32 = (n: number) => n.toString(16).padStart(8, '0');
  const header =
    u32(1) + u32(7) + u32(25) + '00'.repeat(32 * 3) + recipientField64.toLowerCase() + u32(1000) + u32(1000);
  const body =
    u32(1) + '00'.repeat(32) + recipientField64.toLowerCase() + '00'.repeat(32) + '00'.repeat(32);
  return `0x${header}${body}` as `0x${string}`;
}

vi.mock('./polygonMint', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./polygonMint')>();
  return { ...mod, waitForAttestation };
});
vi.mock('./tx', () => ({
  READ_BLOCK: 'pre_confirmed',
  submitAndTrack: vi.fn(async (_p: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./provider', () => ({ getRpcProvider: vi.fn(() => ({ callContract })) }));
// recoverBridgeIn drives the folded claim via bridgeBack.claimToPool — mock it so we can
// assert the message/attestation/sourceDomain are threaded through.
vi.mock('./bridgeBack', () => ({ claimToPool, buildAndProveClaim: vi.fn(), submitProvenClaim: vi.fn() }));
vi.mock('./config', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./config')>();
  return { ...mod, config: { ...mod.config, inboundAnonymizerAddress: '0x49abc' } };
});

import { config } from './config';
import {
  recoverBridgeIn,
  INFLIGHT_RETURN_KEY,
} from './returnIn';
import {
  deriveAccountNonce,
  deriveInboundCommitment,
  deriveStarknetAccount,
  deriveStarknetPrivateKey,
  deriveViewingKey,
} from '../derivation/index';

const SIGNATURE = `0x${'ab'.repeat(65)}`;
const ACCOUNT_INDEX = 4;
const EVM_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const AMOUNT = 1_234_567n;
const BURN_TX = '0x0ab12cd34e';
const ATTESTATION = `0x${'bb'.repeat(65)}` as `0x${string}`;
const INBOUND_FIELD64 = config.inboundAnonymizerAddress.replace(/^0x/i, '').toLowerCase().padStart(64, '0');

function commitmentFor(index: number): string {
  const viewingKey = deriveViewingKey(SIGNATURE);
  const snPrivateKey = deriveStarknetPrivateKey(SIGNATURE);
  const { address } = deriveStarknetAccount(snPrivateKey, config.ozClassHash);
  return deriveInboundCommitment({
    userAddr: BigInt(address),
    userPrivateKey: viewingKey,
    inboundAddr: BigInt(config.inboundAnonymizerAddress),
    sourceDomain: config.polygon.domain,
    nonce: deriveAccountNonce(viewingKey, index),
  }).toString();
}

function commitmentForInbound(index: number, inbound: string): string {
  const viewingKey = deriveViewingKey(SIGNATURE);
  const snPrivateKey = deriveStarknetPrivateKey(SIGNATURE);
  const { address } = deriveStarknetAccount(snPrivateKey, config.ozClassHash);
  return deriveInboundCommitment({
    userAddr: BigInt(address),
    userPrivateKey: viewingKey,
    inboundAddr: BigInt(inbound),
    sourceDomain: config.polygon.domain,
    nonce: deriveAccountNonce(viewingKey, index),
  }).toString();
}

function seedCursor(index: number): void {
  localStorage.setItem(
    INFLIGHT_RETURN_KEY,
    JSON.stringify({
      [EVM_ADDRESS.toLowerCase()]: {
        accountIndex: index,
        burnTx: BURN_TX,
        sourceDomain: config.polygon.domain,
        amount: AMOUNT.toString(),
        commitment: commitmentFor(index),
        evmChainId: config.polygon.chainId,
      },
    }),
  );
}

// A cursor whose burn predates a config redeploy: it pins an OLD inbound address and its
// commitment is derived against THAT old address (not the current config).
function seedRedeployCursor(index: number, oldInbound: string): void {
  localStorage.setItem(
    INFLIGHT_RETURN_KEY,
    JSON.stringify({
      [EVM_ADDRESS.toLowerCase()]: {
        accountIndex: index,
        burnTx: BURN_TX,
        sourceDomain: config.polygon.domain,
        amount: AMOUNT.toString(),
        commitment: commitmentForInbound(index, oldInbound),
        evmChainId: config.polygon.chainId,
        inboundAnonymizer: oldInbound,
      },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  callContract.mockResolvedValue(['0x0']); // is_nonce_used → NOT used by default
  attestedMessage.value = buildCctpMessage(INBOUND_FIELD64);
  waitForAttestation.mockImplementation(async () => ({
    message: attestedMessage.value,
    attestation: ATTESTATION,
  }));
  claimToPool.mockResolvedValue({ claimTxHash: '0xc1a1m' });
});

afterEach(() => {
  localStorage.clear();
});

describe('recoverBridgeIn', () => {
  it('fails closed when inboundAnonymizerAddress is the "0x0" placeholder', async () => {
    const original = config.inboundAnonymizerAddress;
    (config as { inboundAnonymizerAddress: string }).inboundAnonymizerAddress = '0x0';
    try {
      await expect(recoverBridgeIn({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX })).rejects.toThrow(
        /inboundAnonymizerAddress not configured|nothing to recover/i,
      );
      expect(claimToPool).not.toHaveBeenCalled();
    } finally {
      (config as { inboundAnonymizerAddress: string }).inboundAnonymizerAddress = original;
    }
  });

  it('is a no-op (no claim) when there is no cursor for this identity on this device', async () => {
    const res = await recoverBridgeIn({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX });
    expect(res.stuck).toBe(0n);
    expect(res.claimTxHash).toBeUndefined();
    expect(claimToPool).not.toHaveBeenCalled();
    expect(waitForAttestation).not.toHaveBeenCalled();
  });

  it('recovers a burned-but-unclaimed cursor: attests, folds the message into the claim, clears the cursor', async () => {
    seedCursor(ACCOUNT_INDEX);
    const res = await recoverBridgeIn({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX });

    expect(waitForAttestation).toHaveBeenCalledTimes(1);
    expect(waitForAttestation.mock.calls[0][0]).toBe(BURN_TX);
    // The folded claim carries the CCTP message/attestation/sourceDomain.
    expect(claimToPool).toHaveBeenCalledTimes(1);
    const claimArgs = claimToPool.mock.calls[0][0] as {
      message: `0x${string}`;
      attestation: `0x${string}`;
      sourceDomain: number;
      accountIndex: number;
    };
    expect(claimArgs.message).toBe(attestedMessage.value);
    expect(claimArgs.attestation).toBe(ATTESTATION);
    expect(claimArgs.sourceDomain).toBe(config.polygon.domain);
    expect(claimArgs.accountIndex).toBe(ACCOUNT_INDEX);
    expect(res).toEqual({ stuck: AMOUNT, claimTxHash: '0xc1a1m' });
    // Cursor cleared after the claim.
    expect(localStorage.getItem(INFLIGHT_RETURN_KEY)).toBe('{}');
  });

  it('[config redeploy] FINDS a cursor whose burn predates a config change and claims against the BURN-TIME inbound', async () => {
    // FINDING A: config.inboundAnonymizerAddress is now the NEW address ('0x49abc'); the
    // cursor's burn pinned the OLD one. Recovery must (a) still FIND the cursor (its
    // commitment is derived against the OLD address, not current config) and (b) claim
    // against the OLD contract that holds the CCTP funds.
    const OLD_INBOUND = '0xbeef01';
    expect(OLD_INBOUND).not.toBe(config.inboundAnonymizerAddress);
    seedRedeployCursor(ACCOUNT_INDEX, OLD_INBOUND);

    const res = await recoverBridgeIn({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX });

    expect(claimToPool).toHaveBeenCalledTimes(1);
    const claimArgs = claimToPool.mock.calls[0][0] as { inbound?: string };
    expect(claimArgs.inbound).toBe(OLD_INBOUND);
    expect(res).toEqual({ stuck: AMOUNT, claimTxHash: '0xc1a1m' });
    expect(localStorage.getItem(INFLIGHT_RETURN_KEY)).toBe('{}');
  });

  it('short-circuits (no claim) when the CCTP nonce is already consumed — the folded claim already landed', async () => {
    seedCursor(ACCOUNT_INDEX);
    callContract.mockResolvedValue(['0x1']); // is_nonce_used → used
    const res = await recoverBridgeIn({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX });
    expect(claimToPool).not.toHaveBeenCalled();
    expect(res.stuck).toBe(0n);
    // Dead cursor cleared.
    expect(localStorage.getItem(INFLIGHT_RETURN_KEY)).toBe('{}');
  });

  it('does NOT recover a cursor whose commitment belongs to a DIFFERENT account index', async () => {
    seedCursor(ACCOUNT_INDEX + 1); // cursor's commitment is for a different index
    const res = await recoverBridgeIn({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX });
    expect(res.stuck).toBe(0n);
    expect(claimToPool).not.toHaveBeenCalled();
  });

  it('clears the cursor + throws on a demonstrably-terminal attestation failure', async () => {
    seedCursor(ACCOUNT_INDEX);
    waitForAttestation.mockRejectedValueOnce(new Error('Iris: attestation failed'));
    await expect(recoverBridgeIn({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX })).rejects.toThrow(
      /attestation failed/i,
    );
    expect(localStorage.getItem(INFLIGHT_RETURN_KEY)).toBe('{}');
    expect(claimToPool).not.toHaveBeenCalled();
  });

  it('PRESERVES the cursor + throws on a non-terminal attestation error (resume stays possible)', async () => {
    seedCursor(ACCOUNT_INDEX);
    waitForAttestation.mockRejectedValueOnce(new Error('transient network blip'));
    await expect(recoverBridgeIn({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX })).rejects.toThrow(
      /transient network blip/i,
    );
    // Cursor still present for a later resume.
    expect(localStorage.getItem(INFLIGHT_RETURN_KEY)).not.toBe('{}');
    expect(claimToPool).not.toHaveBeenCalled();
  });
});
