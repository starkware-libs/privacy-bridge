import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { signMessage, type EthereumProvider } from './signMessage';
import { resetProviderDiscovery } from './injectedProvider';

// Signer-binding: signMessage must reject a signature that does NOT recover to
// the connected account. All in-browser key derivation keys off this signature,
// so a foreign signature (e.g. the active account in the extension drifted away
// from the one we connected — the MetaMask+Phantom hazard) would silently
// fund/control the WRONG identity. This is the load-bearing PR #124 guarantee;
// the injected path re-opens the surface it protects, so it is proven here.
//
// RED (pre-guard): signMessage returned the foreign signature unchecked — the
// assertion `await expect(...).rejects` fails because it RESOLVES with sig B.
// GREEN (with guard): it recovers the signer and throws the mismatch error.

// Two distinct throwaway keys, generated at runtime (no literal key material in
// the repo — the secrets scanner flags 0x-private-key literals). The test only
// needs two DIFFERENT accounts, not fixed values.
const KEY_A = generatePrivateKey();
const KEY_B = generatePrivateKey();
const ACCT_A = privateKeyToAccount(KEY_A);
const ACCT_B = privateKeyToAccount(KEY_B);

// A provider whose personal_sign signs the EXACT bytes it receives with KEY_B,
// regardless of the address argument — i.e. the wallet's active account (B) has
// drifted from the account the app connected (A).
function foreignSignerProvider(): EthereumProvider & { request: ReturnType<typeof vi.fn> } {
  return {
    request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'personal_sign') {
        return ACCT_B.signMessage({ message: { raw: params?.[0] as `0x${string}` } });
      }
      return null;
    }),
    on: () => {},
    removeListener: () => {},
  };
}

// A smart-account / ERC-1271 / EIP-7702 style signer: returns a signature that is
// NOT a canonical 65-byte EOA (ECDSA) signature. Derivation must reject this (fail
// closed) rather than re-key the user onto a different identity.
function nonEoaSignerProvider(
  sig: string,
): EthereumProvider & { request: ReturnType<typeof vi.fn> } {
  return {
    request: vi.fn(async ({ method }: { method: string }) =>
      method === 'personal_sign' ? sig : null,
    ),
    on: () => {},
    removeListener: () => {},
  };
}

// A correctly-behaving provider: signs with KEY_A, matching the connected addr.
function matchingSignerProvider(): EthereumProvider & { request: ReturnType<typeof vi.fn> } {
  return {
    request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'personal_sign') {
        return ACCT_A.signMessage({ message: { raw: params?.[0] as `0x${string}` } });
      }
      return null;
    }),
    on: () => {},
    removeListener: () => {},
  };
}

beforeEach(() => {
  resetProviderDiscovery();
});
afterEach(() => {
  resetProviderDiscovery();
  vi.clearAllMocks();
});

describe('signMessage signer-binding (injected path)', () => {
  it('throws when the recovered signer differs from the connected account', async () => {
    const provider = foreignSignerProvider();
    // We ask it to sign for account A, but it signs with B's key.
    await expect(signMessage(provider, ACCT_A.address, 'hello')).rejects.toThrow(
      /different account/i,
    );
    // The error names both accounts so the user can fix their extension.
    await expect(signMessage(provider, ACCT_A.address, 'hello')).rejects.toThrow(ACCT_B.address);
  });

  it('returns the signature when the recovered signer matches the connected account', async () => {
    const provider = matchingSignerProvider();
    const sig = await signMessage(provider, ACCT_A.address, 'hello');
    expect(sig).toMatch(/^0x[0-9a-f]+$/i);
  });
});

describe('signMessage EOA-format guard (rejects smart-account / non-ECDSA signatures)', () => {
  it('throws a clear error for a non-65-byte (ERC-1271 / smart-account) signature', async () => {
    const erc1271Sig = ('0x' + 'ab'.repeat(200)) as `0x${string}`; // 200 bytes, not 65
    const provider = nonEoaSignerProvider(erc1271Sig);
    await expect(signMessage(provider, ACCT_A.address, 'hello')).rejects.toThrow(
      /non-EOA signature format/i,
    );
  });
  it('rejects a too-short signature (fails closed BEFORE the ecrecover step)', async () => {
    const provider = nonEoaSignerProvider('0xdeadbeef');
    await expect(signMessage(provider, ACCT_A.address, 'hello')).rejects.toThrow(
      /non-EOA signature format/i,
    );
  });
});
