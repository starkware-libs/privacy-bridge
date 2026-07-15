// Bug-hunt B2: `env.vars.NETWORK === 'mainnet'` at config.ts:117 and :768 is a
// case-sensitive strict-equal. Any user setting `NETWORK=Mainnet`,
// `NETWORK=MAINNET`, `NETWORK=' mainnet'`, or a typo `NETWORK=main` silently
// resolves to `network = 'testnet'`, so a mainnet cutover that fat-fingers
// the case boots the WHOLE app on testnet defaults (pool address, anonymizer,
// CCTP source registry, Iris). No documented contract in docs/ says NETWORK
// must be lowercase — the mainnet-cutover-plan.md documents `NETWORK=mainnet`
// as the master switch but never says other casings are rejected.
//
// This test asserts a safer contract: `NETWORK=Mainnet` should either
//   (a) normalize to mainnet, OR
//   (b) fail loud (throw), so an operator immediately sees the typo.
// A silent fall-through to testnet is the footgun. Current main takes the
// silent-testnet path → RED.

import { describe, expect, it } from 'vitest';
import { network as networkExport, getActiveConfig } from './config';
import { initTestConfig } from '../../vitest.setup';

describe('NETWORK env var is not case-sensitive silent-fallback (bug-hunt B2)', () => {
  it('NETWORK=Mainnet does NOT silently become testnet', () => {
    // Either resolves to mainnet, or throws — never the silent testnet fallback
    // that leaks mainnet cutover typos into a testnet-defaulted config.
    let threw = false;
    try {
      initTestConfig({ NETWORK: 'Mainnet' });
    } catch {
      threw = true;
    }
    if (threw) return; // acceptable contract (b).

    // Test the module-level `network` export AND the active config so a fix
    // that patches one but not the other still fails one assertion.
    expect(networkExport).toBe('mainnet');
    expect(getActiveConfig().network).toBe('mainnet');
  });

  it('NETWORK=MAINNET does NOT silently become testnet', () => {
    let threw = false;
    try {
      initTestConfig({ NETWORK: 'MAINNET' });
    } catch {
      threw = true;
    }
    if (threw) return;
    expect(getActiveConfig().network).toBe('mainnet');
  });
});
