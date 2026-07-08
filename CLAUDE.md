# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status: migration in progress

This repo (`starkware-libs/privacy-bridge`) is a **standalone home for the bridge** currently
living as `packages/bridge-core` (+ the `apps/bridge` demo app) inside the
`starkware-libs/polymarket-privacy` monorepo. The code is being extracted here **in small,
human-reviewable PRs** from the `polymarket-privacy` branch `feat/inbound-anonymizer-privacy-compute`.

Source of truth during migration: `~/Workspace/polymarket-privacy` (branch
`feat/inbound-anonymizer-privacy-compute`), packages `packages/bridge-core` and `apps/bridge`,
plus design docs under `docs/` (`bridge-plan.md`, `bridge-interface.md`, `bridge-sdk-refactor.md`,
`threat-model.md`, `security-privacy-review.md`, `flow-buy.md`, `flow-sell.md`,
`cctp-integration.md`). When porting a slice, copy the code AND its co-located tests together, and
keep the module's public surface (the `export * from` list in `src/api.ts` / `src/index.ts`) intact.

## What the bridge is

A **framework-agnostic value-movement engine** for the `starknet-privacy` privacy pool. It moves
USDC value between an EVM wallet/chain and the Starknet privacy pool, deriving all client-side key
material from a single wallet signature, and driving two Cairo "anonymizer" contracts. It contains
**no app-specific (Polymarket) logic** — consuming apps inject their own pieces via callbacks.

Value flows (see `src/api.ts` header and the `README.md` in `bridge-core`):

- `moveIntoPool` — EVM wallet → pool (deploy → register → deposit).
- `fundAccountFromPool` — pool → a derived per-account Polygon EOA (burn → attest → mint), the BUY path.
- `returnToPool` — deposit wallet → pool via CCTP burn-with-hook (the inbound/RETURN path).
- `cashOut` — pool → the user's own EVM wallet.

Bridging uses **Circle CCTP V2** (cross-chain USDC burn/mint + attestation). The RETURN path is
built on the pool's `privacy_compute` / `ComputeAndInvoke` mechanism: a burn carries an inbound
`commitment` in `hookData`, `InboundAnonymizer.receive_and_bind` atomically mints + credits a
ledger keyed by that commitment, and a single proven pool tx recomputes the commitment on-chain
from the authenticated signer and drains the ledger into a note. Secrets (viewing key, private
keys) are **never** revealed on-chain — everything recomputes from the signer.

## Architecture

Two package layers travel together:

- **`bridge-core`** (`@polymarket-privacy/bridge-core`) — the engine. Publishes exactly two entry
  points (no deep imports): `.` (plain async orchestrators + key derivation, no DOM/React) and
  `./react` (hooks wrapping the orchestrators in a `running`-flag state machine, plus a unified
  wallet layer). A third `./config` export exists for config injection.
  - `src/core/` — orchestrators (`moveIntoPool`, `bridgeOut`, `bridgeBack`, `deposit`, `register`,
    `polygonMint`, …) and building blocks (CCTP bytes/fees, paymaster, deploy, provider, tx,
    balance, account-store, errors).
  - `src/derivation/` — all key material derived from the wallet signature: Starknet key, viewing
    key, Polygon EOA, and the inbound/claim commitments. Absorbed from the former
    `packages/shared` (see `docs/bridge-sdk-refactor.md`, "Slice Z").
  - `src/react/` — hooks (`useMoveIntoPool`, `useOnrampFunding`, `useFundAccount`, `useReturn`,
    fee-estimate hooks) and `react/wallet/` (`WalletProvider`/`useWallet` — EIP-6963 injected +
    WalletConnect).
- **`apps/bridge`** — a Vite + React 19 demo app that consumes `bridge-core`. Context providers
  (`IdentityContext`, `NetworkContext`, `InFlightContext`) + flow components (`MoveIntoPool`,
  `MoveFromPool`, `PrivateBalance`).

### Config injection (important)

`bridge-core` reads **no** build-tool env (`import.meta.env` / `VITE_*`). The consuming app reads
its own env at startup and calls `initBridgeConfig(bridgeEnvFromRecord(import.meta.env, 'VITE_'))`
**before any other bridge-core import that touches config** — done first-thing in each app's
`src/initBridge.ts`. Tests inject fake config via a vitest setup file (`vitest.setup.ts`) calling
`initBridgeConfig` before every test.

### Injected callbacks (keeps app logic out of core)

`fundAccountFromPool` takes a `resolveDepositWallet` callback (app's CREATE2 deposit-wallet lookup);
`returnToPool` takes a `submitGaslessBatch` callback (relayer submission). bridge-core never imports
app types.

### Peer dependencies

`viem` (EVM client), `starknet` `10.0.0-beta.6` (Starknet account/provider + pool SDK), and optional
`react` (only for `./react`) are **peerDependencies** — installed by the consumer, not bundled, to
avoid duplicate instances. `@noble/curves`/`@noble/hashes` and `@walletconnect/ethereum-provider`
are regular deps. Note the pool SDK dependency `@starkware-libs/starknet-privacy-sdk` currently
resolves via a relative `file:../../../starknet-privacy/sdk` path — this must be re-pointed
(git/published dep) when the package leaves the monorepo.

## Commands

`bridge-core` (the package — these scripts travel with it):

- Build: `tsc` (clears `dist/` first) — `npm run build`
- Typecheck: `tsc --noEmit` — `npm run typecheck`
- Test: `vitest run` — `npm run test`
- Run one test file: `npx vitest run src/core/bridgeOut.test.ts`
- Run tests matching a name: `npx vitest run -t "partial pattern"`

`apps/bridge` (demo app): `npm run dev` (Vite dev server), `npm run build`
(`tsc --noEmit && vite build`), `npm run test`.

Tests are **co-located** with source (`*.test.ts` / `*.test.tsx`), run under vitest with the `jsdom`
environment. `bridge-core` excludes test files from the `tsc` build via `tsconfig.json`.

In the source monorepo the aggregate commands are `pnpm` + `turbo` (`pnpm build`, `pnpm test`,
`pnpm typecheck`, `pnpm lint` → conflict-marker check + eslint). Decide the standalone repo's
toolchain (pnpm workspace vs single package) as part of the migration.

## Repo workflow (branches, PRs, CI)

- **Use Graphite (`gt`) for all branch and PR operations** — not raw `git`/`gh` for
  branching, committing onto a branch, pushing, or opening/updating PRs. Trunk is `main`.
  Migration work lands as **small, stacked PRs** (`gt create` → `gt submit --stack`); keep each
  PR to one reviewable slice.
- `main` is protected: every change goes through a PR, CI (`cairo`) must pass, **1 approval**
  required (admins exempt), force-push and deletion blocked, conversations must be resolved.
- **Cursor Bugbot** reviews each PR (via the Cursor GitHub App, enabled per-repo in Cursor —
  not a workflow). `.github/workflows/bugbot-gate.yml` + `.github/scripts/bugbot-gate-check.sh`
  fail a PR with an unresolved MEDIUM+ Bugbot finding; `.cursor/BUGBOT.md` holds the review rules.
  Don't make "Cursor Bugbot" a required status check until the app is actually posting it.
- CI (`.github/workflows/ci.yml`) pins the toolchain via `.tool-versions` (Scarb / Starknet
  Foundry). Local Cairo tooling may be older than the pinned versions, so **CI is the
  authoritative green gate** for `scarb build` / `scarb test`.

## Conventions

- ESM only (`"type": "module"`), TypeScript, React 19 (automatic JSX runtime).
- `./react` hooks follow a `running`-flag state-machine pattern (see the source repo's
  `.claude/rules/code-style.md`).
- Never log or persist wallet signatures or private keys. The pool **viewing key** is the only
  capability that may be persisted (read-only: discovers notes, cannot move funds). See the source
  repo's `docs/threat-model.md` for the hard rules any change must uphold.
