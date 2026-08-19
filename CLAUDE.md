# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What the bridge is

A **framework-agnostic value-movement engine** for the `starknet-privacy` privacy pool. It moves
USDC value between an EVM wallet/chain and the Starknet privacy pool, deriving all client-side key
material from a single wallet signature, and driving two Cairo "anonymizer" contracts. It contains
**no app-specific logic** — consuming apps inject their own pieces via callbacks.

Value flows (see the `src/api.ts` header and `packages/bridge-core/README.md`):

- `moveIntoPool` — EVM wallet → pool (deploy → register → deposit).
- `fundAccountFromPool` — pool → a derived per-account Polygon EOA (burn → attest → mint), the BUY path.
- `returnToPool` — deposit wallet → pool via CCTP burn-with-hook (the inbound/RETURN path).
- `cashOut` — pool → the user's own EVM wallet.
- `withdrawToStarknet` / `sendPrivateToStarknet` — pool → a Starknet address, or → another pool
  identity with the value staying inside the pool. One proven `apply_actions`, no CCTP leg.

Bridging uses **Circle CCTP V2** (cross-chain USDC burn/mint + attestation). The RETURN path is
built on the pool's `privacy_compute` / `ComputeAndInvoke` mechanism, in a **single transaction**:
the EVM burn carries an inbound `commitment` in `hookData`; on Starknet the pool derives that same
commitment from the authenticated signer via `InboundAnonymizer.privacy_compute`, then calls the
pool-only `privacy_invoke_with_computation`, which asserts the attested message's hookData
commitment matches, mints via `MessageTransmitterV2.receive_message`, and hands the minted USDC to
the pool as a fresh open note.

There is **no** decoupled "bind now, claim later" step and no ledger — mint and claim are atomic. A
return whose tx reverts strands nothing: the Circle-attested message stays replayable, so the client
retries from the persisted burn. Secrets (viewing key, private keys) are **never** revealed
on-chain — the commitment recomputes from the signer.

## Architecture

Three workspace members:

- **`packages/bridge-core`** (`@starkware-libs/starknet-privacy-bridge`) — the engine. Publishes
  exactly two entry points (no deep imports): `.` (plain async orchestrators + key derivation, no
  DOM/React) and `./react` (hooks wrapping the orchestrators in a `running`-flag state machine, plus
  a unified wallet layer). A third `./config` export exists for config injection.
  - `src/core/` — orchestrators (`moveIntoPool`, `bridgeOut`, `bridgeBack`, `deposit`, `register`,
    `polygonMint`, …) and building blocks (CCTP bytes/fees, paymaster, deploy, provider, tx,
    balance, account-store, errors).
  - `src/derivation/` — all key material derived from the wallet signature: Starknet key, viewing
    key, Polygon EOA, and the inbound/claim commitments.
  - `src/react/` — hooks (`useMoveIntoPool`, `useOnrampFunding`, `useFundAccount`, `useReturn`,
    fee-estimate hooks) and `react/wallet/` (`WalletProvider`/`useWallet` — EIP-6963 injected +
    WalletConnect).
- **`packages/bridge-anonymizers`** — the `OutboundAnonymizer` (pool → CCTP) and `InboundAnonymizer`
  (CCTP → pool) Cairo contracts, a Scarb workspace member.
- **`apps/bridge`** — a Vite + React 19 demo app that consumes `bridge-core`. Context providers
  (`IdentityContext`, `NetworkContext`, `InFlightContext`) + flow components (`MoveIntoPool`,
  `MoveFromPool`, `PrivateBalance`).

### Config injection (important)

`bridge-core` reads **no** build-tool env (`import.meta.env` / `VITE_*`). The consuming app reads
its own env at startup and calls `initBridgeConfig(bridgeEnvFromRecord(import.meta.env, 'VITE_'))`
**before any other bridge-core import that touches config** — done first-thing in each app's
`src/initBridge.ts`. Tests inject fake config via a vitest setup file (`vitest.setup.ts`) calling
`initBridgeConfig` before every test. A Semgrep rule (`.semgrep/privacy-bridge.yml`,
`bridge-core-no-build-env`) fails CI if core reaches for build env directly.

### Injected callbacks (keeps app logic out of core)

`fundAccountFromPool` takes a `resolveDepositWallet` callback (the app's CREATE2 deposit-wallet
lookup); `returnToPool` takes a `submitGaslessBatch` callback (relayer submission). bridge-core never
imports app types.

### Dependencies

`viem` (EVM client), `starknet` `10.0.0-beta.6` (Starknet account/provider + pool SDK), and optional
`react` (only for `./react`) are **peerDependencies** — installed by the consumer, not bundled, to
avoid duplicate instances. `@noble/curves`/`@noble/hashes` and `@walletconnect/ethereum-provider`
are regular deps.

The pool SDK `@starkware-libs/starknet-privacy-sdk` is a regular dependency resolved from **GitHub
Packages** (`npm.pkg.github.com`), not npmjs.org. GitHub Packages requires authentication even for
public packages, so a plain `pnpm install` needs a token in your **user-level** `~/.npmrc` — pnpm
deliberately does not expand `${ENV}` in credential lines from a committed `.npmrc`. One-time setup:

```
npm config set "//npm.pkg.github.com/:_authToken" "$(gh auth token)"
```

CI writes the same line from `secrets.GITHUB_TOKEN`. See `.npmrc` for the full note.

## Commands

Aggregate commands run from the repo root via pnpm + turbo:

- `pnpm build` · `pnpm typecheck` · `pnpm test` — fan out across all workspace members.
- `pnpm lint` — conflict-marker check + eslint.
- `pnpm format` / `pnpm format:check` — prettier.
- `pnpm dev` — runs each member's dev task in parallel (`apps/bridge` → Vite dev server).

Per-package, inside `packages/bridge-core`:

- Run one test file: `npx vitest run src/core/bridgeOut.test.ts`
- Run tests matching a name: `npx vitest run -t "partial pattern"`

Cairo, from the repo root (`packages/bridge-anonymizers` is the Scarb workspace member):

- `scarb fmt --check` · `scarb build` · `scarb test` (routed to `snforge test`).

Tests are **co-located** with source (`*.test.ts` / `*.test.tsx`), run under vitest with the `jsdom`
environment. `bridge-core` excludes test files from the `tsc` build via `tsconfig.json`.

## Repo workflow (branches, PRs, CI)

- **Use Graphite (`gt`) for all branch and PR operations** — not raw `git`/`gh` for
  branching, committing onto a branch, pushing, or opening/updating PRs. Trunk is `main`.
  Work lands as **small, stacked PRs** (`gt create` → `gt submit --stack`); keep each PR to one
  reviewable slice.
- `main` is protected: every change goes through a PR with review, force-push and deletion blocked,
  conversations must be resolved.
- CI gates on `.github/workflows/`: `cairo` + `bridge` (`ci.yml`), `semgrep` (`semgrep.yml`), and
  `bugbot-gate` (`bugbot-gate.yml`).
- **Cursor Bugbot** reviews each PR (via the Cursor GitHub App, enabled per-repo in Cursor —
  not a workflow). `.github/workflows/bugbot-gate.yml` + `.github/scripts/bugbot-gate-check.sh`
  fail a PR with an unresolved MEDIUM+ Bugbot finding; `.cursor/BUGBOT.md` holds the review rules.
- CI pins the Cairo toolchain via `.tool-versions` (Scarb / Starknet Foundry) and Node via `.nvmrc`.
  Local Cairo tooling may be older than the pinned versions, so **CI is the authoritative green
  gate** for `scarb build` / `scarb test`.
- `pnpm-workspace.yaml` carries supply-chain hardening (`minimumReleaseAge`, `trustPolicy`,
  `blockExoticSubdeps`) — these require pnpm >=10.26, hence the `packageManager` pin.

## Conventions

- ESM only (`"type": "module"`), TypeScript, React 19 (automatic JSX runtime).
- **Relative imports in compiled `bridge-core` sources carry an explicit `.js` extension**
  (`./core/config.js`). Plain `tsc` emits specifiers verbatim and native Node ESM rejects
  extensionless ones; `src/distEsmEntryPoints.test.ts` imports every `exports` entry point in a real
  `node --input-type=module` child so the published `dist` stays loadable outside a bundler.
- `./react` hooks follow a `running`-flag state-machine pattern.
- Comment style: see `.claude/skills/concise-comments/SKILL.md` — describe the present, don't narrate
  history.
- The privacy hard rules any change must uphold — secret hygiene (and the viewing-key exception) and
  on-chain unlinkability — are in `.cursor/BUGBOT.md`, in priority order.
