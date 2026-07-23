// Classifies a dead / reloaded browser-wallet extension and bounds the sign call.
//
// MetaMask's MV3 background worker is suspended on tab idle and re-created on
// auto-update; either severs the inpage↔extension port ("Extension context
// invalidated", "[ChromeTransport] chromePort disconnected"). Requests to the
// resulting zombie provider then reject with those opaque strings or HANG, so a
// personal_sign does nothing after the user approves the popup. Detect it so the
// UI can show actionable copy, and time the sign out so a hang can't stall forever.
//
// A SIGNATURE is safe to bound with a timeout: it moves no value and is
// deterministically re-derivable. This is NOT for value-moving relayed submits —
// never wrap a burn/deposit submit, whose retry is governed by the double-burn rules.

export const WALLET_UNAVAILABLE_RE =
  /extension context invalidated|chromeport disconnected|premature close|provider is disconnected|disconnected from all chains|lost connection|connection is lost|port closed|signature request timed out/i;

// EIP-1193 disconnect codes: 4900 (disconnected from all chains) / 4901 (chain
// disconnected). Some providers reject with only the code, no matching message.
const DISCONNECTED_CODES = new Set([4900, 4901]);

export const WALLET_UNAVAILABLE_COPY =
  'Your wallet extension lost its connection (it likely reloaded or updated). Fully ' +
  'close and reopen the extension, then refresh this page and sign again. Any ' +
  'in-progress deposit is safe — you can resume it after reconnecting.';

export function isWalletUnavailableError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  const causeCode = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (
    (typeof code === 'number' && DISCONNECTED_CODES.has(code)) ||
    (typeof causeCode === 'number' && DISCONNECTED_CODES.has(causeCode))
  ) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return WALLET_UNAVAILABLE_RE.test(message);
}

// Generous enough for a human to find + approve the real popup; short enough that a
// zombie provider surfaces instead of hanging indefinitely.
export const SIGN_TIMEOUT_MS = 120_000;

// Races a signing operation against a timeout. On timeout, rejects with the sentinel
// WALLET_UNAVAILABLE_RE matches, so callers' humanizeError maps it to actionable copy.
export async function withSignTimeout<T>(
  op: () => Promise<T>,
  timeoutMs: number = SIGN_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Signature request timed out')), timeoutMs);
  });
  try {
    return await Promise.race([op(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
