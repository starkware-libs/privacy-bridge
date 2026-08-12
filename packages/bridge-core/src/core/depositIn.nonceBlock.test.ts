// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// is_nonce_used is read at two different finalities on purpose. The default stays
// pre_confirmed — the fastest stable view, which every existing caller uses to SKIP work it
// would otherwise redo. A caller whose conclusion DELETES the user's only handle on in-flight
// funds (the return-WAL `claimed` verdict) must instead read committed state: a pre-confirmed
// claim that never commits would delete the record against a claim that never happened.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { contractAddress: string; entrypoint: string; calldata: string[] };
const { callContract } = vi.hoisted(() => ({
  callContract: vi.fn(async () => ['0x0'] as string[]),
}));

vi.mock('./provider', () => ({ getRpcProvider: vi.fn(() => ({ callContract })) }));

import { isCctpMessageNonceUsed } from './depositIn';
import { READ_BLOCK } from './tx';

// MessageV2 header carrying nonce 0x2a at bytes [12..44), then a body — only the nonce is read.
const NONCE = 42n;
function messageWithNonce(nonce: bigint): `0x${string}` {
  const u32 = (n: number) => n.toString(16).padStart(8, '0');
  const header =
    u32(1) + u32(7) + u32(25) + nonce.toString(16).padStart(64, '0') + '00'.repeat(32 * 3);
  return `0x${header}${'00'.repeat(64)}` as `0x${string}`;
}
const MESSAGE = messageWithNonce(NONCE);

function blockArgOf(index = 0): unknown {
  return callContract.mock.calls[index]![1];
}

beforeEach(() => {
  vi.clearAllMocks();
  callContract.mockResolvedValue(['0x0']);
});

describe('isCctpMessageNonceUsed finality', () => {
  it('reads at the default pre-confirmed block when no finality is requested', async () => {
    await isCctpMessageNonceUsed(MESSAGE);

    expect(blockArgOf()).toBe(READ_BLOCK);
    expect(READ_BLOCK).toBe('pre_confirmed');
  });

  it('reads at the caller supplied block identifier', async () => {
    await isCctpMessageNonceUsed(MESSAGE, { blockIdentifier: 'latest' });

    expect(blockArgOf()).toBe('latest');
  });

  it('still decodes the nonce and the result the same way', async () => {
    callContract.mockResolvedValue(['0x1']);

    expect(await isCctpMessageNonceUsed(MESSAGE, { blockIdentifier: 'latest' })).toBe(true);
    const [call] = callContract.mock.calls[0]! as [Call, unknown];
    expect(call.entrypoint).toBe('is_nonce_used');
    expect(BigInt(call.calldata[0]!)).toBe(NONCE);
    expect(BigInt(call.calldata[1]!)).toBe(0n);
  });
});
