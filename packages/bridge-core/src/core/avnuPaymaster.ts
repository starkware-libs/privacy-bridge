// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// AVNU paymaster client — private-pool (apply_action) flow.
//
// Shapes are pinned to AVNU's LIVE deployed endpoint (sepolia/mainnet
// `*.paymaster.avnu.fi`), reverse-verified against the JSON-RPC schema validator on
// 2026-06-24. NOTE: the draft OpenRPC spec in avnu-labs/paymaster#67 does NOT match
// what is deployed (it names `paymaster_buildTypedData`/`paymaster_execute`,
// `version:'v1'`, and an `execute_from_outside` key — none of which the live server
// accepts). The deployed endpoint speaks the SNIP-29 standard method names with the
// private `apply_action` transaction types layered on.
//
// The proven pool legs are STARK-proven by the SDK; AVNU's relayer submits them
// (carrying the proof), so the derived account is never the on-chain sender and the
// shared manager leaves the value path (closes the Starknet-side P0 — docs/threat-model.md).
//
// Flow (two JSON-RPC methods, each taking { transaction, parameters }):
//   - paymaster_buildTransaction → for invoke_and_apply_action returns the SNIP-9
//       `typed_data` to sign; for both private types returns the `fee_action` the user
//       must satisfy. Does NOT submit.
//   - paymaster_executeTransaction → takes the proven apply_actions call +
//       proof/proof_facts (+ the signed invoke for invoke_and_apply_action) and
//       submits, returning { tracking_id, transaction_hash }.
//
// FEE NOTE: `fee_action` is "the fee payment the user must include as a Withdraw in
// the privacy SDK proof". Satisfying a NON-ZERO fee_action therefore requires baking
// a withdraw into the proof BEFORE proving — not yet wired (proven-submit.ts guards
// against a non-zero fee_action with a clear error). Zero-fee legs work as-is.

import type { Call } from 'starknet';
import { hash } from 'starknet';
import { parseJsonResponse } from '../lib/safe-json';

const METHOD_BUILD = 'paymaster_buildTransaction';
const METHOD_EXECUTE = 'paymaster_executeTransaction';

// Live CALL shape: { to, selector, calldata } (RPC FUNCTION_CALL) — NOT the
// starknet.js { contractAddress, entrypoint, calldata }.
export interface AvnuCall {
  to: string;
  selector: string;
  calldata: string[];
}

// Live fee modes: `sponsored` | `sponsored_private`(+pool_fee_token) | `default`(+gas_token).
export type AvnuFeeMode =
  | { mode: 'sponsored' }
  | { mode: 'sponsored_private'; pool_fee_token: string }
  | { mode: 'default'; gas_token: string };

export type AvnuTxType = 'apply_action' | 'invoke_and_apply_action';

// PAYMASTER_EXECUTION parameters — `version` is the felt string "0x1" (NOT "v1").
export interface AvnuExecutionParameters {
  version: '0x1';
  fee_mode: AvnuFeeMode;
}

// --- paymaster_buildTransaction ---

// Build transaction: apply_action carries only { pool_address }; the invoke part
// (present for invoke_and_apply_action) carries the user calls to be SNIP-9 signed.
export interface AvnuBuildTransaction {
  type: AvnuTxType;
  apply_action: { pool_address: string };
  invoke?: { user_address: string; calls: AvnuCall[] };
}

export interface AvnuBuildParams {
  transaction: AvnuBuildTransaction;
  parameters: AvnuExecutionParameters;
}

// FEE_ACTION — a withdraw the user must include in the proof to pay the pool fee.
export interface AvnuFeeAction {
  type: string;
  recipient: string;
  token: string;
  amount: string;
}

// Build response. `typed_data` present for invoke_and_apply_action (sign it);
// `fee_action` present for the private types (must be baked into the proof when non-zero).
export interface AvnuBuildResponse {
  type: string;
  typed_data?: unknown;
  parameters?: AvnuExecutionParameters;
  fee?: unknown;
  fee_action?: AvnuFeeAction;
}

// --- paymaster_executeTransaction ---

// Executable apply_action: the proven call + its proof. `pool_address` is required
// here too (not just at build time). `proof` is a single felt string; `proof_facts`
// is an array of felt strings.
export interface AvnuExecutableApplyAction {
  pool_address: string;
  apply_actions_call: AvnuCall;
  proof: string;
  proof_facts: string[];
}

// Executable invoke — the build-returned typed_data echoed back plus the SNIP-9
// signature. Keyed `invoke` on the executable transaction (NOT `execute_from_outside`).
export interface AvnuExecutableInvoke {
  user_address: string;
  typed_data: unknown;
  signature: string[];
}

export type AvnuExecutableTransaction =
  | { type: 'apply_action'; apply_action: AvnuExecutableApplyAction }
  | {
      type: 'invoke_and_apply_action';
      invoke: AvnuExecutableInvoke;
      apply_action: AvnuExecutableApplyAction;
    };

export interface AvnuExecuteParams {
  transaction: AvnuExecutableTransaction;
  parameters: AvnuExecutionParameters;
}

export interface AvnuExecuteResponse {
  tracking_id: string;
  transaction_hash: string;
}

export interface AvnuClientOpts {
  endpoint: string;
  // Sponsored / sponsored_private require the whitelisted key (`x-paymaster-api-key`);
  // the live server rejects with code 163 "x-paymaster-api-key is invalid" otherwise.
  apiKey?: string;
  fetchImpl?: typeof fetch;
  // #104: bounds the fetch so a stalled AVNU relayer can't wedge the deposit flow
  // forever (no cancel path beyond closing the tab). Defaults to DEFAULT_RPC_TIMEOUT_MS.
  timeoutMs?: number;
}

// Default fetch timeout for a paymaster JSON-RPC call (#104) — generous for a
// build/execute round-trip, but bounded so a stalled relayer surfaces a clear error
// instead of hanging indefinitely.
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

// Normalises a felt (string/number/bigint) to a 0x-prefixed hex string. AVNU's
// JSON-RPC REQUIRES 0x-hex felts in calldata; SDK / encoder calldata is often decimal,
// which the server rejects with "expected hex string to be prefixed by '0x'". Already-
// 0x values pass through unchanged.
export function toHexFelt(v: string | number | bigint): string {
  const s = typeof v === 'string' ? v.trim() : v.toString();
  if (s.startsWith('0x') || s.startsWith('0X')) return s;
  return `0x${BigInt(s).toString(16)}`;
}

// Converts a starknet.js Call to the live CALL shape. The proven call carries the
// entrypoint NAME; the wire wants the hashed selector (FELT). An already-0x entrypoint
// (a raw selector) passes through. Calldata is normalised to 0x-hex (AVNU rejects decimal).
export function toAvnuCall(call: Call): AvnuCall {
  const raw = call.calldata ?? [];
  const calldata = Array.isArray(raw) ? raw.map((c) => toHexFelt(c as string | number | bigint)) : [];
  const selector = call.entrypoint.startsWith('0x')
    ? call.entrypoint
    : hash.getSelectorFromName(call.entrypoint);
  return { to: call.contractAddress, selector, calldata };
}

// Decode a Cairo short-string felt (≤31 bytes of printable ASCII) — Starknet
// revert reasons (asserts/panics) ride as short-string felts (e.g.
// 'INSUFFICIENT_CLAIMABLE'). Returns the ASCII when it's a clean printable string,
// else undefined (addresses/hashes/selectors don't decode). 0-bytes are skipped.
export function decodeShortStringFelt(hex: string): string | undefined {
  let h = hex.replace(/^0x/i, '');
  if (h.length % 2 !== 0) h = `0${h}`;
  if (h.length === 0 || h.length > 62) return undefined; // > 31 bytes ⇒ not a short string
  let out = '';
  for (let i = 0; i < h.length; i += 2) {
    const code = Number.parseInt(h.slice(i, i + 2), 16);
    if (code === 0) {
      // Only LEADING zero bytes are padding. A 0x00 byte AFTER decoding has
      // started is an interior null — not a valid Cairo short-string byte —
      // so fail closed instead of skipping it (which would silently fabricate
      // a truncated/spliced string from a non-string felt).
      if (out.length === 0) continue;
      return undefined;
    }
    if (code < 0x20 || code > 0x7e) return undefined; // non-printable ⇒ not a string
    out += String.fromCharCode(code);
  }
  return out.length >= 3 ? out : undefined;
}

// Pull a human revert reason out of a JSON-RPC `error.data` (AVNU/Starknet stash the
// on-chain execution revert here, often a nested object the old code dropped). Reads
// a string directly, or a nested execution/revert field, else the stringified blob;
// then appends any decoded Cairo short-string felts so the assert that fired is
// READABLE (and, being ASCII, survives the downstream long-hex sanitizer). Capped so
// a giant trace blob doesn't swamp the message. Exported for testing.
export function extractRpcErrorDetail(data: unknown): string {
  if (data == null) return '';
  let raw: string;
  if (typeof data === 'string') {
    raw = data;
  } else if (typeof data === 'object') {
    const d = data as Record<string, unknown>;
    const nested =
      d.execution_error ?? d.revert_error ?? d.revertError ?? d.revert_reason ?? d.reason ?? d.error ?? d.message;
    if (typeof nested === 'string') {
      raw = nested;
    } else {
      try {
        raw = JSON.stringify(data);
      } catch {
        return '';
      }
    }
  } else {
    raw = String(data);
  }
  if (!raw) return '';
  const capped = raw.length > 800 ? `${raw.slice(0, 800)}…` : raw;
  const decoded = [...new Set(
    [...capped.matchAll(/0x[0-9a-fA-F]{2,64}/g)]
      .map((m) => decodeShortStringFelt(m[0]))
      .filter((s): s is string => !!s),
  )];
  return decoded.length ? `${capped} [decoded: ${decoded.join(', ')}]` : capped;
}

// JSON-RPC 2.0 POST with NAMED params. Routes non-OK through parseJsonResponse
// (clear, labelled errors) and surfaces a JSON-RPC `error` body as a throw.
async function rpc<T>(method: string, params: unknown, opts: AvnuClientOpts): Promise<T> {
  const doFetch = opts.fetchImpl ?? fetch;
  // #104: AbortSignal.timeout bounds the request — a stalled AVNU endpoint rejects
  // instead of hanging the deposit flow forever.
  const res = await doFetch(opts.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(opts.apiKey ? { 'x-paymaster-api-key': opts.apiKey } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS),
  });
  const body = await parseJsonResponse<{
    result?: T;
    error?: { message?: string; code?: number; data?: unknown };
  }>(res, `AVNU paymaster ${method}`);
  if (body.error) {
    const code = body.error.code !== undefined ? ` (code ${body.error.code})` : '';
    const detail = extractRpcErrorDetail(body.error.data);
    throw new Error(
      `AVNU paymaster ${method} error${code}: ${body.error.message ?? 'unknown error'}` +
        (detail ? `: ${detail}` : ''),
    );
  }
  if (body.result === undefined) {
    throw new Error(`AVNU paymaster ${method}: missing result in response`);
  }
  return body.result;
}

// Builds the typed data / fee_action for a private transaction WITHOUT submitting.
export function buildTransaction(
  params: AvnuBuildParams,
  opts: AvnuClientOpts,
): Promise<AvnuBuildResponse> {
  return rpc<AvnuBuildResponse>(METHOD_BUILD, params, opts);
}

// Submits a built+signed private transaction. Returns { tracking_id, transaction_hash }.
export function executeTransaction(
  params: AvnuExecuteParams,
  opts: AvnuClientOpts,
): Promise<AvnuExecuteResponse> {
  return rpc<AvnuExecuteResponse>(METHOD_EXECUTE, params, opts);
}
