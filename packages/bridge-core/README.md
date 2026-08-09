# @polymarket-privacy/bridge-core

Framework-agnostic value-movement engine for the `starknet-privacy` pool: moves funds
pool ⇄ EVM, derives all client-side key material, and talks to the anonymizer
(Cairo contract) on the caller's behalf. No app-specific (Polymarket) logic lives
here — apps inject the parts that are theirs (see "Injected callbacks" below).

## Package surface

Two entry points only (`exports` map = `{".", "./react"}` — no deep imports):

- **`.`** — plain async orchestrators + key derivation. No DOM, no React.
- **`./react`** — hooks that wrap the root orchestrators in a `running`-flag state
  machine (see `.claude/rules/code-style.md`), plus the shared wallet layer.

### Root (`.`) — orchestrators

| Export | Flow |
|---|---|
| `moveIntoPool(args: MoveIntoPoolArgs)` | EVM wallet → pool (deploy → register → deposit; deposit gas is native, no app-built gasless path) |
| `fundAccountFromPool(args: FundAccountFromPoolArgs)` | pool → derived per-account Polygon EOA (burn → attest → mint) |
| `cashOut(args: CashOutArgs)` | pool → user's own EVM wallet |
| `returnToPool(args: ReturnToPoolArgs)` | deposit wallet → pool (burn → claim → poke) |
| `withdrawToStarknet(args: StarknetPayoutArgs)` | pool → any Starknet address (one proven tx, no CCTP) |
| `sendPrivateToStarknet(args: StarknetPayoutArgs)` | pool → another pool identity; the value never leaves the pool |

Plus the lower-level building blocks these compose (`registerWithPool`, `depositToPool`,
`ensureAccountDeployed`, `bridgeOut`/`bridgeOutToWallet`, `returnBurnToPool`/`claimToPool`,
`waitForBridgedMint`, `scanDerivedAccounts`, fee/balance helpers, and all key-derivation
primitives) — see `src/api.ts` and `src/index.ts` for the full list.

### `./react` — hooks

| Hook | Wraps |
|---|---|
| `useMoveIntoPool()` | `moveIntoPool` — running-flag + per-step progress |
| `useOnrampFunding()` | baseline read → poll/grace → `moveIntoPool` (card on-ramp) |
| `useFundAccount()` | `fundAccountFromPool` |
| `useReturn()` | `returnToPool` / `cashOut` |
| `useUsdcGasCapability(provider, chainId, address)` | `detectUsdcGasCapability` |
| `useDepositCctpFeeEstimate(amountWei, sourceChainId, opts)` | `fetchForwardMaxFee` |
| `useBridgeFundingEstimate(...)` | fee/cap-aware funding-plan estimate |
| `WalletProvider` / `useWallet` | unified injected (EIP-6963) + WalletConnect wallet layer |

## Config injection

bridge-core reads **no** build-tool env (`import.meta.env`/`VITE_*`) — it is not
Vite-only. The consuming app reads its own env at startup and calls:

```ts
import { bridgeEnvFromRecord, initBridgeConfig } from '@polymarket-privacy/bridge-core';

initBridgeConfig(bridgeEnvFromRecord(import.meta.env, 'VITE_'));
```

This must run before any other bridge-core import that touches `config` (each app
does this first thing in its entrypoint — see `apps/web/src/initBridge.ts` /
`apps/bridge/src/initBridge.ts`). `bridgeEnvFromRecord` strips the app's env prefix
and copies the `DEV`/`PROD` build flags; every value stays individually overridable,
with network-scoped defaults baked into the SDK.

## Peer requirements

Declared as `peerDependencies` (installed by the consumer, not bundled, to avoid
duplicate instances):

| Peer | Why |
|---|---|
| `viem` `^2.21.0` | EVM client (Polygon reads/writes, CCTP calldata) |
| `starknet` `10.0.0-beta.6` | Starknet account/provider + pool SDK calls |
| `react` `>=18.0.0` (optional) | only needed if you import `./react` |

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
