// Pins the NETWORK master switch (docs/mainnet-cutover-plan.md §1-§2): the default
// keeps every testnet default; 'mainnet' flips the network-scoped defaults (EVM
// source registry, Starknet CCTP destination, deposit token, Polygon block, default
// source chain) without touching testnet behaviour.
//
// Config is INJECTED (Slice X): bridge-core reads no import.meta.env. Each case
// (re)injects via initTestConfig; the stable `config` proxy / accessor exports read
// the active config, so no re-import is needed. Env-swapping cases pass overrides
// (keys are the app env vars with the VITE_ prefix stripped — the SDK's contract).
import { describe, expect, it } from 'vitest';
import {
  EVM_CCTP_SOURCES,
  config,
  configFor,
  evmExplorerTxUrl,
  getEvmCctpSource,
  isAnonymizerConfigured,
  network,
  strkFeeToUsdc,
} from './config';
import { initTestConfig } from '../../vitest.setup';
import { deriveStarknetAccount, deriveStarknetPrivateKey } from '../derivation/index';

// (Re)inject the baseline testnet config, optionally flipping the network. Returns
// the stable config exports (the proxy/accessors read the now-active config).
function loadConfig(net?: string) {
  initTestConfig(net ? { NETWORK: net } : {});
  return {
    config,
    configFor,
    getEvmCctpSource,
    isAnonymizerConfigured,
    EVM_CCTP_SOURCES,
    strkFeeToUsdc,
    network,
  };
}

describe('NETWORK source registry', () => {
  it('defaults to testnet rows (Amoy, Sepolia, Base/Arb/OP Sepolia), no mainnet chains', () => {
    const { network, EVM_CCTP_SOURCES, getEvmCctpSource } = loadConfig();
    expect(network).toBe('testnet');
    expect(Object.keys(EVM_CCTP_SOURCES).sort()).toEqual([
      '11155111',
      '11155420',
      '421614',
      '80002',
      '84532',
    ]);
    expect(getEvmCctpSource(137)).toBeUndefined();
    // Testnet L2 domains mirror their mainnet counterparts (Circle CCTP domains).
    expect(getEvmCctpSource(84532)?.domain).toBe(6); // Base Sepolia
    expect(getEvmCctpSource(421614)?.domain).toBe(3); // Arbitrum Sepolia
    expect(getEvmCctpSource(11155420)?.domain).toBe(2); // OP Sepolia
    // All testnet rows share the testnet shared TokenMessengerV2.
    for (const id of [80002, 11155111, 84532, 421614, 11155420]) {
      expect(getEvmCctpSource(id)?.tokenMessenger).toBe(
        '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      );
    }
  });

  it('mainnet selects Polygon/Ethereum/Base/Arbitrum/Optimism with the mainnet shared messenger', () => {
    const { network, EVM_CCTP_SOURCES, getEvmCctpSource } = loadConfig('mainnet');
    expect(network).toBe('mainnet');
    expect(Object.keys(EVM_CCTP_SOURCES).sort()).toEqual(['1', '10', '137', '42161', '8453']);
    expect(getEvmCctpSource(80002)).toBeUndefined();
    expect(getEvmCctpSource(137)?.domain).toBe(7);
    expect(getEvmCctpSource(1)?.domain).toBe(0);
    expect(getEvmCctpSource(8453)?.domain).toBe(6);
    // Arbitrum One (domain 3) + OP Mainnet (domain 2) — Circle CCTP EVM contracts.
    expect(getEvmCctpSource(42161)?.domain).toBe(3);
    expect(getEvmCctpSource(42161)?.chainId).toBe(42161);
    expect(getEvmCctpSource(10)?.domain).toBe(2);
    expect(getEvmCctpSource(10)?.chainId).toBe(10);
    for (const id of [137, 1, 8453, 42161, 10]) {
      // mainnet shared TokenMessengerV2, and no testnet faucet link on mainnet.
      expect(getEvmCctpSource(id)?.tokenMessenger).toBe(
        '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
      );
      expect(getEvmCctpSource(id)?.faucetUrl).toBeUndefined();
    }
  });
});

// Only the NETWORK-DRIVEN defaults are asserted here. The fixtures pin
// DEPOSIT_TOKEN_ADDRESS / POLYGON_CHAIN_ID / POLYGON_USDC_ADDRESS as fixtures, and
// an explicit env var deliberately OVERRIDES the network default — so those fields
// can't be exercised via NETWORK here.
describe('NETWORK destination defaults (non-pinned fields)', () => {
  it('testnet defaults are the SN Sepolia / sandbox values', () => {
    const { config } = loadConfig();
    expect(config.cctp.irisUrl).toBe('https://iris-api-sandbox.circle.com');
    expect(config.cctp.starknetDomain).toBe(25);
    expect(config.cctp.defaultEvmSourceChainId).toBe(80002);
    expect(config.cctp.snTokenMessengerMinter).toBe(
      '0x04bDdE1E09a4B09a2F95d893D94a967b7717eB85A3f6dEcA8c080Ee01fBc3370',
    );
  });

  it('mainnet flips Iris, the SN messenger/transmitter, and the default source chain', () => {
    const { config } = loadConfig('mainnet');
    expect(config.cctp.irisUrl).toBe('https://iris-api.circle.com');
    expect(config.cctp.starknetDomain).toBe(25); // unchanged across networks
    expect(config.cctp.defaultEvmSourceChainId).toBe(137);
    expect(config.cctp.snTokenMessengerMinter).toBe(
      '0x07d421B9cA8aA32DF259965cDA8ACb93F7599F69209A41872AE84638B2A20F2a',
    );
    expect(config.cctp.snMessageTransmitter).toBe(
      '0x02EBB5777B6dD8B26ea11D68Fdf1D2c85cD2099335328Be845a28c77A8AEf183',
    );
  });

  it('an explicit env var overrides the network default', () => {
    initTestConfig({ NETWORK: 'mainnet', CCTP_ATTESTATION_API: 'https://iris.example.test' });
    expect(config.cctp.irisUrl).toBe('https://iris.example.test');
  });
});

// Empty-string footgun on the mainnet EVM CCTP source overrides. A blank env line
// materializes as the empty STRING (not undefined), which `??` does NOT fall back
// on. The mainnet block must use `||` like the rest of the file so a blank env line
// falls through to the literal default rather than burning CCTP calldata against ''.
describe('EVM_CCTP_SOURCES_MAINNET — blank env vars fall back to literal defaults', () => {
  it('blank POLYGON_USDC_ADDRESS falls back to the mainnet USDC default', () => {
    initTestConfig({ NETWORK: 'mainnet', POLYGON_USDC_ADDRESS: '' });
    expect(getEvmCctpSource(137)?.usdc).toBe('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359');
  });

  it('blank POLYGON_RPC_URL falls back to the publicnode Polygon default', () => {
    initTestConfig({ NETWORK: 'mainnet', POLYGON_RPC_URL: '' });
    expect(getEvmCctpSource(137)?.rpcUrl).toBe('https://polygon-bor-rpc.publicnode.com');
  });

  it('blank ETHEREUM_USDC_ADDRESS / ETHEREUM_RPC_URL fall back to the Ethereum defaults', () => {
    initTestConfig({ NETWORK: 'mainnet', ETHEREUM_USDC_ADDRESS: '', ETHEREUM_RPC_URL: '' });
    expect(getEvmCctpSource(1)?.usdc).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    expect(getEvmCctpSource(1)?.rpcUrl).toBe('https://ethereum-rpc.publicnode.com');
  });

  it('blank BASE_USDC_ADDRESS / BASE_RPC_URL fall back to the Base defaults', () => {
    initTestConfig({ NETWORK: 'mainnet', BASE_USDC_ADDRESS: '', BASE_RPC_URL: '' });
    expect(getEvmCctpSource(8453)?.usdc).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(getEvmCctpSource(8453)?.rpcUrl).toBe('https://mainnet.base.org');
  });

  it('blank ARBITRUM_USDC_ADDRESS / ARBITRUM_RPC_URL fall back to the Arbitrum defaults', () => {
    initTestConfig({ NETWORK: 'mainnet', ARBITRUM_USDC_ADDRESS: '', ARBITRUM_RPC_URL: '' });
    expect(getEvmCctpSource(42161)?.usdc).toBe('0xaf88d065e77c8cC2239327C5EDb3A432268e5831');
    expect(getEvmCctpSource(42161)?.rpcUrl).toBe('https://arb1.arbitrum.io/rpc');
  });

  it('blank OPTIMISM_USDC_ADDRESS / OPTIMISM_RPC_URL fall back to the Optimism defaults', () => {
    initTestConfig({ NETWORK: 'mainnet', OPTIMISM_USDC_ADDRESS: '', OPTIMISM_RPC_URL: '' });
    expect(getEvmCctpSource(10)?.usdc).toBe('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85');
    expect(getEvmCctpSource(10)?.rpcUrl).toBe('https://mainnet.optimism.io');
  });
});

// AVNU paymaster config (docs/architecture.md Key decisions; open-questions #13).
// resolvePaymaster() returns undefined until AVNU_PAYMASTER_API_KEY is set, so
// manager-pays stays the default; when set, endpoint/feeMode/poolFeeToken default to
// the AVNU mainnet sponsored_private wiring and stay individually overridable.
describe('config.paymaster (AVNU)', () => {
  it('is undefined with no API key (manager-pays stays default)', () => {
    const { config } = loadConfig();
    expect(config.paymaster).toBeUndefined();
  });

  it('turns on when AVNU_PAYMASTER_API_KEY is set, with mainnet sponsored_private defaults', () => {
    initTestConfig({ AVNU_PAYMASTER_API_KEY: 'avnu_test_key' });
    expect(config.paymaster?.apiKey).toBe('avnu_test_key');
    expect(config.paymaster?.endpoint).toBe('https://starknet.paymaster.avnu.fi');
    expect(config.paymaster?.feeMode).toBe('sponsored_private');
  });

  it('honors AVNU_PAYMASTER_URL and AVNU_FEE_MODE overrides', () => {
    initTestConfig({
      AVNU_PAYMASTER_API_KEY: 'avnu_test_key',
      AVNU_PAYMASTER_URL: 'https://sepolia.paymaster.avnu.fi',
      AVNU_FEE_MODE: 'sponsored',
    });
    expect(config.paymaster?.endpoint).toBe('https://sepolia.paymaster.avnu.fi');
    expect(config.paymaster?.feeMode).toBe('sponsored');
  });
});

// Deploy-fee mode. Defaults to 'sponsored' (AVNU pays; a pure deploymentData deploy —
// the mandatory deploy path per open-questions.md #13). 'default' (user pays in USDC
// via AVNU pay-in-token) is NOT usable: the fee is charged via a SNIP-9 execute_from_
// outside transfer from the account, which is not yet deployed at deploy time → AVNU
// rejects "SNIP-9 not implemented for the account". The USDC estimate must be a valid
// decimal string (the breakdown's bigint math parses it).
describe('config.deployFeeMode (account-deploy fee toggle)', () => {
  it('defaults to "sponsored" (SNIP-9-safe deploy) when DEPLOY_FEE_MODE is unset', () => {
    const { config } = loadConfig();
    expect(config.deployFeeMode).toBe('sponsored');
  });

  it('honors DEPLOY_FEE_MODE=sponsored', () => {
    initTestConfig({ DEPLOY_FEE_MODE: 'sponsored' });
    expect(config.deployFeeMode).toBe('sponsored');
  });

  it('exposes deployFeeEstimate as a valid (≤6dp) decimal string', () => {
    const { config } = loadConfig();
    expect(typeof config.deployFeeEstimate).toBe('string');
    expect(config.deployFeeEstimate).toMatch(/^\d+(\.\d{1,6})?$/);
  });

  it('honors DEPLOY_FEE_MODE=default', () => {
    initTestConfig({ DEPLOY_FEE_MODE: 'default' });
    expect(config.deployFeeMode).toBe('default');
  });
});

// A missing REQUIRED env var (no safe cross-network default) must fail LOUD with an
// actionable message NAMING the exact var, at config-init time — instead of becoming
// `undefined` that surfaces far away as a cryptic library error. The real regression:
// an unset OZ_ACCOUNT_CLASS_HASH made config.ozClassHash undefined, and
// deriveStarknetAccount fed it into hash.calculateContractAddressFromHash, which
// threw "Cannot convert undefined to a BigInt" with no hint about which var was unset.
// Only the OZ class hash (must be DECLARED per network) has NO safe cross-network
// default and remains required.
describe('required env vars fail loud (clear error, not cryptic BigInt)', () => {
  // The per-network required var (MEDIUM-2): with NEITHER the per-network slot NOR
  // the shared slot set for the default (testnet) network, configFor must fail loud
  // NAMING the per-network var (and the shared fallback) — never silently become
  // undefined that surfaces far away as a cryptic library error.
  it('initializing with OZ_ACCOUNT_CLASS_HASH (+ its per-network slot) unset throws a clear "is not set" error', () => {
    // Clear the shared slot; the per-network slots are unset in the fixture.
    expect(() => initTestConfig({ OZ_ACCOUNT_CLASS_HASH: '' })).toThrow(
      "Config error: OZ_ACCOUNT_CLASS_HASH_TESTNET (or the shared OZ_ACCOUNT_CLASS_HASH) is not set for network 'testnet'",
    );
  });

  // BEHAVIOR proof: the derive path that triggered the original cryptic crash. With
  // the class hash unset, init must surface the clear "is not set" error (config
  // throws first), NOT "Cannot convert undefined to a BigInt".
  it('initializing with OZ_ACCOUNT_CLASS_HASH unset names the var, not "BigInt"', () => {
    expect(() => initTestConfig({ OZ_ACCOUNT_CLASS_HASH: '' })).toThrow(
      /Config error: OZ_ACCOUNT_CLASS_HASH_TESTNET .* is not set/,
    );
    expect(() => initTestConfig({ OZ_ACCOUNT_CLASS_HASH: '' })).not.toThrow(
      /Cannot convert undefined to a BigInt/,
    );

    // Guard the regression at the source: passing an undefined class hash straight
    // into deriveStarknetAccount is exactly what produced the cryptic library error.
    const priv = deriveStarknetPrivateKey('0xsig');
    expect(() => deriveStarknetAccount(priv, undefined as unknown as string)).toThrow(
      /Cannot convert undefined to a BigInt/,
    );
  });

  it('with all required vars set (fixtures), config loads and ozClassHash is defined', () => {
    const { config } = loadConfig(); // uses the pinned fixtures
    expect(config.ozClassHash).toBeTruthy();
    expect(config.strkToken).toBeTruthy();
  });
});

// Public network values (chain ids, the SN pool/anonymizer + STRK token, proof
// validity) are baked as per-network defaults in config.ts so a fresh env needs
// none of them. Each case blanks the var (a blank env line → '', the footgun case)
// so it falls through to the baked default; an explicit value still overrides.
describe('public network defaults (baked in config.ts)', () => {
  it('chainId defaults to the SN_SEPOLIA / SN_MAIN chain-id FELT (not the human name)', () => {
    initTestConfig({ CHAIN_ID: '' });
    expect(config.chainId).toBe('0x534e5f5345504f4c4941'); // SN_SEPOLIA

    initTestConfig({ NETWORK: 'mainnet', CHAIN_ID: '' });
    expect(config.chainId).toBe('0x534e5f4d41494e'); // SN_MAIN
  });

  it('strkToken is the canonical baked STRK address (network-constant), env IGNORED', () => {
    // BAKED-ONLY: the SDK owns this protocol token; STRK_TOKEN_ADDRESS is not read.
    initTestConfig({ STRK_TOKEN_ADDRESS: '0xdeadbeef' });
    expect(config.strkToken).toBe(
      '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
    );
  });

  it('proofValidityBlocks blank falls back to 20 (not NaN)', () => {
    initTestConfig({ PROOF_VALIDITY_BLOCKS: '' });
    expect(config.proofValidityBlocks).toBe(20);
  });

  it('poolAddress: SN mainnet + SN Sepolia are baked, env override IGNORED', () => {
    initTestConfig({ NETWORK: 'mainnet', PRIVACY_POOL_ADDRESS: '0xbogus' });
    expect(config.poolAddress).toBe(
      '0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a',
    );

    initTestConfig({ NETWORK: 'testnet', PRIVACY_POOL_ADDRESS: '0xbogus' });
    expect(config.poolAddress).toBe(
      '0x254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91',
    );
  });

  it('anonymizerAddress: SN mainnet + SN Sepolia are baked, env override IGNORED', () => {
    // FUNDS-SAFETY: a stale ANONYMIZER_ADDRESS override (the retired 9-felt contract)
    // must NOT retarget the withdraw/burn — the baked value always wins.
    initTestConfig({
      NETWORK: 'mainnet',
      ANONYMIZER_ADDRESS: '0x01c2f25586d1a45e489ebbf4f3d8b67d220c9a555d5e5cefa9fb27b3bc6681a6',
    });
    expect(config.anonymizerAddress).toBe(
      '0x009067f35d2cab3cb933f3d78793660402026f8fa31e041ca2cab4a8e9a49092',
    );

    initTestConfig({ NETWORK: 'testnet', ANONYMIZER_ADDRESS: '0xbogus' });
    expect(config.anonymizerAddress).toBe(
      '0x05b85f2ae4d47c1e661533d5832fe3e4afd4c6a9b52e54b7f873a00c9b285f4e',
    );
  });

  it('isAnonymizerConfigured: true under the baked default, false when the address is unset', () => {
    const mod = loadConfig();
    expect(mod.isAnonymizerConfigured()).toBe(true);

    // config is a live write-through Proxy (see core/config.ts) — reassigning a
    // field simulates an unconfigured network. isAnonymizerConfigured reads the
    // SAME active config, so it must observe the override.
    mod.config.anonymizerAddress = '';
    expect(mod.isAnonymizerConfigured()).toBe(false);
  });
});

// FUNDS-SAFETY: the fixed protocol CONTRACT/TOKEN addresses are BAKED-ONLY — the SDK
// is their single source of truth and no app env can shadow them. A stale override
// (like the retired anonymizer that broke cash-out) must be inert. These pin that each
// such field ignores its (now-legacy) env var and returns the baked mainnet value.
describe('protocol addresses are baked-only (env override IGNORED)', () => {
  const MAINNET = { NETWORK: 'mainnet' } as const;

  it('inboundAnonymizerAddress ignores INBOUND_ANONYMIZER_ADDRESS', () => {
    initTestConfig({ ...MAINNET, INBOUND_ANONYMIZER_ADDRESS: '0xbogus' });
    expect(config.inboundAnonymizerAddress).toBe(
      '0x03a7e7f34e530f8ec00b1ff7eaca90a136311d9da7cb17a73203f813b56c86cb',
    );
  });

  it('cctp.snTokenMessengerMinter ignores CCTP_TOKEN_MESSENGER', () => {
    initTestConfig({ ...MAINNET, CCTP_TOKEN_MESSENGER: '0xbogus' });
    expect(config.cctp.snTokenMessengerMinter).toBe(
      '0x07d421B9cA8aA32DF259965cDA8ACb93F7599F69209A41872AE84638B2A20F2a',
    );
  });

  it('cctp.snMessageTransmitter ignores CCTP_MESSAGE_TRANSMITTER', () => {
    initTestConfig({ ...MAINNET, CCTP_MESSAGE_TRANSMITTER: '0xbogus' });
    expect(config.cctp.snMessageTransmitter).toBe(
      '0x02EBB5777B6dD8B26ea11D68Fdf1D2c85cD2099335328Be845a28c77A8AEf183',
    );
  });

  it('depositToken.address ignores DEPOSIT_TOKEN_ADDRESS', () => {
    initTestConfig({ ...MAINNET, DEPOSIT_TOKEN_ADDRESS: '0xbogus' });
    expect(config.depositToken.address).toBe(
      '0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb',
    );
  });

  it('the shared EVM CCTP TokenMessenger ignores CCTP_EVM_TOKEN_MESSENGER', () => {
    initTestConfig({ ...MAINNET, CCTP_EVM_TOKEN_MESSENGER: '0xbogus' });
    expect(getEvmCctpSource(137)?.tokenMessenger).toBe(
      '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
    );
  });
});

// #161: strkFeeToUsdc must fall back to the safe default '0.5' whenever either input
// can't produce a meaningful USDC estimate — including priceUsd === 0 (a live-price
// feed reporting exactly zero is bad data, not "the fee is free"). The old `< 0`
// guard let priceUsd === 0 through, returning '0' instead of the safe default.
describe('strkFeeToUsdc', () => {
  it('computes the USDC-equivalent fee for positive strk + priceUsd', () => {
    expect(strkFeeToUsdc('0.5', 2)).toBe('1');
  });

  it('#161: falls back to 0.5 when priceUsd is exactly 0 (not "0")', () => {
    expect(strkFeeToUsdc('0.5', 0)).toBe('0.5');
  });

  it('#161: falls back to 0.5 when strk is exactly 0', () => {
    expect(strkFeeToUsdc('0', 2)).toBe('0.5');
  });

  it('falls back to 0.5 for negative or non-numeric inputs', () => {
    expect(strkFeeToUsdc('-1', 2)).toBe('0.5');
    expect(strkFeeToUsdc('0.5', -2)).toBe('0.5');
    expect(strkFeeToUsdc('nope', 2)).toBe('0.5');
  });
});

describe('evmExplorerTxUrl (shared source/dest explorer link builder)', () => {
  it('builds <base>/tx/<hash> from the first explorer base', () => {
    expect(evmExplorerTxUrl({ blockExplorerUrls: ['https://amoy.polygonscan.com'] }, '0xabc')).toBe(
      'https://amoy.polygonscan.com/tx/0xabc',
    );
  });

  it('trims a trailing slash on the base so the /tx/ join never doubles up', () => {
    expect(evmExplorerTxUrl({ blockExplorerUrls: ['https://etherscan.io/'] }, '0xdef')).toBe(
      'https://etherscan.io/tx/0xdef',
    );
  });

  it('returns undefined when the config has no explorer base (link stays informational-only)', () => {
    expect(evmExplorerTxUrl({ blockExplorerUrls: [] }, '0xabc')).toBeUndefined();
    expect(evmExplorerTxUrl({}, '0xabc')).toBeUndefined();
    expect(evmExplorerTxUrl(undefined, '0xabc')).toBeUndefined();
  });
});

// MEDIUM-2 (latent correctness trap): ozClassHash is PER-NETWORK (the testnet and
// mainnet pools have different declared class hashes). A SINGLE shared env slot
// silently hands the SAME value to both networks, so after a runtime switch the app
// would use the WRONG class hash (silent-wrong). configFor(n) must resolve the
// per-network slot FIRST, fall back to the legacy shared slot for back-compat, and
// FAIL LOUD (never silently borrow the other network's value) when neither is set
// for the target network.
describe('MEDIUM-2: ozClassHash is per-network', () => {
  it('per-network slots make testnet !== mainnet (no silent sharing)', () => {
    // Clear the shared slot (fixtures pin it) so ONLY the per-network slots resolve.
    initTestConfig({
      OZ_ACCOUNT_CLASS_HASH: '',
      OZ_ACCOUNT_CLASS_HASH_TESTNET: '0xoz_testnet',
      OZ_ACCOUNT_CLASS_HASH_MAINNET: '0xoz_mainnet',
    });

    const testnet = configFor('testnet');
    const mainnet = configFor('mainnet');

    expect(testnet.ozClassHash).toBe('0xoz_testnet');
    expect(mainnet.ozClassHash).toBe('0xoz_mainnet');
    expect(testnet.ozClassHash).not.toBe(mainnet.ozClassHash);
  });

  it('falls back to the shared slot for back-compat when the per-network slot is unset', () => {
    initTestConfig({
      OZ_ACCOUNT_CLASS_HASH: '0xshared_oz',
      // No per-network slots → both networks fall back to the shared value.
      OZ_ACCOUNT_CLASS_HASH_TESTNET: '',
      OZ_ACCOUNT_CLASS_HASH_MAINNET: '',
    });

    expect(configFor('testnet').ozClassHash).toBe('0xshared_oz');
    expect(configFor('mainnet').ozClassHash).toBe('0xshared_oz');
  });

  it('the per-network slot OVERRIDES the shared slot for that network only', () => {
    initTestConfig({
      OZ_ACCOUNT_CLASS_HASH: '0xshared_oz',
      // Only mainnet has a per-network slot; testnet falls back to the shared value.
      OZ_ACCOUNT_CLASS_HASH_MAINNET: '0xoz_mainnet',
    });

    expect(configFor('testnet').ozClassHash).toBe('0xshared_oz');
    expect(configFor('mainnet').ozClassHash).toBe('0xoz_mainnet');
  });

  it('FAILS LOUD (does NOT silently share) when no value resolves for the target network', () => {
    // Neither the shared nor the mainnet per-network class hash is set; only testnet
    // has a value — it must NOT leak to mainnet. The default (testnet) build stays
    // valid so init itself succeeds.
    initTestConfig({
      OZ_ACCOUNT_CLASS_HASH: '',
      OZ_ACCOUNT_CLASS_HASH_MAINNET: '',
      OZ_ACCOUNT_CLASS_HASH_TESTNET: '0xoz_testnet',
    });

    // testnet resolves; mainnet must throw NAMING the mainnet var (not borrow testnet's).
    expect(configFor('testnet').ozClassHash).toBe('0xoz_testnet');
    expect(() => configFor('mainnet')).toThrow(/OZ_ACCOUNT_CLASS_HASH_MAINNET/);
    expect(() => configFor('mainnet')).toThrow(/network 'mainnet'/);
  });
});
