#!/usr/bin/env bash
# Declare + deploy the OutboundAnonymizer to Starknet MAINNET.
# Shared declare/deploy logic lives in deploy-common.sh.
#
# SECRET HYGIENE: this script contains NO keys, RPC hosts, or pool addresses.
# All of those come from the environment / a pre-imported sncast account, so the
# script is safe to commit. NEVER hardcode a private key or a cluster URL here.
#
# Prerequisites (run once, outside git):
#   1. Build the contract from inside this worktree (asdf pins scarb 2.19.1):
#        (cd "$(git rev-parse --show-toplevel)/packages/bridge-anonymizers" && scarb build)
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

# Constructor constants (PUBLIC — SN mainnet).
# usdc: native Circle USDC (on-chain symbol()=USDC); token_messenger: CCTP
# TokenMessengerMinterV2 (domain 25). The CCTP destination domain is a per-tx
# BuyParams.destination_domain, not a constructor arg.
USDC="0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb"
TOKEN_MESSENGER="0x07d421B9cA8aA32DF259965cDA8ACb93F7599F69209A41872AE84638B2A20F2a"

: "${STARKNET_RPC_URL:?set STARKNET_RPC_URL (private mainnet RPC)}"
: "${SNCAST_ACCOUNT:?set SNCAST_ACCOUNT (imported sncast manager account)}"
: "${POOL_ADDRESS:?set POOL_ADDRESS (starknet-privacy mainnet pool)}"

# Constructor arg order (outbound_anonymizer.cairo): usdc, token_messenger, pool.
CALLDATA=("$USDC" "$TOKEN_MESSENGER" "$POOL_ADDRESS")

echo "OutboundAnonymizer mainnet deploy"
echo "  pool            = $POOL_ADDRESS"
echo "  usdc            = $USDC"
echo "  token_messenger = $TOKEN_MESSENGER"
echo "  constructor calldata: ${CALLDATA[*]}"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "DRY_RUN=1 — not sending. Sanity-check the values above, then re-run without DRY_RUN."
  exit 0
fi

source "$(dirname "${BASH_SOURCE[0]}")/deploy-common.sh"
declare_and_deploy OutboundAnonymizer "${CALLDATA[@]}"

echo "Done. Set VITE_ANONYMIZER_ADDRESS to the deployed address printed above."
