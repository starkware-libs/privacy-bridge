// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Coverage gaps in the wording-based classifier, found while extending #95:
// Safari/Firefox network-failure wordings, the HTTP-status allowlist, a WAF block
// page whose body says "rejected", and the object shapes only sanitizeErrorMessage
// used to understand.

import { describe, expect, it } from 'vitest';

import { isTransientError, markNonRetryable } from './errors.js';
import { sanitizeErrorMessage } from './tx.js';

describe('cross-browser network-failure wordings are transient', () => {
  it('classifies Safari/iOS "Load failed"', () => {
    expect(isTransientError(new TypeError('Load failed'))).toBe(true);
  });

  it('classifies Firefox "NetworkError when attempting to fetch resource."', () => {
    expect(
      isTransientError(new TypeError('NetworkError when attempting to fetch resource.')),
    ).toBe(true);
  });

  it('keeps the Chrome/Node wordings transient', () => {
    expect(isTransientError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isTransientError(new TypeError('fetch failed'))).toBe(true);
  });
});

describe('HTTP status allowlist covers every gateway/overload status', () => {
  it('classifies 500, 408 and the Cloudflare 52x family', () => {
    for (const status of [408, 500, 502, 503, 504, 520, 521, 522, 523, 524]) {
      expect(isTransientError(new Error(`Iris /v2/messages failed (${status})`))).toBe(true);
    }
  });

  it('does NOT match the same digits embedded in a hex string', () => {
    expect(isTransientError(new Error('reverted at 0x503abc503def'))).toBe(false);
    expect(isTransientError(new Error('nonce 0x408'))).toBe(false);
  });

  it('does NOT match a decimal fraction that happens to contain the digits', () => {
    expect(isTransientError(new Error('price drifted to 0.503 STRK'))).toBe(false);
  });

  it('does NOT read an arbitrary 5xx-shaped number in calldata or an amount as a status', () => {
    expect(
      isTransientError(
        new Error('paymaster_executeTransaction: calldata ["0x1","540","0"] … Account validation failed'),
      ),
    ).toBe(false);
    expect(isTransientError(new Error('ERC20 transfer of 550 failed'))).toBe(false);
  });
});

describe('revert / fee vocabulary outranks a status-shaped number in the same message', () => {
  it('keeps a viem contract revert terminal', () => {
    expect(
      isTransientError(
        new Error('The contract function reverted.\n gas: 500\n Details: execution reverted'),
      ),
    ).toBe(false);
  });

  it('keeps a max-fee shortfall terminal', () => {
    expect(isTransientError(new Error('Insufficient max fee: max fee is 500, actual fee is 900'))).toBe(
      false,
    );
  });
});

describe('a WAF/proxy block page whose BODY says "rejected" stays transient', () => {
  // safe-json.ts appends up to 200 chars of the upstream body to the status line, so a
  // 503 block page carries the word "rejected" into a message that is really a 5xx.
  const WAF_BODY = 'The requested URL was rejected. Please consult with your administrator.';

  it('classifies the 503 block page transient (the tx-status token is uppercase)', () => {
    expect(
      isTransientError(new Error(`AVNU paymaster paymaster_buildTransaction failed (503) — ${WAF_BODY}`)),
    ).toBe(true);
  });

  it('still classifies a real on-chain REJECTED tx status terminal', () => {
    expect(isTransientError(new Error('submitAndTrack: 0xabc REJECTED'))).toBe(false);
    // …even when a transient-looking token rides along in the same message.
    expect(isTransientError(new Error('submitAndTrack: 0xabc REJECTED: HTTP 503'))).toBe(false);
    expect(isTransientError(new Error('submitAndTrack: 0xabc REVERTED: fetch failed'))).toBe(false);
  });

  it('still classifies a user-cancelled wallet request terminal', () => {
    expect(isTransientError(new Error('User rejected the request. fetch failed'))).toBe(false);
    expect(isTransientError(new Error('MetaMask Tx Signature: User denied transaction signature. 503'))).toBe(
      false,
    );
    // Argent wordings.
    expect(isTransientError(new Error('User abort'))).toBe(false);
    expect(isTransientError(new Error('Rejected by user'))).toBe(false);
  });
});

describe('isTransientError and sanitizeErrorMessage read the SAME text', () => {
  it('classifies an HTTP-shaped baseError (no .message at all)', () => {
    expect(isTransientError({ baseError: { status: 502, statusText: 'Bad Gateway' } })).toBe(true);
  });

  it('classifies a non-Error object by its message instead of "[object Object]"', () => {
    expect(isTransientError({ message: 'Load failed' })).toBe(true);
  });

  it('agrees with the sanitized text across the shared fixture list', () => {
    const FIXTURES: unknown[] = [
      new TypeError('Load failed'),
      new TypeError('NetworkError when attempting to fetch resource.'),
      new Error('Iris /v2/messages failed (500)'),
      new Error('submitAndTrack: 0xabc REJECTED'),
      new Error('User rejected the request.'),
      { baseError: { status: 502, statusText: 'Bad Gateway' } },
      { baseError: { status: 400, statusText: 'Bad Request' } },
      { message: 'Load failed' },
    ];
    for (const fixture of FIXTURES) {
      expect([fixture, isTransientError(fixture)]).toEqual([
        fixture,
        isTransientError(sanitizeErrorMessage(fixture)),
      ]);
    }
  });

  it('walks err.cause so a wrapped network failure is still transient', () => {
    const wrapped = new Error('Deposit step failed', { cause: new TypeError('Load failed') });
    expect(isTransientError(wrapped)).toBe(true);
    const twice = new Error('outer', { cause: wrapped });
    expect(isTransientError(twice)).toBe(true);
  });

  it('walks err.cause for the TERMINAL verdict too (fail closed)', () => {
    const wrapped = new Error('Load failed', {
      cause: new Error('submitAndTrack: 0xabc REVERTED'),
    });
    expect(isTransientError(wrapped)).toBe(false);
  });

  it('keeps the NON_RETRYABLE brand ahead of everything, cause included', () => {
    const err = markNonRetryable(new Error('outer', { cause: new TypeError('Load failed') }));
    expect(isTransientError(err)).toBe(false);
  });
});
