import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { signMessage, type EthereumProvider } from './signMessage';

// signMessage bounds the personal_sign request with withSignTimeout: a zombie
// provider (extension reloaded mid-idle) can leave the request pending forever — the
// approval can't route back through the dead port — so the seam must time out into an
// actionable error rather than hang. Assert the driver directly (a hung request must
// reject), since a mock that only ever resolves would leave the timeout uncovered.

const KEY = generatePrivateKey();
const ACCT = privateKeyToAccount(KEY);

// A provider whose personal_sign never resolves — models the severed port.
function hungProvider(): EthereumProvider {
  return {
    request: vi.fn(() => new Promise(() => {})),
    on: () => {},
    removeListener: () => {},
  } as unknown as EthereumProvider;
}

// A well-behaved provider that signs the exact bytes with the connected account, so
// the timeout wrapper is transparent on the happy path (recover-check still passes).
function goodProvider(): EthereumProvider {
  return {
    request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'personal_sign') {
        return ACCT.signMessage({ message: { raw: params?.[0] as `0x${string}` } });
      }
      return null;
    }),
    on: () => {},
    removeListener: () => {},
  } as unknown as EthereumProvider;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('signMessage — timeout on a dead provider', () => {
  it('rejects with the timeout sentinel when the provider never responds', async () => {
    vi.useFakeTimers();
    const p = signMessage(hungProvider(), ACCT.address, 'sign me');
    const assertion = expect(p).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
  });

  it('returns the signature unchanged on the happy path (wrapper is transparent)', async () => {
    const sig = await signMessage(goodProvider(), ACCT.address, 'sign me');
    expect(sig).toMatch(/^0x[0-9a-fA-F]{130}$/);
  });
});
