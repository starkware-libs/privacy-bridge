// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Starknet-native exits from the pool, both in ONE proven `apply_actions` — no CCTP,
// no attestation wait, no forwarding fee:
//
//   withdrawToStarknet    — pool note → USDC at any Starknet address. The recipient and
//                           amount are public in the pool's withdraw event.
//   sendPrivateToStarknet — pool note → a note owned by another pool identity. The value
//                           never leaves the pool; only the recipient can spend it.
//
// Both are atomic: the action either lands or it doesn't, so neither persists a resume
// cursor (unlike the CCTP paths, where a burn can commit while the mint has not).
//
// In-memory only — never log/persist the signature, the Starknet private key, or the
// viewing key.

import { validateAndParseAddress } from 'starknet';
import {
  deriveStarknetAccount,
  deriveStarknetPrivateKey,
  deriveViewingKey,
} from '../derivation/index';
import { config } from './config';
import { getRpcProvider, makeAccount } from './provider';
import { fetchPoolFeeAmount, approvePoolFee } from './poolFee';
import { discoverPrivateBalance, formatUsdcCents } from './discover';
import { readPoolRegistration } from './register';
import { makePoolTransfers } from './poolClient';
import { proveAndSubmitPoolAction, type ProvenPoolActionPhase } from './provenPoolAction';

export interface StarknetPayoutArgs {
  // Lazy provider of the raw wallet signature (in-memory only). Called once, after the
  // recipient has passed every check that doesn't need it, so a doomed payout never
  // raises a wallet prompt. Never logged or persisted.
  resolveSignature: () => Promise<string>;
  // Amount in deposit-token base units (1 USDC = 1e6).
  amount: bigint;
  // Destination Starknet address. For a private send this must be an address already
  // registered with the pool.
  recipient: string;
  onStatus?: (s: string) => void;
  // Step-tracker feed: fires (step,'running') as each phase begins and (step,'done')
  // as it completes. 'submit' only reports done once the tx is tracked.
  onStep?: (step: StarknetPayoutStep, status: StarknetPayoutStepStatus, detail?: string) => void;
}

// The stages a UI renders for a Starknet payout. There is no attest or mint leg — the
// pool pays the recipient in the SAME transaction — so the proof and its submission are
// the only phases worth showing.
export type StarknetPayoutStep = ProvenPoolActionPhase;
export type StarknetPayoutStepStatus = 'running' | 'done';

export interface StarknetPayoutResult {
  // Starknet tx hash of the proven apply_actions.
  txHash: string;
  // The recipient, normalized to a padded 0x-prefixed felt.
  recipient: string;
  amount: bigint;
  // True when the tx was tracked to ACCEPTED_ON_L2. False means it was submitted but
  // tracking timed out: the hash is real and the action is almost certainly landing,
  // but nothing has witnessed it yet — so a caller must not announce it as done.
  confirmed: boolean;
}

// What the error message promises, enforced. `validateAndParseAddress` accepts a bare
// numeral and reinterprets it as hex — so the DECIMAL felt that Starkscan, Voyager and
// the pool SDK's own bigint APIs display would be silently accepted as a completely
// different address, and the withdrawal would land somewhere nobody controls.
const STARKNET_ADDRESS_RE = /^0x[0-9a-fA-F]{1,64}$/;

// Normalize a user-entered Starknet address, or throw a message fit to show them. The
// pool withdraw is irreversible, so this runs BEFORE any signing or proving.
//
// Format only. It cannot tell a Starknet address from a 20-byte EVM address, which is a
// perfectly well-formed felt — that one is caught by the deployment check in
// `assertRecipientReachable`.
export function normalizeStarknetRecipient(recipient: string): string {
  const trimmed = recipient.trim();
  if (!trimmed) throw new Error('Enter a Starknet address.');
  if (!STARKNET_ADDRESS_RE.test(trimmed)) {
    throw new Error('Enter a valid Starknet address (0x followed by up to 64 hex characters).');
  }
  let normalized: string;
  try {
    // Pads to a full felt and range-checks against ADDR_BOUND.
    normalized = validateAndParseAddress(trimmed);
  } catch {
    throw new Error('Enter a valid Starknet address (0x followed by up to 64 hex characters).');
  }
  const value = BigInt(normalized);
  if (value === 0n) throw new Error('Enter a valid Starknet address — 0x0 cannot receive funds.');
  // The protocol's own contracts: funds sent there are stranded, and the pool has no
  // notion of paying itself.
  const reserved = [config.poolAddress, config.anonymizerAddress, config.inboundAnonymizerAddress];
  if (reserved.some((address) => Boolean(address) && BigInt(address) === value)) {
    throw new Error('That address belongs to the protocol and cannot receive a withdrawal.');
  }
  return normalized;
}

// Is anything deployed at `address`? 'unknown' means the read itself failed — a flaky
// node must not be reported as an unreachable recipient (and must not wave one through).
export type RecipientDeployment = 'deployed' | 'undeployed' | 'unknown';

// Starknet RPC's "there is no contract at this address" error. Anything else is a
// failure to look, not an answer.
const CONTRACT_NOT_FOUND_RE = /contract not found|20:\s*contract not found/i;

export async function readRecipientDeployment(address: string): Promise<RecipientDeployment> {
  try {
    const classHash = await getRpcProvider().getClassHashAt(address);
    return classHash && BigInt(classHash) !== 0n ? 'deployed' : 'undeployed';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return CONTRACT_NOT_FOUND_RE.test(message) ? 'undeployed' : 'unknown';
  }
}

// A public withdrawal is a plain ERC-20 transfer, so ANY felt in range accepts it —
// including a 20-byte EVM address, which is exactly what a user pastes when they have
// two wallets open. Nothing on-chain will reject it and the funds are gone, so refuse
// an address with no account deployed at it. Fails CLOSED on an unreadable answer: a
// retryable message costs a user seconds, a wrong one costs them the withdrawal.
async function assertRecipientReachable(recipient: string): Promise<void> {
  const deployment = await readRecipientDeployment(recipient);
  if (deployment === 'deployed') return;
  if (deployment === 'unknown') {
    throw new Error("Couldn't check that Starknet address — try again.");
  }
  throw new Error(
    'No account is deployed at that Starknet address, so funds sent there would be ' +
      'unrecoverable. Check the address — an EVM (0x… 40-character) address is not a ' +
      'Starknet one.',
  );
}

type PayoutKind = 'withdraw' | 'transfer';

// Shared body: validate → (private only) confirm the recipient is on the pool → recover
// keys → cover the pool fee → prove + submit one apply_actions.
async function runStarknetPayout(
  kind: PayoutKind,
  args: StarknetPayoutArgs,
): Promise<StarknetPayoutResult> {
  const { resolveSignature, amount, onStatus, onStep } = args;
  const recipient = normalizeStarknetRecipient(args.recipient);
  if (amount <= 0n) throw new Error('Enter an amount greater than zero.');

  // Everything that can refuse this payout without the signature runs FIRST, so a
  // doomed one never raises a wallet prompt.
  onStatus?.('Checking the recipient…');
  if (kind === 'transfer') {
    // A private send re-creates the note against the recipient's channel, which only
    // exists once they have registered a viewing key with the pool. An UNREADABLE
    // answer is reported as such — blaming the recipient for our own RPC failure would
    // send the user chasing a problem that isn't theirs.
    const registration = await readPoolRegistration(recipient);
    if (registration === 'unregistered') {
      throw new Error(
        'That address is not on the privacy pool yet, so it cannot receive a private transfer. ' +
          'Ask them to join the pool first, or withdraw to it publicly instead.',
      );
    }
    if (registration === 'unknown') {
      throw new Error("Couldn't check whether that address is on the privacy pool — try again.");
    }
  } else {
    // Registration implies an account, so this is the public path's equivalent gate.
    await assertRecipientReachable(recipient);
  }

  const provider = getRpcProvider();
  // The pool fee read is independent of the signature, so start it before the wallet
  // prompt and collect it after — a round trip hidden behind a step that takes seconds.
  // Skipped entirely under the AVNU paymaster, where the fee rides in the proof and
  // approvePoolFee is a no-op (mirrors register.ts).
  const feeAmountPromise = config.paymaster ? undefined : fetchPoolFeeAmount();
  onStatus?.('Recovering keys…');
  const signature = await resolveSignature();
  const snPrivateKey = deriveStarknetPrivateKey(signature);
  const viewingKey = deriveViewingKey(signature);
  const { address: snAddress } = deriveStarknetAccount(snPrivateKey, config.ozClassHash);
  const account = makeAccount(snAddress, snPrivateKey, provider);

  // Sending privately to yourself re-creates the note you already own, minus the pool
  // fee. Withdrawing to your own account is a different matter — un-shielding to an
  // address you control is a legitimate exit (it does link that exit to you, which is
  // the caller's warning to give), so only the private path refuses here.
  if (kind === 'transfer' && BigInt(recipient) === BigInt(snAddress)) {
    throw new Error('That is your own account — a private transfer to yourself does nothing.');
  }

  const transfers = makePoolTransfers(account, viewingKey);

  // Refuse an unaffordable amount BEFORE the manager spends gas approving a fee for a
  // payout that can only fail at proof-build (mirrors bridgeOut's pre-flight).
  const [feeAmount, poolBalance] = await Promise.all([
    feeAmountPromise ?? Promise.resolve(0n),
    discoverPrivateBalance({ account, viewingKey }),
  ]);
  if (poolBalance < amount) {
    throw new Error(
      `Your private balance is ${formatUsdcCents(poolBalance, config.depositToken.decimals)} ` +
        `${config.depositToken.symbol} — not enough for this ${
          kind === 'transfer' ? 'transfer' : 'withdrawal'
        }.`,
    );
  }

  // STRK protocol fee: the MANAGER approves it up front (manager-paid submit).
  let lastTxBlockNumber: number | undefined;
  if (feeAmount > 0n) {
    onStatus?.('Approving pool fee…');
    lastTxBlockNumber = await approvePoolFee(feeAmount);
  }

  const { txHash, confirmed } = await proveAndSubmitPoolAction({
    transfers,
    account,
    provider,
    viewingKey,
    lastTxBlockNumber,
    onStatus,
    // 'prove' completes when 'submit' begins; 'submit' completes below, once the tx is
    // tracked — never on submission alone.
    onPhase: (phase) => {
      if (phase === 'submit') onStep?.('prove', 'done');
      onStep?.(phase, 'running');
    },
    label: kind === 'withdraw' ? 'withdrawal' : 'private transfer',
    // No InvokeExternal: the pool pays the recipient directly. Note selection and the
    // change note are handled by autoSelectNotes + surplusTo; a first-time private
    // recipient gets their channel opened by autoSetup.
    tokenOps: (t) => {
      if (kind === 'withdraw') t.withdraw({ recipient, amount });
      else t.transfer({ recipient, amount });
    },
  });

  if (confirmed) onStep?.('submit', 'done');
  return { txHash, recipient, amount, confirmed };
}

// Withdraw from the pool to a Starknet address. The USDC lands as a plain token
// transfer; the recipient and amount are public in the pool's withdraw event.
export async function withdrawToStarknet(args: StarknetPayoutArgs): Promise<StarknetPayoutResult> {
  return runStarknetPayout('withdraw', args);
}

// Send part of the private balance to another pool identity. The value stays inside the
// pool as a note only the recipient can spend.
export async function sendPrivateToStarknet(
  args: StarknetPayoutArgs,
): Promise<StarknetPayoutResult> {
  return runStarknetPayout('transfer', args);
}
