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
  key derivation, CCTP integration, and optional React hooks.
- `apps/bridge` — a demo web app built on `bridge-core`.

See [`CLAUDE.md`](./CLAUDE.md) for the full architecture.
