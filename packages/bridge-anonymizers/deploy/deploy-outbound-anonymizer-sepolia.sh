#!/usr/bin/env bash
# Declare + deploy the OutboundAnonymizer to Starknet SEPOLIA (testnet).
# Shared declare/deploy logic lives in deploy-common.sh.
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

# Constructor constants (PUBLIC — SN Sepolia, from bridge-core config.ts).
# usdc: native Circle USDC; token_messenger: CCTP TokenMessengerMinterV2. The CCTP
# destination domain is a per-tx BuyParams.destination_domain, not a constructor arg.
USDC="0x0512feAc6339Ff7889822cb5aA2a86C848e9D392bB0E3E237C008674feeD8343"
TOKEN_MESSENGER="0x04bDdE1E09a4B09a2F95d893D94a967b7717eB85A3f6dEcA8c080Ee01fBc3370"

: "${STARKNET_RPC_URL:?set STARKNET_RPC_URL (sepolia RPC)}"
: "${SNCAST_ACCOUNT:?set SNCAST_ACCOUNT (imported sncast account)}"
: "${POOL_ADDRESS:?set POOL_ADDRESS (starknet-privacy sepolia pool)}"

# Constructor arg order (outbound_anonymizer.cairo): usdc, token_messenger, pool.
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

source "$(dirname "${BASH_SOURCE[0]}")/deploy-common.sh"
declare_and_deploy OutboundAnonymizer "${CALLDATA[@]}"

echo "Done. Set VITE_ANONYMIZER_ADDRESS (testnet) to the deployed address printed above."
