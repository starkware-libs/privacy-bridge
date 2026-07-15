import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for the load-bearing internals of the register idempotency fix:
//   - isRegistered() parses the pool's get_public_key view (non-zero felt =>
//     registered) and FAILS OPEN to false on any RPC/parse error, and
//   - isAlreadyRegisteredError() recognises ONLY the pool's write-once
//     NON_ZERO_VALUE revert (so unrelated failures still propagate).
// The orchestrator/standalone-register tests mock register.ts wholesale, so
// these are the only tests that pin the predicate the whole fix rests on.
//
// We mock just the RPC provider boundary; the rest of register.ts is real.

const callContract = vi.fn();
vi.mock('./provider', () => ({
  getRpcProvider: () => ({ callContract }),
}));

import { isAlreadyRegisteredError, isRegistered } from './register';

const ADDRESS = '0x123';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isRegistered', () => {
  it('is true when get_public_key returns a non-zero felt', async () => {
    callContract.mockResolvedValue(['0x123']);
    await expect(isRegistered(ADDRESS)).resolves.toBe(true);
  });

  it('is false when get_public_key returns zero (unregistered default)', async () => {
    callContract.mockResolvedValue(['0x0']);
    await expect(isRegistered(ADDRESS)).resolves.toBe(false);
  });

  it('is false (not a throw) when the result is empty', async () => {
    callContract.mockResolvedValue([]);
    await expect(isRegistered(ADDRESS)).resolves.toBe(false);
  });

  it('is false (not a throw) when the result is undefined', async () => {
    callContract.mockResolvedValue(undefined as unknown as string[]);
    await expect(isRegistered(ADDRESS)).resolves.toBe(false);
  });

  it('fails open to false (no throw) when callContract rejects', async () => {
    callContract.mockRejectedValue(new Error('RPC down'));
    await expect(isRegistered(ADDRESS)).resolves.toBe(false);
  });

  it('queries the pool get_public_key view with the address as calldata', async () => {
    callContract.mockResolvedValue(['0x0']);
    await isRegistered(ADDRESS);
    expect(callContract).toHaveBeenCalledTimes(1);
    const arg = callContract.mock.calls[0][0];
    expect(arg.entrypoint).toBe('get_public_key');
    expect(arg.calldata).toEqual([ADDRESS]);
  });
});

describe('isAlreadyRegisteredError', () => {
  it('matches the pool write-once revert as submitAndTrack surfaces it', () => {
    // Mirrors submitAndTrack's REVERTED message shape (tx.ts): the
    // failure_reason (NON_ZERO_VALUE) is embedded after "REVERTED:".
    const err = new Error('submitAndTrack: 0xabc REVERTED: NON_ZERO_VALUE');
    expect(isAlreadyRegisteredError(err)).toBe(true);
  });

  it('matches when the reason is carried on a non-Error value', () => {
    expect(isAlreadyRegisteredError('REVERTED: NON_ZERO_VALUE')).toBe(true);
  });

  it('does NOT match an unrelated revert/error (so it still propagates)', () => {
    expect(isAlreadyRegisteredError(new Error('submitAndTrack: 0xabc REVERTED: INSUFFICIENT_BALANCE'))).toBe(false);
    expect(isAlreadyRegisteredError(new Error('network timeout'))).toBe(false);
  });
});
