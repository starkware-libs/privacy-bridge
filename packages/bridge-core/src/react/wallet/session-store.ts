// Device-local record of a wallet session the user EXPLICITLY entered, so a page
// refresh doesn't drop them back to signed-out (the "Resume session" click on every
// reload). NON-SECRET by policy, like every other `pmp.*` key (see device-store.ts):
// the PUBLIC EVM address the session was entered for, the rdns of the wallet it was
// entered through, and when it was last confirmed. Never a signature or a private
// key — those stay in memory only, so the viewing key / private balance still need a
// fresh signature every visit.
//
// This record alone never reveals anything: it only makes the app OFFER to restore.
// The wallet stays the authority — WalletProvider re-reads `eth_accounts` and enters
// only if the SAME account is still authorized (a locked wallet or a revoked
// permission answers `[]`), through the SAME pinned provider.

import { getAddress, isAddressEqual } from 'viem';

// Frozen wire value — kept in sync with PMP_STORAGE_KEYS in device-store.ts so
// "Disconnect / Forget this device" wipes it. Never rename.
export const WALLET_SESSION_KEY = 'pmp.lastWallet';

// How long an entered session may be restored for. Slid forward on every
// successful restore, so an actively-used device stays connected while an abandoned
// one ages out on its own — the only mitigation that covers "left the browser open".
export const WALLET_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export type WalletSession = {
  // The public EVM address the session was entered for.
  address: string;
  // rdns of the wallet it was entered through, or null when it was entered against
  // an unambiguous lone `window.ethereum` global (no EIP-6963 pick).
  rdns: string | null;
  // Epoch ms the session was last entered/confirmed at (the TTL anchor).
  at: number;
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// Case-insensitive address equality that CANNOT throw on a malformed input (the
// persisted side is attacker-writable under localStorage compromise, and viem's
// checksum helpers throw on garbage). Anything that isn't a well-formed address is
// simply not equal.
export function addressesEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || !ADDRESS_RE.test(a) || !ADDRESS_RE.test(b)) return false;
  try {
    return isAddressEqual(getAddress(a), getAddress(b));
  } catch {
    return false;
  }
}

// Read the stored session, or null when absent / malformed / expired. Strict shape
// validation: a hand-written or corrupted entry must be ignored, never trusted.
export function readWalletSession(): WalletSession | null {
  const now = Date.now();
  try {
    const raw = localStorage.getItem(WALLET_SESSION_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { address, rdns, at } = parsed as Record<string, unknown>;
    if (typeof address !== 'string' || !ADDRESS_RE.test(address)) return null;
    if (rdns !== null && typeof rdns !== 'string') return null;
    if (typeof at !== 'number' || !Number.isFinite(at)) return null;
    // Expired, or stamped in the future (clock change / tampering) — treat both as
    // unusable and drop the record so it can't linger.
    if (at > now || now - at > WALLET_SESSION_TTL_MS) {
      clearWalletSession();
      return null;
    }
    return { address, rdns, at };
  } catch {
    // Disabled/quota-limited localStorage or unparseable JSON — no session.
    return null;
  }
}

// Record (or re-stamp) the entered session. Best-effort: a disabled localStorage
// must not break connect/resume, it just means no restore next visit.
export function writeWalletSession(session: { address: string; rdns: string | null }): void {
  if (!ADDRESS_RE.test(session.address)) return;
  try {
    localStorage.setItem(
      WALLET_SESSION_KEY,
      JSON.stringify({
        address: session.address,
        rdns: session.rdns,
        at: Date.now(),
      } satisfies WalletSession),
    );
  } catch {
    // ignore — persisting is best-effort.
  }
}

export function clearWalletSession(): void {
  try {
    localStorage.removeItem(WALLET_SESSION_KEY);
  } catch {
    // ignore — clearing is best-effort.
  }
}
