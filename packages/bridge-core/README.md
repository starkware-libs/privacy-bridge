# @starkware-libs/starknet-privacy-bridge

Framework-agnostic value-movement engine for the `starknet-privacy` pool: moves funds
pool ⇄ EVM, derives all client-side key material, and talks to the anonymizer
(Cairo contract) on the caller's behalf. No app-specific (Polymarket) logic lives
here — apps inject the parts that are theirs (see "Injected callbacks" below).

## Installation

Published to the **GitHub npm registry**, not npmjs.org. GitHub Packages requires
authentication even for public packages, so point the scope at the registry and
supply a token before installing:

```bash
npm config set "@starkware-libs:registry" "https://npm.pkg.github.com"
echo "//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN" >> ~/.npmrc
```

`YOUR_GITHUB_TOKEN` needs the **`read:packages`** scope. A classic PAT works; so does
`gh auth token`, but only once the CLI has been granted that scope — the default login
does not include it, and the install fails with `403 Forbidden` until you run:

```bash
gh auth refresh -s read:packages
```

Then:

```bash
npm install @starkware-libs/starknet-privacy-bridge
```

From a specific commit (git) instead of a tagged release:

```bash
npm install "starkware-libs/privacy-bridge#<commit-sha>"
```

## Package surface

Three entry points (`exports` map = `{".", "./react", "./config"}` — no deep imports):

- **`.`** — plain async orchestrators + key derivation. No DOM, no React.
- **`./react`** — hooks that wrap the root orchestrators in a `running`-flag state
  machine, plus the shared wallet layer.
- **`./config`** — the config bootstrap only (see below).

### Root (`.`) — orchestrators

| Export                                               | Flow                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `moveIntoPool(args: MoveIntoPoolArgs)`               | EVM wallet → pool (deploy → register → deposit; deposit gas is native, no app-built gasless path) |
| `fundAccountFromPool(args: FundAccountFromPoolArgs)` | pool → derived per-account Polygon EOA (burn → attest → mint)                                     |
| `cashOut(args: CashOutArgs)`                         | pool → user's own EVM wallet                                                                      |
| `returnToPool(args: ReturnToPoolArgs)`               | deposit wallet → pool (burn → claim → poke)                                                       |

Plus the lower-level building blocks these compose (`registerWithPool`, `depositToPool`,
`ensureAccountDeployed`, `bridgeOut`/`bridgeOutToWallet`, `returnBurnToPool`/`claimToPool`,
`waitForBridgedMint`, `scanDerivedAccounts`, fee/balance helpers, and all key-derivation
primitives) — see `src/api.ts` and `src/index.ts` for the full list.

### `./react` — hooks

| Hook                                                        | Wraps                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| `useMoveIntoPool()`                                         | `moveIntoPool` — running-flag + per-step progress          |
| `useOnrampFunding()`                                        | baseline read → poll/grace → `moveIntoPool` (card on-ramp) |
| `useFundAccount()`                                          | `fundAccountFromPool`                                      |
| `useReturn()`                                               | `returnToPool` / `cashOut`                                 |
| `useUsdcGasCapability(provider, chainId, address)`          | `detectUsdcGasCapability`                                  |
| `useDepositCctpFeeEstimate(amountWei, sourceChainId, opts)` | `fetchForwardMaxFee`                                       |
| `useBridgeFundingEstimate(...)`                             | fee/cap-aware funding-plan estimate                        |
| `WalletProvider` / `useWallet`                              | unified injected (EIP-6963) + WalletConnect wallet layer   |

## Config injection

bridge-core reads **no** build-tool env (`import.meta.env`/`VITE_*`) — it is not
Vite-only. The consuming app reads its own env at startup and calls:

```ts
import {
  bridgeEnvFromRecord,
  initBridgeConfig,
} from '@starkware-libs/starknet-privacy-bridge/config';

initBridgeConfig(bridgeEnvFromRecord(import.meta.env, 'VITE_'));
```

Import from the `./config` subpath, not the root barrel. `./config` maps to the
self-contained config module, so it neither reaches past the `exports` map nor
eagerly loads bridge-core's whole module graph — which matters because this bootstrap
usually doubles as the test setup file, where pulling in the barrel would cache the
real modules before any hoisted `vi.mock` runs.

This must run before any other bridge-core import that touches `config` (the app does
this first thing in its entrypoint — see `apps/bridge/src/initBridge.ts`).
`bridgeEnvFromRecord` strips the app's env prefix and copies the `DEV`/`PROD` build
flags; every value stays individually overridable, with network-scoped defaults baked
into the SDK.

## Peer requirements

Declared as `peerDependencies` (installed by the consumer, not bundled, to avoid
duplicate instances):

| Peer                          | Why                                              |
| ----------------------------- | ------------------------------------------------ |
| `viem` `^2.21.0`              | EVM client (Polygon reads/writes, CCTP calldata) |
| `starknet` `10.0.0-beta.6`    | Starknet account/provider + pool SDK calls       |
| `react` `>=18.0.0` (optional) | only needed if you import `./react`              |

`@noble/curves`/`@noble/hashes` (key derivation) and `@walletconnect/ethereum-provider`
(wallet layer) are regular `dependencies` — they're bridge-only and safe to bundle.

## Injected callbacks (Polymarket/app stays out of core)

`fundAccountFromPool` takes a `resolveDepositWallet` callback (Polymarket CREATE2
deposit-wallet lookup); `returnToPool` takes a `submitGaslessBatch` callback (relayer
submission). Both are dependency-injected by the app — bridge-core never imports
Polymarket types or talks to a CLOB.

## Secrets

Orchestrators take the raw wallet `signature` as an in-memory argument and derive
keys internally; they never log or persist the signature or any private key. The
pool **viewing key** is the only capability that may be persisted (read-only —
discovers notes, cannot move funds).
