// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  // Dev-proxy for RPC/prover/indexer, PER NETWORK. The bridge can switch network
  // at runtime (see NetworkContext), so BOTH networks' upstreams must be reachable
  // from one dev origin. bridge-core builds rpcUrl='/rpc/'+network in dev, so each
  // network's requests land on its own prefix (`/rpc/testnet`, `/rpc/mainnet`, …),
  // each proxied to that network's upstream env var. DEV-ONLY; in production the
  // browser reaches upstreams over OHTTP (one gateway per network — docs/threat-model.md).
  const proxy: Record<string, ProxyOptions> = {};

  // Proxy one network's prefix to its upstream. If the upstream env var is UNSET,
  // install a stub that returns a clear "network not configured in this dev server"
  // error instead of a silent 404 — so a half-configured .env.local is obvious.
  const addNetworkProxy = (kind: string, network: string, target: string | undefined) => {
    const path = `/${kind}/${network}`;
    const prefix = new RegExp(`^${path}`);
    if (!target) {
      proxy[path] = {
        target: 'http://127.0.0.1:0', // never reached — the bypass short-circuits.
        bypass: (_req, res) => {
          res.statusCode = 502;
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              error: `Network "${network}" ${kind} not configured in this dev server`,
              hint: `Set VITE_${kind === 'rpc' ? 'STARKNET_RPC' : kind.toUpperCase()}_URL_${network.toUpperCase()} in apps/bridge/.env.local`,
            }),
          );
          return path; // returning a string skips the proxy (serves the response above).
        },
      };
      return;
    }
    const isHttps = target.startsWith('https://');
    proxy[path] = {
      target,
      changeOrigin: true,
      secure: isHttps,
      rewrite: (reqPath) => reqPath.replace(prefix, ''),
    };
  };

  for (const network of ['testnet', 'mainnet']) {
    const N = network.toUpperCase();
    addNetworkProxy('rpc', network, env[`VITE_STARKNET_RPC_URL_${N}`]);
    addNetworkProxy('prover', network, env[`VITE_PROVER_URL_${N}`]);
    addNetworkProxy('indexer', network, env[`VITE_INDEXER_URL_${N}`]);
  }

  return {
    // Explicitly define VITE_E2E_WALLET as a build-time boolean so Rollup can
    // dead-code-eliminate the entire E2E wallet branch (including the dynamic
    // import → chunk) when the flag is unset. Without this, Vite replaces the
    // env ref with "" which is falsy but Rollup still emits the lazy chunk.
    define: {
      'import.meta.env.VITE_E2E_WALLET': JSON.stringify(env.VITE_E2E_WALLET || false),
    },
    // Polyfill Buffer/process/global for starknet + crypto chain.
    // Pinned 0.22.0 — 0.23.x's process shim breaks React's jsx-runtime.
    plugins: [nodePolyfills({ globals: { Buffer: true, global: true, process: true } }), react()],
    server: { proxy },
  };
});
