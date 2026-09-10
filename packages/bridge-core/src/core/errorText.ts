// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Extracting the classifiable text of a thrown value. Its own module so errors.ts can
// share it with tx.ts's sanitizeErrorMessage without importing tx.ts.

// starknet.js RpcError builds its `.message` as
//   `RPC: <method> with params <big JSON>\n  <code>: <message>: <data>`
// so the ACTUAL failure reason sits AFTER a huge params dump — front-truncating the
// message (below) would drop exactly the part we need (this is why the paymaster
// error was invisible in the UI). RpcError also exposes the reason structurally on
// `.baseError = { code, message, data }`; extract that and the method name so the UI
// shows e.g. `paymaster_buildTransaction (163): … : x-paymaster-api-key is invalid`.
//
// starknet.js does NOT validate that the server's error payload actually matches
// {code,message,data} before building that template — a proxy/gateway failure (e.g.
// our dev-proxy's 502 "network not configured" stub, or any non-JSON-RPC upstream)
// can hand it a bare string or an HTTP-response-shaped object instead. The library
// still renders the template against whatever it got, so the literal string
// "undefined: undefined: undefined" was reaching the UI. Handle those shapes too,
// and never let the literal word "undefined" stand in for a missing field.
const UNDEFINED_TRIPLET_RE = /undefined:\s*undefined:\s*undefined\s*$/;

function rpcErrorReason(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const base = (err as { baseError?: unknown }).baseError;
  const method =
    err instanceof Error ? err.message.match(/^RPC:\s*(\S+)\s+with params/)?.[1] : undefined;

  // 1) baseError is a bare string — e.g. a proxy stub that replies
  //    `{ error: "<string>" }` instead of `{ error: { code, message, data } }`.
  //    It's already human text; use it as-is.
  if (typeof base === 'string' && base.trim()) {
    const text = base.trim();
    return method ? `${method}: ${text}` : text;
  }

  if (base && typeof base === 'object') {
    const b = base as { code?: unknown; message?: unknown; data?: unknown } & Record<
      string,
      unknown
    >;
    const parts: string[] = [];
    if (b.code !== undefined && b.code !== null) parts.push(`(${String(b.code)})`);
    if (b.message) parts.push(String(b.message));
    if (b.data !== undefined && b.data !== null && b.data !== '') {
      let data: string;
      try {
        data = typeof b.data === 'string' ? b.data : JSON.stringify(b.data);
      } catch {
        data = String(b.data);
      }
      if (data && data !== '""') parts.push(data);
    }
    if (parts.length) return method ? `${method} ${parts.join(': ')}` : parts.join(': ');

    // 2) No {code,message,data} at all — try an HTTP-response-shaped baseError
    //    instead (status/statusText/body), e.g. a raw 502 that never had a
    //    JSON-RPC envelope in the first place.
    if (b.status !== undefined || b.statusText || b.body) {
      const status = b.status !== undefined ? ` ${String(b.status)}` : '';
      const statusText = b.statusText ? ` ${String(b.statusText)}` : '';
      const bodyText = typeof b.body === 'string' ? b.body.trim() : '';
      const preview = bodyText ? `: ${bodyText.slice(0, 200)}` : '';
      return `Starknet RPC error (HTTP${status}${statusText})${preview}`;
    }
  }

  // 3) No usable baseError (missing entirely, or an empty {code,message,data}
  //    triplet) but the raw message still carries the broken
  //    "undefined: undefined: undefined" render — e.g. starknet.js's own
  //    `errorHandler` re-wraps an unrecognized error as `new Error(other.message)`,
  //    losing `.baseError` but keeping the garbled text. Never surface that verbatim.
  const rawMessage = err instanceof Error ? err.message : undefined;
  if (rawMessage && UNDEFINED_TRIPLET_RE.test(rawMessage)) {
    return method
      ? `Starknet RPC error calling ${method}: the node returned no usable error details.`
      : 'Starknet RPC error: the node returned no usable error details.';
  }

  return undefined;
}

// The classifiable text of a thrown value: the structured RPC reason when there is one,
// else the `message` of any object (a cross-realm DOMException or a non-Error library
// error included), else its stringification. Shared with errors.ts so isTransientError
// and sanitizeErrorMessage never judge different text.
export function errorText(err: unknown): string {
  const reason = rpcErrorReason(err);
  if (reason !== undefined) return reason;
  if (err instanceof Error) return err.message;
  if (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { message?: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}

