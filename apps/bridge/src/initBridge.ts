// Bootstrap bridge-core config from the standalone bridge app's Vite env (Slice X —
// config injection). bridge-core reads NO import.meta.env of its own; the app owns
// its env and hands it in. `bridgeEnvFromRecord` copies the DEV/PROD flags and every
// VITE_* var (prefix stripped) into bridge-core's injected registry.
//
// This MUST run before any module reads bridge-core `config`. main.tsx imports it
// FIRST; it is also the vitest setupFile so app tests get an initialized config.
//
// bridge-core exposes a dedicated `./config` public-surface entry (alongside `.` and
// `./react`) for exactly this bootstrap: it maps to the self-contained config module
// (zero sibling imports), so importing it neither reaches past the `exports` map NOR
// eagerly loads bridge-core's WHOLE module graph. That matters here because this file
// is BOTH the production bootstrap (main.tsx imports it first) AND the vitest
// setupFile: importing the `.` barrel instead would load the real module graph during
// setupFiles, BEFORE any test file's hoisted `vi.mock` runs — permanently caching the
// leaves un-mockably for that test file (verified empirically in apps/web when
// switching to the barrel broke a network-edge mock). The `./config` subpath is a
// published specifier an extracted app consumes unchanged — see
// docs/bridge-sdk-refactor.md Slice Y / §6.
//
// PROD: the AVNU paymaster key NEVER ships in the bundle. Point the SDK's paymaster
// endpoint at the same-origin /api/avnu proxy (src/server/avnuProxy.ts), which
// injects the real x-paymaster-api-key from server-side env (AVNU_PAYMASTER_API_KEY).
// The 'edge-proxy' placeholder only flips the SDK's "paymaster ON" switch
// (resolvePaymaster is truthy-gated); the proxy overwrites the header, so the
// placeholder value is never trusted upstream. Absolute same-origin URL (not a bare
// '/api/avnu') for parity with any consumer that requires http(s) URLs.
// DEV (`pnpm dev` has no proxy): direct AVNU access with the dev-only
// VITE_AVNU_PAYMASTER_API_KEY.
import { bridgeEnvFromRecord, initBridgeConfig } from '@starkware-libs/starknet-privacy-bridge/config';

const rawEnv = import.meta.env as unknown as Record<string, unknown>;
const bridgeEnvRecord = {
  ...rawEnv,
  ...(import.meta.env.PROD
    ? {
        VITE_AVNU_PAYMASTER_URL: new URL('/api/avnu', window.location.origin).toString(),
        VITE_AVNU_PAYMASTER_API_KEY: 'edge-proxy',
      }
    : {}),
};

initBridgeConfig(bridgeEnvFromRecord(bridgeEnvRecord, 'VITE_'));
