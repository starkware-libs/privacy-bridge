// Secret-hygiene test helper.
//
// Slice 0 prereq for the new orchestrators (moveIntoPool/fundBid/cashOut/
// returnToPool, Slices E/F/G): those take the raw wallet `signature` in-memory
// and must derive keys internally WITHOUT ever logging or persisting the
// signature or any derived private key. This helper stubs the sinks a leak
// would go through — console.* and localStorage/sessionStorage — and asserts
// none of the captured arguments contain a given secret value.
//
// Usage in a core orchestrator test:
//   const sinks = spyOnSecretSinks();
//   await moveIntoPool({ signature, ... });
//   sinks.assertNeverLeaked(signature);
//   sinks.restore();

import { vi } from 'vitest';

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';

const CONSOLE_METHODS: ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug'];

/** Recursively stringifies an argument so a leaked secret is found even when
 *  nested inside an object/array/Error, not just passed as a bare string. */
function flatten(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return `${value.message} ${flatten(value.stack ?? '')}`;
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export interface SecretSinkSpy {
  /** Every argument ever passed to console.* or Storage.setItem, flattened to strings. */
  captured: string[];
  /** Throws if `secret` (or any of `secrets`) appears in any captured argument. */
  assertNeverLeaked(...secrets: (string | undefined | null)[]): void;
  /** Restores the original console/localStorage/sessionStorage. */
  restore(): void;
}

/**
 * Stubs console.* and localStorage/sessionStorage.setItem for the duration of
 * a test, recording every argument passed through them. Call `restore()` in
 * afterEach (or rely on the caller's own `vi.restoreAllMocks()`).
 */
export function spyOnSecretSinks(): SecretSinkSpy {
  const captured: string[] = [];
  const record = (...args: unknown[]): void => {
    for (const arg of args) captured.push(flatten(arg));
  };

  const consoleSpies = CONSOLE_METHODS.map((method) =>
    vi.spyOn(console, method).mockImplementation(record),
  );

  // jsdom's localStorage/sessionStorage are Proxy-backed (arbitrary property
  // assignment is trapped as a storage key write, not a method override), so
  // vi.spyOn / direct `storage.setItem = fn` don't intercept reliably. Instead
  // wrap the whole global in a pass-through Proxy that only special-cases
  // `setItem`, installed via vi.stubGlobal so it's cheaply reversible.
  const stubbedGlobals: ('localStorage' | 'sessionStorage')[] = [];
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    const target = typeof globalThis[name] !== 'undefined' ? globalThis[name] : undefined;
    if (!target) continue;
    const wrapped = new Proxy(target, {
      get(t, prop, _receiver): unknown {
        if (prop === 'setItem') {
          // Record the write for leak inspection AND pass it through to the real
          // storage — so a flow that reads back its own writes (e.g. a resume-cursor
          // storage probe) still behaves normally under the spy; a no-op setItem
          // would break such flows without improving leak detection.
          return (key: string, value: string): void => {
            record(key, value);
            (t.setItem as (k: string, v: string) => void).call(t, key, value);
          };
        }
        const v = Reflect.get(t, prop);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    vi.stubGlobal(name, wrapped);
    stubbedGlobals.push(name);
  }

  return {
    captured,
    assertNeverLeaked(...secrets: (string | undefined | null)[]): void {
      for (const secret of secrets) {
        if (!secret) continue;
        const hit = captured.find((c) => c.includes(secret));
        if (hit) {
          throw new Error(
            `spyOnSecretSinks: secret value leaked into console/localStorage/sessionStorage: "${hit}"`,
          );
        }
      }
    },
    restore(): void {
      for (const spy of consoleSpies) spy.mockRestore();
      if (stubbedGlobals.length) vi.unstubAllGlobals();
    },
  };
}
