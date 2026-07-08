# Bugbot review rules — privacy-bridge

Framework-agnostic **value-movement engine** for the `starknet-privacy` privacy pool: it moves USDC
between EVM chains and the pool via Circle CCTP, driven by two Cairo anonymizer contracts. It holds
**no app-specific logic** — consuming apps inject their own pieces via callbacks. The load-bearing
invariant: a transfer's two sides (the user's Starknet identity/pool and the EVM address funds move
to/from) must be **unlinkable on-chain**, and client secrets must never leave the browser.

Review against the rules below in priority order.

## 1. Privacy / unlinkability (top priority)
- **Flag** anything that links the user's Starknet identity (SN account + pool) to a derived EVM
  address (per-account EOA or CREATE2 deposit wallet): an address reused across legs/chains, a shared
  submitter/relayer key spanning legs, or a CCTP `mintRecipient` that ties the two sides.
- **Flag** logging or persisting derived identifiers that join identities (EVM ↔ SN ↔ per-account EOA).
- **Flag** new network calls that send both identities (connected EVM address + derived SN account)
  to the same endpoint, or that otherwise correlate them.
- **Flag** a mint/tx submitter that is user-controlled or otherwise linkable to the user (e.g.
  reintroducing a user relayer key, or a wallet-submits-mint fallback) where an unlinkable submitter
  is required.

## 2. Secret hygiene
- **Never log or persist** the raw wallet signature or any **private key** (Starknet key, per-account
  EVM key) or claim/inbound secret. **Flag** `console.*` / `localStorage` / `sessionStorage` /
  telemetry / any network send of these.
- **Nuance:** the pool **viewing key MAY be persisted** — a read-only capability (discovers notes,
  cannot move funds). Addresses, public keys, and recomputable non-secret metadata are fine. Don't
  flag viewing-key persistence; DO flag private-key / signature / claim-secret persistence.
- CI enforces a `no-restricted-syntax` guard against passing signature/privateKey/secret-named values
  to `console.*` / storage in `packages/bridge-core/src/core`. **Flag** weakening or evading it.

## 3. CCTP / cross-chain value path
- **Recipient receives `amount − max_fee`** (Circle deducts its fee in USDC from the burned amount).
  **Flag** value math that forwards/deposits the gross where it should use the net (or vice versa).
- The Cairo outbound contract **asserts `amount > max_fee`** (`AMOUNT_LE_MAX_FEE`) and
  `amount != 0` (`ZERO_AMOUNT`). **Flag** weakening/removing those asserts, or fee math that lets
  `amount ≤ max_fee` through pre-flight.
- **Flag** wrong CCTP domains / chain IDs, or polling the wrong (sandbox vs mainnet) attestation API
  for a burn — it never resolves.
- **Flag** the inbound path accepting a mint by any route other than the `destination_caller`-gated
  `receive_and_bind`, crediting the ledger by a *trusted* amount rather than the real minted balance
  delta, or binding to a caller-supplied commitment rather than the attested message's `hookData`.
- Attestation polling must be idempotent by message hash and resume via the in-flight cursor —
  **flag** changes that re-burn instead of re-poll, or that can strand mid-CCTP funds.

## 4. Cairo / pool fidelity
- The `starknet-privacy` Cairo/SDK is the **source of truth** for pool semantics. **Flag**
  reimplementing its hashing/commitment/encryption instead of mirroring or calling it.
- Respect pool constraints: one `InvokeExternal` per tx; the outbound Anonymizer only `approve`s +
  returns `Span<OpenNoteDeposit>` and **never calls back into the pool** (reentrancy). The claim must
  recompute the commitment on-chain from the **authenticated signer** and reveal no secret. **Flag**
  divergence.

## 5. TypeScript (bridge-core, when present)
- Strict mode. **Flag** new `any` in production code (allow in tests / typed external boundaries with
  a justifying comment). Use `import type` for type-only imports (`verbatimModuleSyntax` is on).
- **Flag** new `console.*` in `packages/bridge-core/src` — both a secret-leak vector (§2) and noise.
- bridge-core reads **no** build-tool env (`import.meta.env` / `VITE_*`); config is injected. **Flag**
  new direct env reads in bridge-core.

## 6. Correctness & robustness (mechanical defects)
- Missing `await` / unhandled rejection / a write-once path that can double-fire — especially across
  the burn → attest → mint legs.
- Starknet **nonce** assumptions: a pre-confirmed tx does not advance the RPC nonce; back-to-back
  submits need a local-authoritative counter, not a re-read.
- Over-trusted external responses (RPC, prover, indexer, Circle Iris): missing length/shape checks, a
  cast hiding a shape mismatch, or decode-length assumptions on the CCTP message layout.
- Denomination/units bugs: USDC decimals, raw-amount conversion, gross-vs-net (see §3).

## Severity
Assign severity honestly; do not inflate to force a block. Low-severity / style findings are welcome
as **non-blocking comments**.
