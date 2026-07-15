// Test setup: inject bridge-core config (Slice X).
//
// bridge-core no longer reads import.meta.env — it resolves everything from the env
// handed to `initBridgeConfig(env)`. In production the consuming app maps its own
// build-time env; under test we inject these FAKE fixtures (no network is touched).
// The keys are the app env vars with the VITE_ prefix STRIPPED (that is the SDK's
// injected-config contract — see core/config.ts BridgeEnv / bridgeEnvFromRecord).
//
// `initTestConfig` is re-injected before every test so a case that swaps the env
// (config.test.ts, config.runtime-switch.test.ts) starts from a known-good baseline.
// Tests that need a different value call `initTestConfig({ overrides })` explicitly.
import { beforeEach } from 'vitest';
import { initBridgeConfig } from './src/core/config';

// Fixture env vars (VITE_-stripped keys). Mirrors the old vitest.config.ts `env:`
// block. Fake values only — deterministic and independent of any developer .env.
export const TEST_ENV_VARS: Readonly<Record<string, string | undefined>> = {
  NETWORK: 'testnet',
  CHAIN_ID: 'SN_SEPOLIA',
  PRIVACY_POOL_ADDRESS: '0x1',
  PROOF_VALIDITY_BLOCKS: '20',
  OZ_ACCOUNT_CLASS_HASH: '0x5b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564',
  STRK_TOKEN_ADDRESS: '0x3',
  ANONYMIZER_ADDRESS: '0x4',
  // Admin (manager) fixtures: the moved register/deposit/bridgeOut/manager-nonce
  // suites assert the MANAGER-paid proven-submit path, which requires config.admin.
  ADMIN_ADDRESS: '0x4',
  ADMIN_PRIVATE_KEY: '0x5',
  // Pin the AVNU paymaster OFF so config.paymaster is undefined and the proven legs
  // take the MANAGER path the suites assert. The dedicated paymaster suites mock
  // ./config directly.
  AVNU_PAYMASTER_API_KEY: '',
  AVNU_PAYMASTER_URL: '',
  AVNU_FEE_MODE: '',
  AVNU_POOL_FEE_TOKEN: '',
  // Deposit fixtures (native-USDC defaults) so the deposit module's view of config
  // is deterministic under test.
  DEPOSIT_TOKEN_ADDRESS: '0x6',
  DEPOSIT_TOKEN_SYMBOL: 'USDC',
  DEPOSIT_TOKEN_DECIMALS: '6',
  DEPOSIT_TOKEN_MINT_ENTRYPOINT: '',
  MAX_DEPOSIT: '1',
  DEPOSIT_FUNDING: 'treasury',
  // Pin the per-account denomination + CCTP Standard so tests are independent of a
  // developer's .env.local.
  ACCOUNT_DENOMINATION: '1',
  CCTP_FAST: 'false',
  POLYGON_CHAIN_ID: '80002',
  POLYGON_USDC_ADDRESS: '0x00000000000000000000000000000000000000a4',
  CCTP_EVM_TOKEN_MESSENGER: '',
  CCTP_TOKEN_MESSENGER: '',
  CCTP_MESSAGE_TRANSMITTER: '',
  CCTP_ATTESTATION_API: '',
  CCTP_DEFAULT_SOURCE_CHAIN_ID: '',
  POLYGON_RPC_URL: '',
  // WalletConnect off by default under test — the WC provider module is mocked in
  // the wallet suite, so no real projectId / relay is ever touched.
  WALLETCONNECT_PROJECT_ID: '',
};

// (Re-)inject the test config. `overrides` merge over the baseline vars; `flags`
// override the dev/prod build flags (vitest ran with DEV true historically).
export function initTestConfig(
  overrides: Readonly<Record<string, string | undefined>> = {},
  flags: { dev?: boolean; prod?: boolean } = {},
): void {
  initBridgeConfig({
    dev: flags.dev ?? true,
    prod: flags.prod ?? false,
    vars: { ...TEST_ENV_VARS, ...overrides },
  });
}

// Inject the baseline at file-load time (before any test module reads `config` at
// import) AND before each test (restoring the baseline after env-swapping cases).
initTestConfig();
beforeEach(() => {
  initTestConfig();
});
