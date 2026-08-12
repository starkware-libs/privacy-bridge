// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// The funding anchor is what lets "no burn found" be PROVEN instead of assumed. These tests
// pin the three verdicts and, above all, that a read which throws never degrades into one:
// an RPC failure must reject, never report absence.

import { describe, expect, it, vi } from 'vitest';

import type { PublicClient } from 'viem';

import { initTestConfig } from '../../vitest.setup';
import { config } from './config';
import { RECOVERY_CAP_BLOCKS, resolveFundingAnchor, type FundingAnchor } from './fundingAnchor';

const WALLET = '0x00000000000000000000000000000000000000c0' as const;
const CODE = '0x60006000' as const;

// A chain whose deposit wallet holds code from `deployBlock` onward (null = never).
// `getCode` mirrors viem's real return shape: `undefined` for a codeless address
// (viem collapses the RPC's '0x' before returning — see viem/actions/public/getCode).
function fakeChain(opts: { head: bigint; deployBlock: bigint | null; emptyAs?: '0x' }) {
  const empty = opts.emptyAs;
  const getCode = vi.fn(
    async ({ blockNumber }: { address: `0x${string}`; blockNumber?: bigint }) => {
      const at = blockNumber ?? opts.head;
      const deployed = opts.deployBlock !== null && at >= opts.deployBlock;
      return deployed ? CODE : empty;
    },
  );
  const getBlockNumber = vi.fn(async () => opts.head);
  return {
    getCode,
    getBlockNumber,
    client: { getCode, getBlockNumber } as unknown as PublicClient,
    blocksRead: () => getCode.mock.calls.map((c) => c[0].blockNumber),
  };
}

describe('resolveFundingAnchor', () => {
  it('exports a cap that mirrors the config default (a drifting mirror is stale by default)', () => {
    expect(RECOVERY_CAP_BLOCKS).toBe(2_592_000n);
    expect(BigInt(config.recoveryCapBlocks)).toBe(RECOVERY_CAP_BLOCKS);
  });

  it('reports never-deployed from ONE read when the wallet has no code at head', async () => {
    const chain = fakeChain({ head: 91_813_583n, deployBlock: null });

    await expect(resolveFundingAnchor(chain.client, WALLET)).resolves.toEqual<FundingAnchor>({
      kind: 'never-deployed',
    });
    expect(chain.getCode).toHaveBeenCalledTimes(1);
    expect(chain.blocksRead()).toEqual([91_813_583n]);
  });

  it("treats a raw '0x' as empty too (a provider that does not collapse it)", async () => {
    const chain = fakeChain({ head: 91_813_583n, deployBlock: null, emptyAs: '0x' });

    await expect(resolveFundingAnchor(chain.client, WALLET)).resolves.toEqual<FundingAnchor>({
      kind: 'never-deployed',
    });
    expect(chain.getCode).toHaveBeenCalledTimes(1);
  });

  it('reports beyond-cap from exactly TWO reads, with no binary search', async () => {
    const head = 91_813_583n;
    const chain = fakeChain({ head, deployBlock: head - RECOVERY_CAP_BLOCKS - 1n });

    await expect(resolveFundingAnchor(chain.client, WALLET)).resolves.toEqual<FundingAnchor>({
      kind: 'beyond-cap',
    });
    expect(chain.getCode).toHaveBeenCalledTimes(2);
    expect(chain.blocksRead()).toEqual([head, head - RECOVERY_CAP_BLOCKS]);
  });

  it('carries NO anchorBlock on beyond-cap — the search never ran', async () => {
    const head = 91_813_583n;
    const chain = fakeChain({ head, deployBlock: 1n });

    const anchor = await resolveFundingAnchor(chain.client, WALLET);
    expect(anchor.kind).toBe('beyond-cap');
    expect(anchor).not.toHaveProperty('anchorBlock');
  });

  it('binary-searches the true deployment block inside the cap window', async () => {
    const head = 91_813_583n;
    const deployBlock = 91_000_000n;
    const chain = fakeChain({ head, deployBlock });

    await expect(resolveFundingAnchor(chain.client, WALLET)).resolves.toEqual<FundingAnchor>({
      kind: 'anchored',
      anchorBlock: deployBlock,
      head,
    });
    // 2 boundary reads (head, cap floor) + ≤22 search steps for a 2.592M-block span.
    expect(chain.getCode.mock.calls.length).toBeLessThanOrEqual(24);
    expect(chain.getCode.mock.calls.length).toBeGreaterThan(2);
  });

  it('costs exactly log2(span) search reads plus the two boundaries', async () => {
    // cap 1024 ⇒ span 1024 ⇒ 10 halvings; deployBlock 1500 inside (976, 2000].
    const chain = fakeChain({ head: 2000n, deployBlock: 1500n });

    await expect(resolveFundingAnchor(chain.client, WALLET, 1024n)).resolves.toEqual<FundingAnchor>(
      {
        kind: 'anchored',
        anchorBlock: 1500n,
        head: 2000n,
      },
    );
    expect(chain.getCode).toHaveBeenCalledTimes(12);
  });

  it('finds a wallet deployed in the very block it is read at (deploy+burn in one tx)', async () => {
    const chain = fakeChain({ head: 2000n, deployBlock: 2000n });

    await expect(resolveFundingAnchor(chain.client, WALLET, 1024n)).resolves.toEqual<FundingAnchor>(
      {
        kind: 'anchored',
        anchorBlock: 2000n,
        head: 2000n,
      },
    );
  });

  it('clamps the cap floor at genesis instead of underflowing head − cap', async () => {
    const chain = fakeChain({ head: 5n, deployBlock: 3n });

    await expect(resolveFundingAnchor(chain.client, WALLET)).resolves.toEqual<FundingAnchor>({
      kind: 'anchored',
      anchorBlock: 3n,
      head: 5n,
    });
    for (const block of chain.blocksRead()) expect(block).toBeGreaterThanOrEqual(0n);
  });

  it('anchors at genesis rather than reporting beyond-cap when the cap already covers it', async () => {
    // Code at block 0 with a cap wider than the chain: [0, head] IS the complete history.
    const chain = fakeChain({ head: 5n, deployBlock: 0n });

    await expect(resolveFundingAnchor(chain.client, WALLET)).resolves.toEqual<FundingAnchor>({
      kind: 'anchored',
      anchorBlock: 0n,
      head: 5n,
    });
  });

  it('pins the head it read, so the caller scans the window the evidence covers', async () => {
    const chain = fakeChain({ head: 2000n, deployBlock: 1500n });

    await resolveFundingAnchor(chain.client, WALLET, 1024n);
    // Every read names an explicit block — never 'latest', which could drift past `head`.
    for (const block of chain.blocksRead()) expect(typeof block).toBe('bigint');
    expect(chain.blocksRead()[0]).toBe(2000n);
  });

  it('takes the cap from config when the caller passes none', async () => {
    initTestConfig({ RECOVERY_CAP_BLOCKS: '1024' });
    const chain = fakeChain({ head: 2000n, deployBlock: 1500n });

    await expect(resolveFundingAnchor(chain.client, WALLET)).resolves.toEqual<FundingAnchor>({
      kind: 'anchored',
      anchorBlock: 1500n,
      head: 2000n,
    });
    expect(chain.blocksRead()[1]).toBe(976n);
  });

  it('rejects a non-positive cap instead of looping forever', async () => {
    const chain = fakeChain({ head: 2000n, deployBlock: 1500n });

    await expect(resolveFundingAnchor(chain.client, WALLET, 0n)).rejects.toThrow(/cap/i);
  });

  describe('a read that throws is UNKNOWN, never absence', () => {
    const boom = new Error('rpc 429');

    it('rejects when the HEAD read throws', async () => {
      const chain = fakeChain({ head: 2000n, deployBlock: 1500n });
      chain.getCode.mockRejectedValueOnce(boom);

      await expect(resolveFundingAnchor(chain.client, WALLET, 1024n)).rejects.toBe(boom);
    });

    it('rejects when the CAP-FLOOR read throws', async () => {
      const chain = fakeChain({ head: 2000n, deployBlock: 1500n });
      chain.getCode.mockImplementationOnce(async () => CODE).mockRejectedValueOnce(boom);

      await expect(resolveFundingAnchor(chain.client, WALLET, 1024n)).rejects.toBe(boom);
    });

    it('rejects when a MID-SEARCH read throws', async () => {
      const chain = fakeChain({ head: 2000n, deployBlock: 1500n });
      chain.getCode
        .mockImplementationOnce(async () => CODE)
        .mockImplementationOnce(async () => undefined)
        .mockRejectedValueOnce(boom);

      await expect(resolveFundingAnchor(chain.client, WALLET, 1024n)).rejects.toBe(boom);
    });

    it('rejects when the HEAD-NUMBER read throws', async () => {
      const chain = fakeChain({ head: 2000n, deployBlock: 1500n });
      chain.getBlockNumber.mockRejectedValueOnce(boom);

      await expect(resolveFundingAnchor(chain.client, WALLET, 1024n)).rejects.toBe(boom);
    });
  });
});
