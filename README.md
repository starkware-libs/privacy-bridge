# privacy-bridge

A value-movement engine for the
[`starknet-privacy`](https://github.com/starkware-libs/starknet-privacy) privacy pool. It moves USDC
between everyday EVM wallets/chains and the privacy pool, so users can fund a private balance and
later withdraw it — without linking the two sides on-chain.

## What it does

- **Into the pool** — takes USDC from an EVM wallet and deposits it into the privacy pool as a
  private note.
- **Out of the pool (BUY leg)** — withdraws from the pool and bridges USDC to a destination EVM
  chain, driven by the **`OutboundAnonymizer`** Cairo contract.
- **Back into the pool (RETURN leg)** — bridges USDC from an EVM chain back into the pool via the
  inbound **`InboundAnonymizer`** Cairo contract, which binds the incoming funds to a private note.
- **Cash out** — withdraws from the pool to the user's own EVM wallet.

Cross-chain USDC transfers use **Circle's CCTP** (burn-and-mint with attestation). All client-side
key material — Starknet key, viewing key, per-account EVM keys, and the note commitments — is
derived from a single wallet signature.

## Privacy model

The bridge is designed so that the deposit side and the withdrawal side of a transfer cannot be
linked on-chain. Secrets (the wallet signature and derived private keys) are never logged, persisted,
or revealed on-chain — the on-chain claim recomputes everything from the authenticated signer. The
only capability that may be persisted is the read-only **viewing key** (it can discover notes but
cannot move funds).

## Components

- `packages/bridge-anonymizers` — the `OutboundAnonymizer` and `InboundAnonymizer` Cairo contracts
  (Scarb workspace member). Build: `scarb build` · Test: `scarb test`.
- `packages/bridge-core` — the framework-agnostic TypeScript engine: value-movement orchestrators,
  key derivation, CCTP integration, and optional React hooks. Published as
  [`@starkware-libs/starknet-privacy-bridge`](./packages/bridge-core/README.md).
- `apps/bridge` — a demo web app built on `bridge-core`.

## Using the engine in your own app

Install [`@starkware-libs/starknet-privacy-bridge`](./packages/bridge-core/README.md) — it ships
from the GitHub npm registry and needs an authenticated install. See that README for the registry
setup and the API surface.

## Building this repo

**Prerequisites.** Node (version pinned in [`.nvmrc`](./.nvmrc)), [pnpm](https://pnpm.io/) (version
pinned by `packageManager` in `package.json`), and — for the Cairo contracts —
[Scarb](https://docs.swmansion.com/scarb/) and
[Starknet Foundry](https://foundry-rs.github.io/starknet-foundry/) at the versions pinned in
[`.tool-versions`](./.tool-versions), installable via
[starkup](https://github.com/software-mansion/starkup).

**Registry auth (required once).** The pool SDK `@starkware-libs/starknet-privacy-sdk` resolves from
the GitHub npm registry, which requires authentication even for public packages. pnpm deliberately
does not expand `${ENV}` in credential lines from the committed `.npmrc`, so the token has to live in
your user-level `~/.npmrc`:

```bash
echo "//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN" >> ~/.npmrc
```

The token needs the **`read:packages`** scope. `gh auth token` works only if the CLI has been granted
it — the default login has not, and `pnpm install` fails with `403 Forbidden` until you run
`gh auth refresh -s read:packages`.

**Then:**

```bash
pnpm install
pnpm build          # all workspace members
pnpm test           # vitest across the workspace
pnpm typecheck
pnpm lint           # conflict-marker check + eslint
scarb build         # Cairo contracts
scarb test          # snforge
```

`pnpm dev` runs the demo app at `apps/bridge` against a Vite dev server.

## Documentation

- [`docs/threat-model.md`](./docs/threat-model.md) — adversaries, per-hop observability, linkage
  risks, trust assumptions, and the hard rules any change must uphold.
- [`CLAUDE.md`](./CLAUDE.md) — architecture, config injection, repo workflow.
- [`packages/bridge-core/README.md`](./packages/bridge-core/README.md) — the engine's public API.

## License

[Apache-2.0](./LICENSE).
