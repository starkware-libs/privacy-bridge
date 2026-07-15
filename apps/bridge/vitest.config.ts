import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Test-only Vite config — deliberately separate from vite.config.ts so the
// dev-server proxy never loads during tests.
// `test.env` values are exposed as import.meta.env to code under test. These are
// dummy fixtures: bridge-core/config.ts dereferences every VITE_ var below at
// module load, so all must be present or importing the app throws.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    // Inject bridge-core config from import.meta.env (Slice X) before any test module
    // reads bridge-core `config`. The `env:` fixtures below populate import.meta.env,
    // which initBridge.ts maps into bridge-core via bridgeEnvFromRecord.
    setupFiles: ['./src/initBridge.ts'],
    env: {
      // Pin master network switch to testnet (independent of .env.local).
      VITE_NETWORK: 'testnet',
      VITE_CHAIN_ID: 'SN_SEPOLIA',
      VITE_PRIVACY_POOL_ADDRESS: '0x1',
      VITE_RPC_URL: 'https://rpc.example.com',
      VITE_PROVER_URL: 'https://prover.example.com',
      VITE_INDEXER_URL: 'https://indexer.example.com',
      VITE_PROOF_VALIDITY_BLOCKS: '20',
      VITE_OZ_ACCOUNT_CLASS_HASH:
        '0x5b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564',
      VITE_STRK_TOKEN_ADDRESS: '0x3',
      VITE_ADMIN_ADDRESS: '0x4',
      VITE_ADMIN_PRIVATE_KEY: '0x5',
      VITE_AVNU_PAYMASTER_API_KEY: '',
      VITE_AVNU_PAYMASTER_URL: '',
      VITE_AVNU_FEE_MODE: '',
      VITE_AVNU_POOL_FEE_TOKEN: '',
      VITE_DEPOSIT_TOKEN_ADDRESS: '0x6',
      VITE_DEPOSIT_TOKEN_SYMBOL: 'USDC',
      VITE_DEPOSIT_TOKEN_DECIMALS: '6',
      VITE_DEPOSIT_TOKEN_MINT_ENTRYPOINT: '',
      VITE_MAX_DEPOSIT: '1',
      VITE_DEPOSIT_FUNDING: 'treasury',
      VITE_CCTP_FAST: 'false',
      VITE_POLYGON_CHAIN_ID: '80002',
      VITE_POLYGON_RPC_URL: 'https://rpc-amoy.polygon.technology',
      VITE_POLYGON_USDC_ADDRESS: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
      VITE_CCTP_EVM_TOKEN_MESSENGER: '0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5',
      VITE_WALLETCONNECT_PROJECT_ID: '',
      VITE_ACCOUNT_DENOMINATION: '1',
      VITE_MAX_ACCOUNT_AMOUNT: '5',
      VITE_ANONYMIZER_ADDRESS: '',
    },
  },
});
