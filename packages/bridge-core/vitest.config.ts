// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // React plugin so the WalletProvider .tsx + its test use the automatic JSX
  // runtime React 19 expects (the rest of bridge-core is plain .ts and unaffected).
  plugins: [react()],
  test: {
    environment: 'jsdom',
    passWithNoTests: true,
    // bridge-core reads NO import.meta.env (Slice X — config is injected). The setup
    // file injects FAKE fixtures via initBridgeConfig before every test, so config
    // resolves deterministically. Env-swapping cases (config.test.ts,
    // config.runtime-switch.test.ts) call initTestConfig({ overrides }) themselves.
    setupFiles: ['./vitest.setup.ts'],
  },
});
