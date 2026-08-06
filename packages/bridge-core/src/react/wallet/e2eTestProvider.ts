// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// DEV/TEST-ONLY synthetic EIP-1193 provider for automated E2E of the
// WalletConnect-only wallet layer — NO real WC relay / QR / phone.
//
// Why this exists: PR #144 made the wallet layer WalletConnect-only and removed
// injected `window.ethereum` support, so the old apps/web E2E technique (inject a
// provider into window.ethereum) no longer has a seam. This module plugs into the
// SAME path the real provider uses — getWalletConnectProvider() — so a chrome MCP
// driver can connect→sign without a wallet.
//
// SAFETY POSTURE (must not regress):
//   - OFF BY DEFAULT. Only active when the injected config.e2eWallet flag is truthy.
//     getWalletConnectProvider() consults isE2EWalletEnabled() FIRST and returns
//     this synthetic provider only then; a normal build never imports/activates it
//     (the dynamic import means it lives in a lazy chunk the prod entry never fetches).
//   - The explicit-connect gate is PRESERVED: `session` starts undefined and
//     request() THROWS until connect() is called — identical to the real WC
//     provider's load-bearing behaviour the WalletProvider gates rely on.
//   - Fixed THROWAWAY test key — never a real seed; signMessage's signer-binding
//     guard still runs (the key's address is reported from eth_(request)accounts and
//     personal_sign recovers to it). Nothing is logged or persisted.
//
// The driver entry point is unchanged: render the app with the E2E-wallet flag set
// (the app maps its env → config.e2eWallet), then click Connect
// (WalletProvider.connect() resolves through this provider). The connected account
// is E2E_TEST_ADDRESS (derived from E2E_TEST_PRIVATE_KEY below).

import { privateKeyToAccount } from 'viem/accounts';
import { config } from '../../core/config';
import type { WcProvider } from './getWalletConnectProvider';

// Throwaway, well-known Hardhat/Anvil account #0 key. PUBLIC by design — it is a
// test fixture, never a real seed, and only ever signs throwaway E2E sessions.
export const E2E_TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

const e2eAccount = privateKeyToAccount(E2E_TEST_PRIVATE_KEY);
// Checksummed address the synthetic wallet connects as (Anvil account #0).
export const E2E_TEST_ADDRESS = e2eAccount.address;

// Truthy config.e2eWallet (any non-empty value other than 'false'/'0') turns the
// seam on. Off by default — the flag is unset in normal/prod builds.
export function isE2EWalletEnabled(): boolean {
  const flag = config.e2eWallet;
  return !!flag && flag !== 'false' && flag !== '0';
}

// Build a synthetic provider matching the WcProvider surface (connect/disconnect/
// session + EIP-1193 request/on/removeListener). Each call is a fresh instance so
// test isolation never bleeds session state between renders.
export function createE2ETestProvider(): WcProvider {
  let session: unknown;
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const hexAddress = E2E_TEST_ADDRESS as `0x${string}`;
  // Polygon Amoy (80002) — the testnet the standalone bridge defaults to. The WC
  // layer only reads this to track chainId; the per-account EOA does the on-chain work.
  const CHAIN_ID_HEX = '0x13882';

  const provider: WcProvider = {
    isWalletConnect: true,
    // session-less until connect() — preserves the pre-session request() gate.
    get session() {
      return session;
    },
    async connect() {
      session = { topic: 'e2e-test-session' };
    },
    async disconnect() {
      session = undefined;
    },
    async request({ method, params }: { method: string; params?: unknown[] }) {
      // Same gate as the real WC provider: no request() before a session exists.
      if (!session) throw new Error('Please call connect() before request()');
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [hexAddress];
        case 'eth_chainId':
          return CHAIN_ID_HEX;
        case 'net_version':
          return String(parseInt(CHAIN_ID_HEX, 16));
        case 'personal_sign': {
          // personal_sign param order is [data, address]; sign the exact bytes so
          // signMessage's recover-and-compare guard passes against E2E_TEST_ADDRESS.
          const raw = params?.[0] as `0x${string}`;
          return e2eAccount.signMessage({ message: { raw } });
        }
        case 'eth_signTypedData_v4': {
          // Real EIP-712 signature from the throwaway key so any typed-data signing can be
          // driven end-to-end in automation. params = [address, jsonTypedData]; uint256
          // fields are encoded as decimal strings — the wire form viem accepts.
          // signer-binding still holds: the signer is E2E_TEST_ADDRESS.
          const typed = JSON.parse(params?.[1] as string) as Parameters<
            typeof e2eAccount.signTypedData
          >[0];
          return e2eAccount.signTypedData(typed);
        }
        // Chain switches are no-ops over this synthetic session (mirrors the WC
        // layer, which doesn't force a switch — the connected wallet only signs).
        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain':
          return null;
        default:
          return null;
      }
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      (handlers[event] ??= []).push(handler);
    },
    removeListener(event: string, handler: (...args: unknown[]) => void) {
      const list = handlers[event];
      if (list) {
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
      }
    },
  };
  return provider;
}
