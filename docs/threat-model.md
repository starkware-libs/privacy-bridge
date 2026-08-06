# Threat Model

**Goal:** unlinkability between the user's Starknet identity (derived SN account + pool notes) and
the EVM address that funds move to or from.

**Out of scope:** hiding activity from the pool **auditor** (inherent to `starknet-privacy` — the
auditor key can de-anonymize the SN side), and anything a consuming application layers on top. This
document covers `bridge-core` and the two anonymizer contracts only. An app that embeds the bridge
adds its own surfaces (analytics, session gates, server-side proxies, fiat on-ramp providers) and
owes its own threat model for them.

Scope note: `bridge-core` holds **no app-specific logic**. Callbacks the app injects
(`resolveDepositWallet`, `submitGaslessBatch`, the on-ramp's baseline/deposit legs) run outside this
boundary, and what they disclose is the app's to document.

## Adversaries

Public chain observers (Starknet and the EVM chains); RPC providers; Circle; the pool's prover,
relay, indexer, and auditor operators; the paymaster relayer; wallet-connector vendors.

## Private vs observable, per hop

| Hop                                              | Public                                                                                                                                                                                                                                                                                                                                                                                                                                       | Hidden                                                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Pool register / deposit / withdraw (proven legs) | pool + helper address, token, **amount**, that _someone_ deposited or withdrew. With `config.paymaster` set, the on-chain sender is **AVNU's relayer**; without it (testnet/dev) the sender is the shared **manager** account, which creates a public manager↔user-data linkage across all users                                                                                                                                            | the registrant/user identity inside the proof (it rides in proven calldata, not the sender); pool internals and viewing-key-derived data |
| CCTP burn, Starknet side (`OutboundAnonymizer`)  | `BurnInitiated{mint_recipient, amount}` — the destination address and amount leak, in the same tx that submits the proven withdraw                                                                                                                                                                                                                                                                                                           | nothing on this leg — no commitment rides here                                                                                           |
| CCTP mint, EVM side                              | amount, source/destination domain, recipient, anonymizer address. Submitted by **Circle's Forwarding Service relayer**, which is unlinkable to the user                                                                                                                                                                                                                                                                                      | —                                                                                                                                        |
| Leg A: reverse-CCTP burn (EVM → pool)            | the EVM burn to `InboundAnonymizer` with the return's **`commitment`** in `hookData`. On Starknet the whole return is **one** proof-authorized tx (`privacy_compute` → `privacy_invoke_with_computation`): the derived SN account is never the sender, appearing in neither calldata nor events. `ReturnBound{commitment, minted}` and `Claimed{commitment, amount}` are emitted, and the **same `commitment` is observable on both chains** | the `identity_key` preimage — never revealed; the pool recomputes it on-chain from the authenticated signer                              |
| Leg B: cash-out (pool → destination)             | proven withdraw + Starknet CCTP burn; `BurnInitiated{mint_recipient = destination, amount}` plus the destination address on both chains                                                                                                                                                                                                                                                                                                      | the SN-identity link, **provided** the funds rested in the pool first (see the re-link risk below)                                       |
| Local account store (`pmp.*` in localStorage)    | nothing on-chain — local only                                                                                                                                                                                                                                                                                                                                                                                                                | fund control: the store holds **no** private key, signature, or claim secret, so a reader can see but cannot move funds                  |

**Gas.** The Starknet legs are gasless when a paymaster is configured (SNIP-29 sponsors the account
deploy and the proven legs). The **EVM source leg of a deposit** (`approve` + `depositForBurn`) is
**user-paid** in native gas from the connected wallet; the paymaster does not reach it. The
mitigation is a native-gas preflight that fails with a fund-your-wallet message rather than a
mid-flight revert.

## Linkage risks

- **P0 amount correlation (accepted, mitigation deferred).** A distinctive amount is a 1:1
  fingerprint across pool-withdraw → burn → mint, and again across the return legs. Sizing a return
  from an account's actual post-fee balance produces a fee-shaped, non-round residue that is _more_
  distinctive, not less. The mitigation is **fixed denominations / bucketing** plus change-as-note.
  Until that exists, **make no unlinkability claim that depends on amount privacy.**
- **P0 anonymity set.** You hide among other users sharing your denomination and time window.
  Early-adopter sets are small — say so in any user-facing copy.
- **P0 cash-out re-link (Leg B, deliberate).** Cashing out to the user's own or otherwise known
  address links _that withdrawal_ to their identity. This is the user's intentional exit, and it
  stays unlinkable from earlier activity **only if** funds rested in the pool and any derived EVM
  account was returned via Leg A first. **Hard rule: never burn a derived trading account directly
  to the destination** — that ties the derived account to the destination and defeats the round trip.
- **Destination choice adds no new linkage.** Bridging out to a different EVM chain is visible on
  that chain, as any CCTP mint is, but unlinkability derives from the **pool withdrawal's** anonymity
  set, not from the destination. Picking a low-traffic chain narrows _that chain's_ crowd — a timing
  consideration inside the accepted P0, not a new join key.
- **Generic `moveFromPool` is only as safe as its `to`.** The primitive itself adds no on-chain
  surface. Funding a **reused** destination across operations re-links them into one identity.
  **Invariant:** derive a fresh recipient per operation; a deliberately reused or user-known
  destination is only ever the explicit Leg-B cash-out, with its re-link warning.
- **The return `commitment` is public on both chains.** It is a one-way Poseidon hash,
  `poseidon([poseidon([identity_key, dapp_name, source_domain]), nonce])`, with `identity_key`
  recomputed on-chain by the pool from the authenticated signer and `nonce` fresh per return. It
  reveals nothing about identity and cannot be inverted. It _does_ link the EVM burn to the Starknet
  mint — but the CCTP message's own nonce, amount, and timing already make that inference trivial,
  so this is minimal extra leakage, not a new join key. **Load-bearing:** the derived Starknet
  private key feeds `identity_key` for every return, so key secrecy protects the entire return
  history, not just the current one.
- **P0 shared-manager linkage — closed only with a paymaster.** Without `config.paymaster`, the
  proven legs are submitted by one shared manager account, and the same tx emits the outbound
  `BurnInitiated{mint_recipient}` — a public manager→recipient linkage spanning all users. With a
  paymaster configured, the relayer submits instead and this closes. Treat the testnet/dev path as
  **not** providing unlinkability.
- **P1 timing.** Withdraw → burn → attest → mint is a tight chain; an immediate
  return-then-cash-out with equal amounts correlates. Letting funds rest in the pool between legs,
  plus randomized delay, mitigates it — which is why the return and the cash-out are **separate user
  actions, never auto-chained**.
- **Under localStorage compromise** (XSS, shared machine, browser sync), the persisted store exposes
  the EVM↔SN↔derived-account linkage and the viewing key, which reveals in-pool note history; the
  in-flight cursors additionally expose a pending operation's destination and burn tx hash. No key,
  signature, or secret is stored, so an attacker can **see but not move**. Mitigate with a strict
  CSP, dependency review, and a "clear local data" control.

## Trust assumptions

- **Prover / relay non-collusion.** The prover receives the viewing key (HPKE-encrypted, IP-stripped
  via OHTTP + relay). Anonymity against the prover rests on relay ≠ prover and on no envelope logging.
- **Indexer (discovery service).** The SDK's discovery provider sends the raw viewing key in every
  request to `config.indexerUrl`, with **no OHTTP protection**. The indexer is trusted not to
  correlate viewing key against account address. Production must route through an equivalent privacy
  wrapper or use a trusted operator.
- **AVNU paymaster as oblivious submitter.** With `config.paymaster` set, AVNU sees the pool address,
  the proven call with its proof and `proof_facts`, and the deposit's signed `approve` typed data.
  The deposit leg additionally passes `user_address` (the derived SN account) so AVNU can build the
  SNIP-9 envelope — so **AVNU learns the derived account on deposit**. This is strictly better than
  manager-pays (no shared on-chain join key), at the cost of trusting AVNU not to correlate or
  censor. The API key is low-privilege: it cannot move funds, since every submit still needs the
  account's own signature.
- **AVNU key ships in the consumer's bundle.** The app inlines its env, so anyone inspecting the
  bundle can extract the paymaster key. Impact is bounded to sponsorship-quota exhaustion. Treat it
  as a rotatable, low-privilege credential — supply it from the deploy environment, never commit it.
- **WalletConnect / Reown (opt-in).** When a project id is configured the SDK initializes on app
  mount, so Reown is contacted at page load with the project id and deployment origin — before any
  pairing, and even if the user connects with an injected wallet instead. On pairing, the relay also
  sees the connecting EVM address and the `personal_sign` request/response. It never sees derived
  keys: derivation runs in-browser and the signature never leaves the device. Mitigation if the
  page-load ping matters: defer initialization until the user selects WalletConnect.
- **Injected (EIP-6963) wallets — the silent-signer hazard.** With two extensions installed, the last
  to load wins `window.ethereum`, so a naive read could sign with a wallet the user never chose and
  **silently re-key every derived identity** (all derivation seeds off one `personal_sign`). Three
  client-side mitigations contain it, and all three are load-bearing: (1) **signer binding** —
  `signMessage` recovers the signer from the exact bytes and throws unless it equals the connected
  account; the hex encoding is byte-identical to the derivation seed and **must not change**;
  (2) **provider pinning** — `connect(rdns)` selects the provider before `eth_requestAccounts`;
  (3) **ambiguous-multi guard** — with 2+ injected providers announced and none picked, the silent
  on-mount read refuses the bare global and forces the picker.
- **Auditor key** can de-anonymize the SN side. Inherent to `starknet-privacy`.
- **OFAC deposit screening** may reject deposits; the SN address is screened.
- **Runtime network switch (dev only).** Testnet↔mainnet switching is fenced to dev builds, because
  per-network production OHTTP infrastructure is not defined — in a prod build every network would
  resolve to the same upstream, silently pointing RPC/prover/indexer at one endpoint while pool and
  CCTP fields flipped. Lifting the fence requires **one OHTTP gateway per network**. A switch fully
  disconnects and wipes the derived session; only the non-secret in-flight deposit cursor survives
  by design, and its presence blocks the switch so a burn-but-not-minted transfer cannot be orphaned.

## Hard rules

Any change must uphold these. They are enforced mechanically where possible — by the
`no-log-secret-material` Semgrep rule (`.semgrep/privacy-bridge.yml`) and the eslint
`no-restricted-syntax` guard — and by review otherwise (`.cursor/BUGBOT.md`).

1. **Never log or persist** the raw wallet signature, any derived private key, or a claim/inbound
   secret. The **viewing key is the one exception** and may be persisted: it is read-only, discovers
   notes, and cannot move funds.
2. **The claim reveals no secret at all.** The pool recomputes `identity_key` and the commitment
   on-chain from the authenticated signer. The viewing key is never revealed on-chain — revealing it
   would expose all of the user's channel keys and nullifiers.
3. **Never let one endpoint see both identities.** No network call may carry the connected EVM
   address and the derived SN account together, and no derived identifier that joins them may be
   logged or persisted.
4. **Never reuse an address across legs**, and never introduce a shared submitter linkable to the
   user where an unlinkable one is required.
