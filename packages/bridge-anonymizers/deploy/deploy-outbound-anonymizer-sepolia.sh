#!/usr/bin/env bash
# Declare + deploy the OutboundAnonymizer to Starknet SEPOLIA (testnet).
#
# SECRET HYGIENE: this script contains NO keys, RPC hosts, or pool addresses.
# All of those come from the environment / a pre-imported sncast account, so the
# script is safe to commit. NEVER hardcode a private key or a cluster URL here.
#
# Prerequisites (run once, outside git):
#   1. Build the contract from inside this worktree (asdf pins scarb 2.19.1):
#        (cd "$(git rev-parse --show-toplevel)/packages/bridge-anonymizers" && scarb build)
#   2. Import a funded SEPOLIA account into sncast (key stays local):
#        sncast account import --name "$SNCAST_ACCOUNT" --address <ADDR> \
#          --private-key <KEY> --type <oz|argent|braavos> --url "$STARKNET_RPC_URL"
#      The account pays declare+deploy fees in STRK (v3) — fund it first.
#
# Required env vars:
#   STARKNET_RPC_URL   Sepolia Starknet RPC (v0_10+).
#   SNCAST_ACCOUNT     Name of the imported sncast account (e.g. aviv).
#   POOL_ADDRESS       starknet-privacy SEPOLIA pool address (constructor arg).
# Optional:
#   DRY_RUN=1          Print the calldata and exit without sending tx.
set -euo pipefail

# --- Constructor constants (PUBLIC — SN Sepolia, from bridge-core config.ts) ----
# usdc:            native Circle USDC on SN Sepolia (config depositToken testnet)
# token_messenger: CCTP TokenMessengerMinterV2 on SN Sepolia (config cctp testnet)
# Constructor: 3 felts. The CCTP destination domain is a per-tx
# BuyParams.destination_domain, not a constructor arg.
USDC="0x0512feAc6339Ff7889822cb5aA2a86C848e9D392bB0E3E237C008674feeD8343"
TOKEN_MESSENGER="0x04bDdE1E09a4B09a2F95d893D94a967b7717eB85A3f6dEcA8c080Ee01fBc3370"

: "${STARKNET_RPC_URL:?set STARKNET_RPC_URL (sepolia RPC)}"
: "${SNCAST_ACCOUNT:?set SNCAST_ACCOUNT (imported sncast account)}"
: "${POOL_ADDRESS:?set POOL_ADDRESS (starknet-privacy sepolia pool)}"

# Constructor arg order (outbound_anonymizer.cairo): usdc, token_messenger, pool — 3 felts.
CALLDATA=("$USDC" "$TOKEN_MESSENGER" "$POOL_ADDRESS")

echo "OutboundAnonymizer sepolia deploy"
echo "  pool            = $POOL_ADDRESS"
echo "  usdc            = $USDC"
echo "  token_messenger = $TOKEN_MESSENGER"
echo "  constructor calldata: ${CALLDATA[*]}"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "DRY_RUN=1 — not sending. Sanity-check the values above, then re-run without DRY_RUN."
  exit 0
fi

# --- 1. Declare (idempotent: tolerate an already-declared class) ----------------
echo "==> declaring OutboundAnonymizer class..."
set +e
DECLARE_OUT=$(sncast --account "$SNCAST_ACCOUNT" declare \
  --url "$STARKNET_RPC_URL" --contract-name OutboundAnonymizer 2>&1)
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
echo "==> deploying OutboundAnonymizer..."
sncast --account "$SNCAST_ACCOUNT" deploy \
  --url "$STARKNET_RPC_URL" \
  --class-hash "$CLASS_HASH" \
  --constructor-calldata "${CALLDATA[@]}"

echo "Done. Set VITE_ANONYMIZER_ADDRESS (testnet) to the deployed address printed above."
