# privacy-bridge

Standalone home for the **bridge** — a value-movement engine for the `starknet-privacy`
privacy pool that moves USDC between EVM chains and the pool via Circle CCTP, driven by two
Cairo "anonymizer" contracts.

The code is being extracted here **in small, human-reviewable PRs** from the
`starkware-libs/polymarket-privacy` monorepo (branch `feat/inbound-anonymizer-privacy-compute`).
See [`CLAUDE.md`](./CLAUDE.md) for architecture and the migration plan.

## Layout (as it fills in)

- `packages/contracts-cairo` — the outbound `Anonymizer` and inbound `InboundAnonymizer` Cairo
  contracts (Scarb workspace). Build: `scarb build` · Test: `scarb test` (Starknet Foundry).
- `packages/bridge-core` — the TypeScript value-movement engine (arriving in later PRs).
- `apps/bridge` — a demo app consuming `bridge-core` (arriving in later PRs).

Toolchain versions are pinned in [`.tool-versions`](./.tool-versions).
