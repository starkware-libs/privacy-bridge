// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Shared pre-flight storage-writability probe (Bundle A2 pattern). Before an
// irreversible on-chain burn/withdraw that persists a resume cursor, prove
// localStorage actually accepts a write + read-back. If it can't (private-
// browsing, disabled storage, quota), the in-flight cursor written AFTER the burn
// would silently vanish — a reload then can't resume and the user could re-burn
// (double-spend). Throw a TERMINAL error so callers NEVER burn when they can't
// persist the resume cursor. (Never call this on a resume path: it has already
// burned, so refusing to resume would strand funds.)
//
// Shared by bridgeOut.ts (fund-account / cash-out), depositIn.ts (deposit-in),
// and returnIn.ts (return leg) — each with its own probe key + action noun so
// their error text (and the localStorage key they write) is unchanged by this
// dedupe.
export function assertStorageWritable(probeKey: string, actionNoun: string): void {
  const token = `${Date.now()}:${Math.random()}`;
  let readBack: string | null;
  try {
    localStorage.setItem(probeKey, token);
    readBack = localStorage.getItem(probeKey);
    localStorage.removeItem(probeKey);
  } catch {
    readBack = null;
  }
  if (readBack !== token) {
    throw new Error(
      `Browser storage is unavailable — ${actionNoun} can't be safely resumed; disable ` +
        'private-browsing/enable storage and retry.',
    );
  }
}
