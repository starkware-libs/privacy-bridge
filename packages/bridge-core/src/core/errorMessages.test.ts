// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { describe, expect, it } from 'vitest';
import { humanizeError, humanizeFinality } from './errorMessages';

// Error-message humanization (Bundle B4). humanizeError runs sanitizeErrorMessage
// FIRST (strip hex/cap length, tx.ts) so no key/witness material can leak, THEN
// maps a small ordered table of known on-chain signatures to actionable copy.
// Unknown errors fall through to the sanitized message unchanged.
describe('humanizeError', () => {
  describe('mapped signatures → actionable copy', () => {
    it('maps NON_ZERO_VALUE (write-once register) to an already-registered message', () => {
      expect(humanizeError(new Error('Transaction reverted: NON_ZERO_VALUE'))).toBe(
        'This account is already registered.',
      );
    });

    it('maps a dead/reloaded wallet extension error to actionable restart-and-refresh copy', () => {
      expect(humanizeError(new Error('Extension context invalidated.'))).toMatch(
        /lost its connection/i,
      );
      expect(humanizeError(new Error('[ChromeTransport] chromePort disconnected'))).toMatch(
        /refresh this page/i,
      );
    });

    it('maps an insufficient-balance revert to the check-your-funds copy AND appends the raw cause', () => {
      const out = humanizeError(new Error('execution failed: insufficient balance'));
      expect(out).toContain('Insufficient balance — check your funds and retry.');
      // The raw cause is preserved (appendRaw) so the source isn't hidden.
      expect(out).toContain('execution failed: insufficient balance');
    });

    it('maps a bare insufficient-funds revert (not gas) to the check-your-funds copy + raw', () => {
      const out = humanizeError(new Error('execution failed: insufficient funds'));
      expect(out).toContain('Insufficient balance — check your funds and retry.');
      expect(out).toContain('execution failed: insufficient funds');
    });

    it('PASSES THROUGH a gas-token shortfall verbatim (it names the token/amounts/faucet, not USDC)', () => {
      // The depositIn/returnIn pre-check throws a precise, actionable message — the
      // gas passthrough must preempt the broad balance rule so the POL/ETH detail survives.
      const raw =
        'Insufficient funds for gas: POL on Polygon — fund 0xabc with POL (e.g. https://faucet) and retry (has 1 wei, needs ~2 wei).';
      expect(humanizeError(new Error(raw))).toBe(raw);
    });

    it('maps an ERC20 transfer failure to the check-your-funds copy + raw', () => {
      const out = humanizeError(new Error('ERC20: transfer amount exceeds balance'));
      expect(out).toContain('Insufficient balance — check your funds and retry.');
      expect(out).toContain('transfer amount exceeds balance');
    });

    it('maps a bare REVERTED to a generic on-chain rejection message', () => {
      expect(humanizeError(new Error('submitAndTrack: 0xabc REVERTED'))).toBe(
        'The transaction was rejected on-chain. Check your account state and retry.',
      );
    });

    it('maps a bare REJECTED (finality) to an actionable message, not the raw text (#94)', () => {
      const out = humanizeError(new Error('submitAndTrack: 0xabc REJECTED'));
      expect(out).not.toBe('submitAndTrack: 0xabc REJECTED');
      expect(out).toBe('The transaction was rejected. Check your account state and retry.');
    });
  });

  describe('precedence', () => {
    it('prefers the more specific insufficient-balance mapping over the bare REVERTED mapping', () => {
      // A revert that also names a balance shortfall must surface the actionable
      // balance copy (+ raw cause), not the generic "rejected on-chain" fallback.
      const out = humanizeError(new Error('REVERTED: insufficient balance'));
      expect(out).toContain('Insufficient balance — check your funds and retry.');
      expect(out).not.toContain('rejected on-chain');
    });
  });

  describe('transient AVNU relayer gateway error (#305 Error B — code 156)', () => {
    it('maps the AVNU code-156 "pre-confirmed data unavailable: gateway error" dump to actionable retry copy', () => {
      // The raw shape the deposit surfaced: an AVNU paymaster_executeTransaction code-156
      // TRANSACTION_EXECUTION_ERROR wrapping a JSON-RPC -32603 "Internal error" whose data
      // is "pre-confirmed data unavailable: gateway error". Upstream node/gateway infra, not
      // a real revert — must read as retryable, not a raw dump.
      const raw = new Error(
        'AVNU paymaster paymaster_executeTransaction error (code 156): TRANSACTION_EXECUTION_ERROR: ' +
          '{"code":-32603,"message":"Internal error","data":{"error":"pre-confirmed data unavailable: gateway error"}}',
      );
      const out = humanizeError(raw);
      expect(out).toContain('temporary network/gateway error');
      expect(out).toContain('Your funds are safe');
      // The raw code-156 / TRANSACTION_EXECUTION_ERROR dump must NOT be surfaced verbatim.
      expect(out).not.toContain('TRANSACTION_EXECUTION_ERROR');
      expect(out).not.toContain('code 156');
    });
  });

  describe('full-node-lag block-hash-mismatch (code 156, ValidationFailure)', () => {
    it('maps the code-156 node-lag ValidationFailure to honest copy, not the raw blob', () => {
      // The field shape from the claim submit: an AVNU code-156 TRANSACTION_EXECUTION_ERROR
      // whose ValidationFailure says the base block's stored hash is still 0 (full-node lag).
      const raw = new Error(
        'AVNU paymaster paymaster_executeTransaction error (code 156): An error occurred ' +
          '(TRANSACTION_EXECUTION_ERROR): execution starknet error ValidationFailure: ' +
          '"Invalid proof facts: Block hash mismatch for block 11830268. Proof block hash: ' +
          '2599008338855316138244232038147531977139677293890288556207521894200097029093, ' +
          'stored block hash: 0."',
      );
      const out = humanizeError(raw);
      expect(out).toBe('The Starknet node is briefly behind — your funds are safe.');
      // The raw code-156 / TRANSACTION_EXECUTION_ERROR dump must NOT be surfaced verbatim.
      expect(out).not.toContain('TRANSACTION_EXECUTION_ERROR');
      expect(out).not.toContain('code 156');
    });

    it('does NOT collide with the gateway-error entry (distinct code-156 causes)', () => {
      // A non-zero stored hash is NOT node-lag — it must fall through, not map to the copy.
      const out = humanizeError(
        new Error('Block hash mismatch for block 5. stored block hash: 0x5ab12'),
      );
      expect(out).not.toBe('The Starknet node is briefly behind — your funds are safe.');
    });
  });

  describe('fall-through', () => {
    it('returns the sanitized message unchanged for an unknown error', () => {
      expect(humanizeError(new Error('Some novel failure mode'))).toBe('Some novel failure mode');
    });

    it('handles a non-Error value via String()', () => {
      expect(humanizeError('plain string failure')).toBe('plain string failure');
    });
  });

  describe('sanitize-then-map (no hex leaks)', () => {
    it('strips long hex AND maps a hex-bearing revert to the mapped copy', () => {
      // A revert whose message embeds a long felt/witness-shaped hex blob must:
      //   (1) be mapped to the actionable copy, and
      //   (2) never echo the raw hex (defense-in-depth, tx.ts sanitize first).
      const raw = new Error(
        'submitAndTrack: 0x05a1b2c3d4e5f60718293a4b5c6d7e8f9001122334455667 REVERTED',
      );
      const out = humanizeError(raw);
      expect(out).toBe('The transaction was rejected on-chain. Check your account state and retry.');
    });

    it('falls through to the SANITIZED (hex-stripped) message for an unknown hex-bearing error', () => {
      const longHex = `0x${'ab'.repeat(20)}`; // > 16 hex digits → stripped by sanitize
      const out = humanizeError(new Error(`weird failure at ${longHex} happened`));
      // Mapped copy must NOT appear; the raw long hex must NOT appear verbatim.
      expect(out).not.toContain(longHex);
      expect(out).toContain('weird failure at');
      expect(out).toContain('hex]'); // sanitize's "[N hex]" marker
    });
  });
});

// Lifecycle humanization (Bundle B4c). Raw Starknet tx finality codes leak into
// the progress detail; map them to friendly progress text. Unknown codes pass
// through unchanged so we never hide a status we didn't anticipate.
describe('humanizeFinality', () => {
  it('maps RECEIVED → Submitted', () => {
    expect(humanizeFinality('RECEIVED')).toBe('Submitted');
  });

  it('maps PRE_CONFIRMED → Confirming…', () => {
    expect(humanizeFinality('PRE_CONFIRMED')).toBe('Confirming…');
  });

  it('maps ACCEPTED_ON_L2 → Confirmed on Starknet', () => {
    expect(humanizeFinality('ACCEPTED_ON_L2')).toBe('Confirmed on Starknet');
  });

  it('maps ACCEPTED_ON_L1 → Finalized on Ethereum', () => {
    expect(humanizeFinality('ACCEPTED_ON_L1')).toBe('Finalized on Ethereum');
  });

  it('passes an unknown / undefined code through unchanged', () => {
    expect(humanizeFinality('SOME_NEW_CODE')).toBe('SOME_NEW_CODE');
    expect(humanizeFinality(undefined)).toBe('');
  });
});
