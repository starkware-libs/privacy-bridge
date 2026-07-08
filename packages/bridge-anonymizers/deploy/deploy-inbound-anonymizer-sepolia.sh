#!/usr/bin/env bash
# Declare + deploy the InboundAnonymizer to Starknet SEPOLIA (testnet).
# Shared declare/deploy logic lives in deploy-common.sh.
#
# The InboundAnonymizer is the CCTP→pool RETURN-leg contract (privacy-compute).
# Constructor: (usdc, message_transmitter, pool) — 3 felts. NOTE it takes the CCTP
# MessageTransmitterV2 (its receive_and_bind wraps receive_message), NOT the
# TokenMessengerMinter that the OutboundAnonymizer uses.
#
# SECRET HYGIENE: NO keys / RPC hosts / pool addresses hardcoded. All from env / a
# pre-imported sncast account. Safe to commit. Never hardcode a key or cluster URL.
#
# Prerequisites:
#   1. Build from inside this worktree (asdf pins scarb 2.19.1):
#        (cd "$(git rev-parse --show-toplevel)/packages/bridge-anonymizers" && scarb build)
#   2. A funded SEPOLIA sncast account (pays declare+deploy STRK v3 fees).
#
# Required env vars:
#   STARKNET_RPC_URL   Sepolia Starknet RPC (v0_10+).
#   SNCAST_ACCOUNT     Name of the imported sncast account (e.g. aviv).
#   POOL_ADDRESS       starknet-privacy SEPOLIA pool address (constructor arg).
# Optional:
#   DRY_RUN=1          Print the calldata and exit without sending tx.
set -euo pipefail

# Constructor constants (PUBLIC — SN Sepolia, from bridge-core config.ts).
# usdc: native Circle USDC; message_transmitter: CCTP MessageTransmitterV2 that
# receive_and_bind calls.
USDC="0x0512feAc6339Ff7889822cb5aA2a86C848e9D392bB0E3E237C008674feeD8343"
MESSAGE_TRANSMITTER="0x04db7926C64f1f32a840F3Fa95cB551f3801a3600Bae87aF87807A54DCE12Fe8"

: "${STARKNET_RPC_URL:?set STARKNET_RPC_URL (sepolia RPC)}"
: "${SNCAST_ACCOUNT:?set SNCAST_ACCOUNT (imported sncast account)}"
: "${POOL_ADDRESS:?set POOL_ADDRESS (starknet-privacy sepolia pool)}"

# Constructor arg order (inbound_anonymizer.cairo): usdc, message_transmitter, pool.
CALLDATA=("$USDC" "$MESSAGE_TRANSMITTER" "$POOL_ADDRESS")

echo "InboundAnonymizer sepolia deploy"
echo "  pool                = $POOL_ADDRESS"
echo "  usdc                = $USDC"
echo "  message_transmitter = $MESSAGE_TRANSMITTER"
echo "  constructor calldata: ${CALLDATA[*]}"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "DRY_RUN=1 — not sending. Sanity-check the values above, then re-run without DRY_RUN."
  exit 0
fi

source "$(dirname "${BASH_SOURCE[0]}")/deploy-common.sh"
declare_and_deploy InboundAnonymizer "${CALLDATA[@]}"

echo "Done. Set INBOUND_ANONYMIZER_ADDRESS (testnet) to the deployed address printed above."
