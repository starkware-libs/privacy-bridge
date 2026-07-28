#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 StarkWare Industries Ltd.

# Shared declare + deploy helper for the anonymizer contracts, sourced by the
# per-network deploy scripts. Each caller sets the constructor constants and calls
# `declare_and_deploy <ContractName> <calldata...>`.
#
# SECRET HYGIENE: no keys / RPC hosts / addresses here — all from env / a
# pre-imported sncast account. Requires: STARKNET_RPC_URL, SNCAST_ACCOUNT (the
# account pays declare+deploy STRK v3 fees). The caller handles DRY_RUN.

# Declare the class (idempotent), wait for it to be ACCEPTED_ON_L2, then deploy.
declare_and_deploy() {
  local contract_name="$1"; shift
  local calldata=("$@")

  echo "==> declaring ${contract_name} class..."
  set +e
  local declare_out; declare_out=$(sncast --account "$SNCAST_ACCOUNT" declare \
    --url "$STARKNET_RPC_URL" --contract-name "$contract_name" 2>&1)
  local declare_rc=$?
  set -e
  echo "$declare_out"
  local class_hash; class_hash=$(echo "$declare_out" | grep -oiE '0x[0-9a-f]{60,64}' | head -1)
  if [[ $declare_rc -ne 0 ]]; then
    if echo "$declare_out" | grep -qi "already declared"; then
      echo "(class already declared — continuing to deploy)"
    else
      echo "declare failed (rc=$declare_rc) — aborting before deploy."; exit $declare_rc
    fi
  fi
  : "${class_hash:?could not parse class hash from declare output}"
  echo "class_hash = $class_hash"

  # Wait for the declare tx to be accepted before deploying (skip if the class was
  # already declared — no fresh tx then). sncast prints "Transaction Hash: 0x...";
  # `|| true` keeps pipefail from firing on a no-match.
  local declare_tx
  declare_tx=$(echo "$declare_out" | grep -oiE 'transaction[_ ]hash:?[[:space:]]*0x[0-9a-f]{1,64}' | grep -oiE '0x[0-9a-f]{1,64}' | head -1 || true)
  if [[ -n "$declare_tx" ]]; then
    echo "==> waiting for declare tx $declare_tx to be ACCEPTED_ON_L2..."
    local deadline=$(( $(date +%s) + 600 ))   # 10 min budget
    while :; do
      set +e
      local status_out; status_out=$(sncast tx-status "$declare_tx" --url "$STARKNET_RPC_URL" 2>&1)
      set -e
      if echo "$status_out" | grep -qiE 'rejected|reverted'; then
        echo "$status_out"; echo "declare tx rejected/reverted — aborting before deploy."; exit 1
      fi
      if echo "$status_out" | grep -qi 'accepted_on_l2\|accepted_on_l1'; then
        echo "declare tx accepted."; break
      fi
      if [[ $(date +%s) -ge $deadline ]]; then
        echo "$status_out"; echo "timed out waiting for declare tx acceptance — aborting."; exit 1
      fi
      sleep 10
    done
  else
    echo "(no fresh declare tx — class already declared; proceeding to deploy)"
  fi

  echo "==> deploying ${contract_name}..."
  sncast --account "$SNCAST_ACCOUNT" deploy \
    --url "$STARKNET_RPC_URL" \
    --class-hash "$class_hash" \
    --constructor-calldata "${calldata[@]}"
}
