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

import type { constants } from 'starknet';
import { validateAndParseAddress } from 'starknet';
import {
  createPrivateTransfers,
  IndexerDiscoveryProvider,
} from '@starkware-libs/starknet-privacy-sdk';
import {
  deriveStarknetAccount,
  deriveStarknetPrivateKey,
  deriveViewingKey,
} from '../derivation/index';
import { config } from './config';
import { getRpcProvider, makeAccount } from './provider';
import { fetchPoolFeeAmount, approvePoolFee } from './poolFee';
import { readPoolRegistration } from './register';
import { proveAndSubmitPoolAction } from './provenPoolAction';

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
}

export interface StarknetPayoutResult {
  // Starknet tx hash of the proven apply_actions.
  txHash: string;
  // The recipient, normalized to a padded 0x-prefixed felt.
  recipient: string;
  amount: bigint;
}

// Addresses that can never be a payout recipient: 0 (unspendable), and the protocol's
// own contracts (funds sent there are stranded, and the pool's withdraw path has no
// notion of paying itself).
function reservedRecipients(): string[] {
  return [config.poolAddress, config.anonymizerAddress, config.inboundAnonymizerAddress].filter(
    (address): address is string => Boolean(address),
  );
}

// Normalize a user-entered Starknet address, or throw a message fit to show them. The
// pool withdraw is irreversible, so this runs BEFORE any signing or proving.
export function normalizeStarknetRecipient(recipient: string): string {
  const trimmed = recipient.trim();
  if (!trimmed) throw new Error('Enter a Starknet address.');
  let normalized: string;
  try {
    normalized = validateAndParseAddress(trimmed);
  } catch {
    throw new Error('Enter a valid Starknet address (0x followed by up to 64 hex characters).');
  }
  const value = BigInt(normalized);
  if (value === 0n) throw new Error('Enter a valid Starknet address — 0x0 cannot receive funds.');
  if (reservedRecipients().some((address) => BigInt(address) === value)) {
    throw new Error('That address belongs to the protocol and cannot receive a withdrawal.');
  }
  return normalized;
}

type PayoutKind = 'withdraw' | 'transfer';

// Shared body: validate → (private only) confirm the recipient is on the pool → recover
// keys → cover the pool fee → prove + submit one apply_actions.
async function runStarknetPayout(
  kind: PayoutKind,
  args: StarknetPayoutArgs,
): Promise<StarknetPayoutResult> {
  const { resolveSignature, amount, onStatus } = args;
  const recipient = normalizeStarknetRecipient(args.recipient);
  if (amount <= 0n) throw new Error('Enter an amount greater than zero.');

  // A private send re-creates the note against the recipient's channel, which only
  // exists once they have registered a viewing key with the pool. Checked before the
  // signature so an unregistered recipient costs no wallet prompt. An UNREADABLE answer
  // is reported as such — blaming the recipient for our own RPC failure would send the
  // user chasing a problem that isn't theirs.
  if (kind === 'transfer') {
    onStatus?.('Checking the recipient…');
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
  }

  const provider = getRpcProvider();
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

  // STRK protocol fee: the MANAGER approves it up front (manager-paid submit). A no-op
  // under the AVNU paymaster, where the fee is baked into the proof instead.
  onStatus?.('Checking pool fee…');
  const feeAmount = await fetchPoolFeeAmount();
  let lastTxBlockNumber: number | undefined;
  if (feeAmount > 0n) {
    onStatus?.('Approving pool fee…');
    lastTxBlockNumber = await approvePoolFee(feeAmount);
  }

  const discoveryProvider = new IndexerDiscoveryProvider(config.indexerUrl, config.poolAddress);
  const transfers = createPrivateTransfers({
    account,
    viewingKeyProvider: { getViewingKey: async () => viewingKey },
    provingProvider: {
      url: config.proverUrl,
      chainId: config.chainId as constants.StarknetChainId,
    },
    discoveryProvider,
    poolContractAddress: config.poolAddress,
  });

  const txHash = await proveAndSubmitPoolAction({
    transfers,
    account,
    provider,
    viewingKey,
    lastTxBlockNumber,
    onStatus,
    label: kind === 'withdraw' ? 'withdrawal' : 'private transfer',
    // No InvokeExternal: the pool pays the recipient directly. Note selection and the
    // change note are handled by autoSelectNotes + surplusTo; a first-time private
    // recipient gets their channel opened by autoSetup.
    tokenOps: (t) => {
      if (kind === 'withdraw') t.withdraw({ recipient, amount });
      else t.transfer({ recipient, amount });
    },
  });

  return { txHash, recipient, amount };
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
