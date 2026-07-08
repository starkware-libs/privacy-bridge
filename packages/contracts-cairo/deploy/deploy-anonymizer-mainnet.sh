#!/usr/bin/env bash
# Declare + deploy the Anonymizer to Starknet MAINNET.
#
# SECRET HYGIENE: this script contains NO keys, RPC hosts, or pool addresses.
# All of those come from the environment / a pre-imported sncast account, so the
# script is safe to commit. NEVER hardcode a private key or a cluster URL here.
#
# Prerequisites (run once, outside git):
#   1. Build the contract from inside this worktree (asdf pins scarb 2.17.0;
#      SN mainnet requires Sierra 1.8.0 — 2.12.2 emits 1.7.0 and is rejected):
#        (cd "$(git rev-parse --show-toplevel)/packages/contracts-cairo" && scarb build)
#   2. Import the funded MAINNET manager account into sncast (key stays local):
#        sncast account import \
#          --name "$SNCAST_ACCOUNT" --address <MANAGER_ADDR> \
#          --private-key <MANAGER_KEY> --type <oz|argent|braavos> \
#          --url "$STARKNET_RPC_URL"
#      The manager pays declare+deploy fees in STRK (v3) — fund it first.
#
# Required env vars:
#   STARKNET_RPC_URL      Mainnet Starknet RPC (use a PRIVATE RPC — LOW-1).
#   SNCAST_ACCOUNT        Name of the imported sncast manager account.
#   POOL_ADDRESS          starknet-privacy MAINNET pool address (constructor arg).
# Optional:
#   DRY_RUN=1             Print the calldata and exit without sending tx.
set -euo pipefail

# --- Constructor constants (PUBLIC — verified this session) ---------------------
# usdc:            native Circle USDC on SN mainnet (on-chain symbol()=USDC)
# token_messenger: CCTP TokenMessengerMinterV2 (Circle docs, domain 25)
# The outbound Anonymizer is now BUY-only: the RETURN-leg claim (old H scheme /
# sn_domain / *_tag) moved to InboundAnonymizer (privacy-compute), so the
# constructor is just 3 felts. The CCTP DESTINATION domain is a per-tx
# BuyParams.dest_domain, not a constructor arg (bridge-plan.md §3).
USDC="0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb"
TOKEN_MESSENGER="0x07d421B9cA8aA32DF259965cDA8ACb93F7599F69209A41872AE84638B2A20F2a"

: "${STARKNET_RPC_URL:?set STARKNET_RPC_URL (private mainnet RPC)}"
: "${SNCAST_ACCOUNT:?set SNCAST_ACCOUNT (imported sncast manager account)}"
: "${POOL_ADDRESS:?set POOL_ADDRESS (starknet-privacy mainnet pool)}"

# Constructor arg order (lib.cairo): usdc, token_messenger, pool — 3 felts.
CALLDATA=("$USDC" "$TOKEN_MESSENGER" "$POOL_ADDRESS")

echo "Anonymizer mainnet deploy"
echo "  pool            = $POOL_ADDRESS"
echo "  usdc            = $USDC"
echo "  token_messenger = $TOKEN_MESSENGER"
echo "  constructor calldata: ${CALLDATA[*]}"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "DRY_RUN=1 — not sending. Sanity-check the values above, then re-run without DRY_RUN."
  exit 0
fi

# --- 1. Declare (idempotent: tolerate an already-declared class) ----------------
echo "==> declaring Anonymizer class..."
set +e
DECLARE_OUT=$(sncast --account "$SNCAST_ACCOUNT" declare \
  --url "$STARKNET_RPC_URL" --contract-name Anonymizer 2>&1)
DECLARE_RC=$?
set -e
echo "$DECLARE_OUT"
CLASS_HASH=$(echo "$DECLARE_OUT" | grep -oiE '0x[0-9a-f]{60,64}' | head -1)
if [[ $DECLARE_RC -ne 0 ]]; then
  if echo "$DECLARE_OUT" | grep -qi "already declared"; then
    echo "(class already declared — continuing to deploy)"
    CLASS_HASH=$(echo "$DECLARE_OUT" | grep -oiE '0x[0-9a-f]{60,64}' | head -1)
  else
    echo "declare failed (rc=$DECLARE_RC) — aborting before deploy."; exit $DECLARE_RC
  fi
fi
: "${CLASS_HASH:?could not parse class hash from declare output}"
echo "class_hash = $CLASS_HASH"

# --- 1b. Wait for the declare tx to be ACCEPTED_ON_L2 ---------------------------
# Without this the deploy races the still-pending declare and fails with
# "Class with hash ... is not declared". Skip the wait if the class was already
# declared (no fresh declare tx in that case).
# sncast prints "Transaction Hash: 0x..." (0.59). Match space OR underscore, and
# `|| true` so pipefail on a no-match (already-declared class) is not fatal.
DECLARE_TX=$(echo "$DECLARE_OUT" | grep -oiE 'transaction[_ ]hash:?[[:space:]]*0x[0-9a-f]{1,64}' | grep -oiE '0x[0-9a-f]{1,64}' | head -1 || true)
if [[ -n "$DECLARE_TX" ]]; then
  echo "==> waiting for declare tx $DECLARE_TX to be ACCEPTED_ON_L2..."
  DEADLINE=$(( $(date +%s) + 600 ))   # 10 min budget
  while :; do
    set +e
    STATUS_OUT=$(sncast tx-status "$DECLARE_TX" --url "$STARKNET_RPC_URL" 2>&1)
    set -e
    if echo "$STATUS_OUT" | grep -qiE 'rejected|reverted'; then
      echo "$STATUS_OUT"
      echo "declare tx rejected/reverted — aborting before deploy."; exit 1
    fi
    if echo "$STATUS_OUT" | grep -qi 'accepted_on_l2\|accepted_on_l1'; then
      echo "declare tx accepted."
      break
    fi
    if [[ $(date +%s) -ge $DEADLINE ]]; then
      echo "$STATUS_OUT"
      echo "timed out waiting for declare tx acceptance — aborting before deploy."; exit 1
    fi
    sleep 10
  done
else
  echo "(no fresh declare tx — class was already declared; proceeding to deploy)"
fi

# --- 2. Deploy with constructor calldata ----------------------------------------
echo "==> deploying Anonymizer..."
sncast --account "$SNCAST_ACCOUNT" deploy \
  --url "$STARKNET_RPC_URL" \
  --class-hash "$CLASS_HASH" \
  --constructor-calldata "${CALLDATA[@]}"

echo "Done. Set VITE_ANONYMIZER_ADDRESS to the deployed address printed above."
