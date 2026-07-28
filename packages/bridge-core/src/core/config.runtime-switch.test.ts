// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Runtime testnet↔mainnet network switch (docs/network-switch-plan.md).
// The config is a pure `configFor(n, env)` factory selected by a runtime holder
// (getActiveConfig / setActiveNetwork); `config` and `EVM_CCTP_SOURCES` are live
// Proxies so existing `config.X` call sites observe a swap with no rename.
//
// Config is INJECTED (Slice X): bridge-core reads no import.meta.env. Each case
// (re)injects via initTestConfig; the stable `config` proxy / accessor exports read
// the active config, so no re-import is needed. Env-swapping cases pass overrides.
//
// Fund-safety invariant under test: evmCctpSources is network-SELECTED, never
// merged — a testnet config must carry ONLY testnet chain ids and vice-versa
// (CCTP burn-and-mint requires source+dest on the SAME network).
import { describe, expect, it } from 'vitest';
import {
  EVM_CCTP_SOURCES,
  config,
  configFor,
  getActiveConfig,
  getEvmCctpSource,
  isNetworkSwitchEnabled,
  network,
  setActiveNetwork,
} from './config';
import { initTestConfig } from '../../vitest.setup';

describe('configFor(network) — pure per-network factory', () => {
  it('testnet and mainnet differ on the network-scoped fields', () => {
    // The test fixtures pin PRIVACY_POOL_ADDRESS / DEPOSIT_TOKEN_ADDRESS /
    // POLYGON_CHAIN_ID as explicit overrides (an explicit env deliberately wins over
    // the network default), so those can't be exercised as network-varying here.
    // Assert on the fields whose network default is NOT pinned by the fixtures:
    // the SN CCTP endpoints, irisUrl, the default source chain, and the EVM source
    // registry keys.
    const t = configFor('testnet');
    const m = configFor('mainnet');

    expect(t.network).toBe('testnet');
    expect(m.network).toBe('mainnet');
    expect(t.cctp.snTokenMessengerMinter).not.toBe(m.cctp.snTokenMessengerMinter);
    expect(t.cctp.snMessageTransmitter).not.toBe(m.cctp.snMessageTransmitter);
    expect(t.cctp.irisUrl).not.toBe(m.cctp.irisUrl);
    expect(t.cctp.defaultEvmSourceChainId).not.toBe(m.cctp.defaultEvmSourceChainId);
    // evmCctpSources keyed by disjoint chain-id sets.
    expect(Object.keys(t.evmCctpSources).sort()).not.toEqual(
      Object.keys(m.evmCctpSources).sort(),
    );
  });

  it('CCTP select-not-merge: testnet sources have NO mainnet chain ids (137/1/8453/…)', () => {
    const testnetKeys = Object.keys(configFor('testnet').evmCctpSources);
    for (const mainnetId of ['137', '1', '8453', '42161', '10']) {
      expect(testnetKeys).not.toContain(mainnetId);
    }
    expect(testnetKeys.sort()).toEqual([
      '11155111',
      '11155420',
      '421614',
      '80002',
      '84532',
    ]);

    const mainnetKeys = Object.keys(configFor('mainnet').evmCctpSources);
    for (const testnetId of ['80002', '11155111']) {
      expect(mainnetKeys).not.toContain(testnetId);
    }
  });

  it('secrets stay network-scoped: neither config surfaces the other network`s admin', () => {
    // Both use the SAME dev admin fixture (env-level, not network-level) but the
    // point is configFor never leaks a DIFFERENT network`s admin — resolveAdmin
    // is scoped inside configFor, so each build resolves its own creds only.
    expect(configFor('testnet').admin).toEqual(configFor('mainnet').admin);
    // …and the value comes from the env fixture, not a cross-network default.
    expect(configFor('testnet').admin?.address).toBe('0x4');
  });
});

describe('live-config Proxy + runtime holder', () => {
  it('config Proxy and getActiveConfig start on the build-time default (testnet)', () => {
    expect(network).toBe('testnet');
    expect(getActiveConfig().network).toBe('testnet');
    expect(config.network).toBe('testnet');
    expect(config.poolAddress).toBe(getActiveConfig().poolAddress);
  });

  it('setActiveNetwork(mainnet) → config Proxy returns mainnet values live', () => {
    // Use a field whose network default is NOT pinned by the fixtures
    // (CCTP_TOKEN_MESSENGER is blank → resolves to the network default).
    const before = config.cctp.snTokenMessengerMinter;
    setActiveNetwork('mainnet');
    expect(config.network).toBe('mainnet');
    expect(config.cctp.snTokenMessengerMinter).toBe(
      configFor('mainnet').cctp.snTokenMessengerMinter,
    );
    expect(config.cctp.snTokenMessengerMinter).not.toBe(before);
    // A field a core fn would read (rpcUrl) picks up the swap too.
    expect(config.rpcUrl).toBe('/rpc/mainnet');
    setActiveNetwork('testnet'); // restore
  });

  it('EVM_CCTP_SOURCES + getEvmCctpSource follow the active network', () => {
    // testnet default
    expect(getEvmCctpSource(137)).toBeUndefined();
    expect(getEvmCctpSource(80002)).toBeDefined();
    expect(Object.keys(EVM_CCTP_SOURCES).sort()).toEqual([
      '11155111',
      '11155420',
      '421614',
      '80002',
      '84532',
    ]);

    setActiveNetwork('mainnet');
    expect(getEvmCctpSource(80002)).toBeUndefined();
    expect(getEvmCctpSource(137)).toBeDefined();
    expect(Object.keys(EVM_CCTP_SOURCES).sort()).toEqual(['1', '10', '137', '42161', '8453']);
    setActiveNetwork('testnet'); // restore
  });

  it('rpcUrl is per-network in dev so both upstreams are reachable from one origin', () => {
    // The test fixtures inject dev=true.
    expect(config.rpcUrl).toBe('/rpc/testnet');
    expect(config.proverUrl).toBe('/prover/testnet');
    expect(config.indexerUrl).toBe('/indexer/testnet');
    setActiveNetwork('mainnet');
    expect(config.rpcUrl).toBe('/rpc/mainnet');
    expect(config.proverUrl).toBe('/prover/mainnet');
    expect(config.indexerUrl).toBe('/indexer/mainnet');
    setActiveNetwork('testnet'); // restore
  });
});

// PROD FENCE (Bugbot MEDIUM — "Production RPC paths ignore network"):
// rpcUrl/proverUrl/indexerUrl only get the per-network suffix in a DEV build. In a
// PROD build both networks resolve to the SAME bare `/rpc`·`/prover`·`/indexer`,
// so a runtime switch would silently point both networks at one Starknet upstream.
// Until per-network prod OHTTP infra exists, the switch is DEV-only: setActiveNetwork
// REFUSES any non-default network in prod, and isNetworkSwitchEnabled() gates the UI.
describe('prod network-switch fence', () => {
  // Inject a simulated PROD build. resolveAdmin throws in prod if an admin key is
  // set, so blank it for these cases.
  function loadProdConfig() {
    initTestConfig({ ADMIN_PRIVATE_KEY: '' }, { dev: false, prod: true });
  }

  it('DEV build: switch is ENABLED (control — fixtures inject dev=true)', () => {
    initTestConfig();
    expect(isNetworkSwitchEnabled()).toBe(true);
  });

  it('PROD build: isNetworkSwitchEnabled() is false (UI hides the toggle)', () => {
    loadProdConfig();
    expect(isNetworkSwitchEnabled()).toBe(false);
  });

  it('PROD build: both networks resolve to the SAME (bare, no-suffix) endpoints', () => {
    // This is the silent-wrong behaviour the fence exists to prevent: without a
    // per-network suffix, testnet and mainnet configs share one upstream.
    loadProdConfig();
    expect(configFor('testnet').rpcUrl).toBe('/rpc');
    expect(configFor('mainnet').rpcUrl).toBe('/rpc');
    expect(configFor('testnet').proverUrl).toBe(configFor('mainnet').proverUrl);
    expect(configFor('testnet').indexerUrl).toBe(configFor('mainnet').indexerUrl);
  });

  it('PROD build: setActiveNetwork REFUSES to switch away from the build-time default', () => {
    // Build-time default is testnet (NETWORK fixture) → switching to mainnet in prod
    // would misroute Starknet RPC/prover/indexer, so it throws.
    loadProdConfig();
    expect(() => setActiveNetwork('mainnet')).toThrow(/DEV-only/i);
  });

  it('PROD build: setActiveNetwork to the SAME default network is a no-op (mount alignment)', () => {
    loadProdConfig();
    // Idempotent re-align to the default network must NOT throw.
    expect(() => setActiveNetwork('testnet')).not.toThrow();
    expect(config.network).toBe('testnet');
  });
});

describe('requireEnv fail-fast preserved', () => {
  it('initBridgeConfig throws (naming the var) when a required var is unset for the default network', () => {
    // configFor(defaultNetwork) runs inside initBridgeConfig, so a missing required
    // var fails fast at INIT time (not deferred to first use) — the whole point of
    // requirePerNetworkEnv. Blank the shared slot; the per-network slots are unset.
    expect(() => initTestConfig({ OZ_ACCOUNT_CLASS_HASH: '' })).toThrow(
      /OZ_ACCOUNT_CLASS_HASH/,
    );
  });

  it('configFor(mainnet) itself throws (naming the var) when a required var is unset', () => {
    // Prove the throw originates in configFor: default-build testnet succeeds, but a
    // mainnet build with the OZ class hash unset throws NAMING the mainnet var.
    expect(() => initTestConfig({ NETWORK: 'mainnet', OZ_ACCOUNT_CLASS_HASH: '' })).toThrow(
      /OZ_ACCOUNT_CLASS_HASH/,
    );
  });
});
