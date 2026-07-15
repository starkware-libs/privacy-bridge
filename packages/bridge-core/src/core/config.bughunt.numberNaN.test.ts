// Bug-hunt B3: config.ts does `Number(e.vars.SOMETHING || default)` for
// several numeric env vars (proofValidityBlocks, cctp.starknetDomain,
// cctp.defaultEvmSourceChainId, cctp.defaultDestChainId, polygon.chainId,
// polygon.domain). The `||` fallback only fires for FALSY strings ('' /
// undefined) — a TRUTHY non-numeric string like "foo" passes through, and
// `Number("foo") === NaN` silently propagates into the config.
//
// Downstream call sites BigInt() / compare / calldata-encode these fields
// (e.g. polygon.chainId feeds an EVM burn's chain-switch and RPC selection;
// cctp.starknetDomain gets encoded into CCTP calldata). NaN there yields
// cryptic failures far from the source. A robust contract:
//   (a) treat a non-numeric NETWORK as a config error (throw at init), OR
//   (b) fall back to the built-in default rather than emit NaN.
//
// Highest-impact field asserted here: `polygon.chainId` (routes MetaMask's
// chain switch, RPC reads, and the whole default bridge-OUT destination
// projection). Also asserts `cctp.starknetDomain` (goes into CCTP calldata)
// as an extra data point.
//
// Current main: neither guard exists — `Number("foo") = NaN` lands in
// config verbatim. RED.

import { describe, expect, it } from 'vitest';
import { getActiveConfig } from './config';
import { initTestConfig } from '../../vitest.setup';

function safeInit(vars: Record<string, string>): { threw: boolean } {
  try {
    initTestConfig(vars);
    return { threw: false };
  } catch {
    return { threw: true };
  }
}

describe('config numeric-env NaN propagation (bug-hunt B3)', () => {
  it('POLYGON_CHAIN_ID="not-a-number" does NOT silently produce NaN', () => {
    const { threw } = safeInit({ POLYGON_CHAIN_ID: 'not-a-number' });
    if (threw) return; // acceptable: hard-fail at init.

    const c = getActiveConfig();
    expect(Number.isNaN(c.polygon.chainId)).toBe(false);
    // A NaN value is neither a number in the registry nor === any real chain id;
    // the field is used to look up dest rows and to switch MetaMask, so the
    // strictest assertion (not NaN + is a real number) captures the harm.
    expect(Number.isFinite(c.polygon.chainId)).toBe(true);
  });

  it('CCTP_STARKNET_DOMAIN="oops" does NOT silently produce NaN', () => {
    const { threw } = safeInit({ CCTP_STARKNET_DOMAIN: 'oops' });
    if (threw) return;

    const c = getActiveConfig();
    expect(Number.isNaN(c.cctp.starknetDomain)).toBe(false);
    expect(Number.isFinite(c.cctp.starknetDomain)).toBe(true);
  });
});
