// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Shared Starknet CCTP mint primitives for the DEPOSIT-IN leg, plus the RETURN leg's
// client-side pre-flight message gates.
//
//   - MessageTransmitterV2.receive_message(message, attestation) (submitStarknetMint)
//     so the bridged native USDC mints to the recipient baked into the CCTP message.
//     Permissionless (the destination_caller check is the contract-level access gate,
//     not an on-chain sender check), so the MANAGER (or AVNU's sponsored relayer) submits
//     — keeping the recipient STRK-free, matching the manager-pays model used for the
//     proven legs (proven-submit.ts). Tracked to ACCEPTED_ON_L2 so a subsequent read
//     sees the new state.
//
// The RETURN leg NO LONGER submits a standalone mint here: its CCTP `receive_message`
// is FOLDED INTO the proven pool claim (bridgeBack.ts:buildAndProveClaim →
// InboundAnonymizer.privacy_invoke_with_computation), so mint + claim are ONE atomic,
// proof-authorized pool tx (the user's derived account is never the on-chain sender —
// closes the A↔deposit-wallet leak). All that survives here for the return leg is the
// client-side pre-flight validation (assertReturnCctpMessage), run by bridgeBack before
// it proves a doomed claim.
//
// Callers:
//   - deposit-in (depositIn.ts): submitStarknetMint, recipient = the derived SN account;
//   - return-in (bridgeBack.ts): assertReturnCctpMessage (pre-flight only).
//
// LIVE-VERIFICATION BOUNDARY (.claude/rules/verification.md): the cross-chain
// mint can only be confirmed against a live Starknet MessageTransmitterV2/
// InboundAnonymizer + live CCTP infra. The unit tests pin the client behaviour (the
// A1 validation gate, the calldata shape, and the manager-paid submit) against
// mocked submit infra.

import type { Account, Call, PaymasterDetails, RpcProvider } from 'starknet';

import { config } from './config';
import { submitAndTrack } from './tx';
import { managerExecute } from './proven-submit';
import { assertCctpMessageMatches } from './polygonMint';
import { encodeCctpBytes } from './cctpBytes';
import { toHexFelt } from './avnuPaymaster';

// A Starknet felt address → a left-padded 32-byte word, the CCTP mintRecipient
// form (Starknet addresses are < 2^252, so they fit in 32 bytes). docs/bridge-plan.md §3.
// Exported: depositIn.ts and returnIn.ts share this exact implementation.
export function snAddressToBytes32(snAddress: string): `0x${string}` {
  const hex = snAddress.replace(/^0x/i, '').toLowerCase();
  if (hex.length > 64) {
    throw new Error('snMint: Starknet recipient does not fit in 32 bytes');
  }
  return `0x${hex.padStart(64, '0')}`;
}

// destinationCaller lives in the CCTP-v2 MessageV2 HEADER at absolute byte offset
// 108 (polygonMint.ts's layout doc: `[108..140) destinationCaller bytes32`).
// Extracted locally (rather than extending polygonMint.ts's decodeCctpMessage,
// whose exact return shape other tests pin with `toEqual`) — a minimal,
// purpose-built reader for the ONE new bypass-proof check below.
const OFF_DESTINATION_CALLER = 108;
const DESTINATION_CALLER_LEN = 32;

function extractDestinationCallerFull(message: `0x${string}`): `0x${string}` {
  const hex = message.startsWith('0x') ? message.slice(2) : message;
  const start = OFF_DESTINATION_CALLER * 2;
  const end = start + DESTINATION_CALLER_LEN * 2;
  return `0x${hex.slice(start, end).toLowerCase()}`;
}

// BYPASS-PROOF SAFETY GATE (RETURN leg): the attested message's destinationCaller
// MUST equal the InboundAnonymizer. The return burn sets destinationCaller = inbound
// so that `MessageTransmitterV2.receive_message` reverts for anyone but the inbound
// contract — the ONLY path that can consume the message is the InboundAnonymizer's own
// internal `receive_message` call, folded inside the proven
// `privacy_invoke_with_computation` (which then binds the mint to the signer's
// commitment and hands it to the pool). Were destinationCaller left 0, a plain
// permissionless mint could land the USDC on the inbound contract WITHOUT the folded
// claim's commitment binding, stranding it. This just double-checks that invariant
// client-side before we prove a doomed claim. Throws the SAME terminal
// "recipient/domain mismatch" message as assertCctpMessageMatches so it is classified
// non-transient (never resume-looped) by the caller.
function assertDestinationCallerMatches(message: `0x${string}`, expectedInbound: string): void {
  const actual = extractDestinationCallerFull(message);
  const expected = snAddressToBytes32(expectedInbound).toLowerCase();
  if (actual !== expected) {
    throw new Error(
      'CCTP message recipient/domain mismatch — refusing to submit (destinationCaller must be the InboundAnonymizer).',
    );
  }
}

// RETURN-leg pre-flight validation (shared): assert the attested CCTP message both
// (a) matches the expected EVM source domain, the Starknet destination domain, and the
// InboundAnonymizer as its mintRecipient (assertCctpMessageMatches — Iris is a TRUSTED
// oblivious service, so a tampered/MITM'd attestation could redirect the mint), and
// (b) carries destinationCaller = the InboundAnonymizer (the bypass-proof gate above).
// Called by bridgeBack.ts BEFORE proving the folded claim so a doomed message is never
// proven. Both gates throw the SAME terminal "recipient/domain mismatch" error so the
// caller classifies it non-transient (never resume-looped). Lives here (snMint) — the
// home of the CCTP message readers (snAddressToBytes32 / destinationCaller) — so the
// fold's client-side guard stays in one place rather than re-derived in bridgeBack.
// `inbound` defaults to the CURRENT config, but resume/recovery pass the BURN-TIME
// InboundAnonymizer (from the cursor) so a mid-return address redeploy validates the
// attested message against the SAME contract the claim targets — otherwise the pre-flight
// would reject an old-address message with a terminal recipient/domain mismatch.
export function assertReturnCctpMessage(
  message: `0x${string}`,
  sourceDomain: number,
  inbound: string = config.inboundAnonymizerAddress,
): void {
  assertCctpMessageMatches(message, {
    expectedSourceDomain: sourceDomain,
    expectedDestinationDomain: config.cctp.starknetDomain,
    expectedRecipient: snAddressToBytes32(inbound),
  });
  assertDestinationCallerMatches(message, inbound);
}

// Builds the Starknet `MessageTransmitterV2.receive_message(message, attestation)`
// Call that mints the bridged USDC to the recipient baked into the CCTP message.
// ONE source of truth for the call construction, shared by the standalone
// submitStarknetMint tx (below) AND the PART B single-tx fold (deposit.ts), where
// this exact call is folded into the pool deposit's atomic invoke multicall so the
// mint + approve + pool pull + deposit run as one Starknet tx. `cfg` is threaded (not
// the module `config`) so callers pass the same config instance they build the rest
// of the tx from. Calldata is the two CCTP byte-arrays (message then attestation),
// encoded via encodeCctpBytes exactly as the on-chain entrypoint expects.
export function buildReceiveMessageCall(
  cfg: typeof config,
  message: `0x${string}`,
  attestation: `0x${string}`,
): Call {
  return {
    contractAddress: cfg.cctp.snMessageTransmitter,
    entrypoint: 'receive_message',
    calldata: [...encodeCctpBytes(message), ...encodeCctpBytes(attestation)],
  };
}

// Builds the submit thunk for the permissionless Starknet receive_message invoke:
// prefer the AVNU SPONSORED paymaster (relayer pays gas; no proof needed — it's a
// plain permissionless invoke) when the account is paymaster-enabled, else fall
// back to the manager-paid submit (testnet/dev). Used by submitStarknetMint
// (deposit-in). NOTE: the RETURN leg no longer uses this — its mint is folded into
// the proof-authorized claim (bridgeBack.ts → privacy_invoke_with_computation).
function buildPermissionlessSubmit(
  provider: RpcProvider,
  account: Account | undefined,
  call: Call,
): () => Promise<{ transaction_hash: string }> {
  return config.paymaster && account
    ? () => {
        const feesDetails: PaymasterDetails = { feeMode: { mode: 'sponsored' } };
        // AVNU's paymaster_buildTransaction requires 0x-hex calldata felts; normalise
        // here so the boundary is explicit (encodeCctpBytes already emits 0x-hex via
        // CairoByteArray — toHexFelt is idempotent on it; account.execute on the
        // manager path accepts either, so the plain `call` is fine there).
        const hexCall: Call = { ...call, calldata: (call.calldata as string[]).map(toHexFelt) };
        return account.executePaymasterTransaction([hexCall], feesDetails);
      }
    : () => managerExecute(provider, call, { tip: 0n });
}

export interface SubmitStarknetMintArgs {
  // Starknet RPC provider (threaded to the submit + tracker).
  provider: RpcProvider;
  // The recipient's derived account, paymaster-enabled (makeAccount auto-attaches the
  // PaymasterRpc when config.paymaster is set). When present AND a paymaster is
  // configured, receive_message is submitted GASLESS via AVNU's relayer
  // (sponsored mode) so no manager and no recipient STRK is needed. Omit (or no
  // paymaster) → the legacy manager-paid submit. receive_message is permissionless,
  // so any sender — AVNU's relayer or the manager — is valid; the recipient is baked
  // into the CCTP message.
  account?: Account;
  // CCTP message bytes (hex) from Iris, replayed opaquely into receive_message.
  message: `0x${string}`;
  // Circle's attestation signature over the message (hex).
  attestation: `0x${string}`;
  // The felt/address the CCTP message must mint to (validated as the expected
  // mint recipient on the Starknet destination domain). Deposit-in passes the
  // derived SN account. (The return leg mints via the folded proof-authorized
  // claim — bridgeBack.ts — not this path.)
  recipient: string;
  // CCTP domain of the chain the burn happened on (the EVM source domain).
  sourceDomain: number;
  onStatus?: (s: string) => void;
}

// Submits receive_message on Starknet's MessageTransmitterV2 → mints the bridged
// USDC to `recipient`. Manager-submitted (gas) + tracked to ACCEPTED_ON_L2 so the
// subsequent balance read sees the new USDC. Permissionless, so any sender works;
// the recipient is baked into the CCTP message.
export async function submitStarknetMint(args: SubmitStarknetMintArgs): Promise<void> {
  const { provider, account, message, attestation, recipient, sourceDomain, onStatus } = args;

  // FUND-SAFETY GATE (Fix 2 / Bundle A1, full symmetry with the fund-account leg): validate
  // the attested message BEFORE replaying it into receive_message. Iris is a
  // TRUSTED oblivious service (threat-model.md); a tampered / MITM'd attestation
  // could redirect the mint to an attacker felt or a different destination chain.
  // Assert the EVM SOURCE domain, the Starknet destination domain, and the FULL
  // 32-byte mintRecipient field == the recipient (the SAME bytes32 conversion
  // depositForBurn used). A mismatch throws a TERMINAL error (classified by
  // isTransientError via `recipient/domain mismatch`) so it won't resume-loop.
  assertCctpMessageMatches(message, {
    expectedSourceDomain: sourceDomain,
    expectedDestinationDomain: config.cctp.starknetDomain,
    expectedRecipient: snAddressToBytes32(recipient),
  });

  const call: Call = buildReceiveMessageCall(config, message, attestation);
  onStatus?.('Minting USDC on Starknet…');
  // The sponsored deploy uses the same native executePaymasterTransaction path
  // (deploy.ts), proven on mainnet.
  const submit = buildPermissionlessSubmit(provider, account, call);
  await submitAndTrack(provider, submit, {
    until: 'ACCEPTED_ON_L2',
    onStatus: ({ finality }) => onStatus?.(`Minting USDC on Starknet (${finality})…`),
  });
}
