// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Safe JSON parsing for `fetch` responses.
//
// The native `Response.json()` throws a bare, useless `SyntaxError: Unexpected
// end of JSON input` (a DOMException-shaped error in some runtimes) whenever the
// upstream returns an EMPTY body, an HTML error page, or any non-JSON payload —
// which is exactly what a 500/502/empty indexer/prover/RPC response produces. We
// guard EVERY `.json()` on a fetch response through these helpers so the failure
// surfaces as a CLEAR, actionable error that names the HTTP status + endpoint
// (e.g. "Indexer /v1/sync/incoming_state failed (500)") instead of the cryptic
// DOMException that bubbles up into the UI as a crash.

// `JSON.parse('')` → "Unexpected end of JSON input"; `JSON.parse('<html>')` →
// "Unexpected token '<'…". Both are SyntaxErrors. This recognises that family so
// callers wrapping a THIRD-PARTY `.json()` (e.g. the SDK indexer client, which we
// can't edit at source) can catch it and rethrow something readable.
export function isUnexpectedEndOfJsonError(err: unknown): boolean {
  if (err instanceof SyntaxError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /unexpected (end of json input|token|non-whitespace|string|number|eof)/i.test(message);
}

// Parse a JSON string, throwing a clear, labelled error (never a bare
// "Unexpected end of JSON input") when it is empty or not valid JSON.
export function safeJsonParse<T = unknown>(text: string, label = 'response'): T {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label}: empty body (expected JSON).`);
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const preview = trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
    throw new Error(`${label}: response was not valid JSON (got: ${preview}).`);
  }
}

// Read a `fetch` Response as JSON, guarding against:
//   - a non-OK status (throws "<label> failed (<status>)" with the status text),
//   - an empty body, and
//   - a non-JSON body
// so the caller NEVER sees a raw DOMException. `label` should name the endpoint,
// e.g. "Indexer /v1/sync/incoming_state".
export async function parseJsonResponse<T = unknown>(res: Response, label: string): Promise<T> {
  // Read the body as text first; .json() would throw the cryptic SyntaxError on
  // an empty/non-JSON body before we get a chance to attach the status.
  let text: string;
  try {
    text = await res.text();
  } catch {
    text = '';
  }

  if (!res.ok) {
    const statusText = res.statusText ? ` ${res.statusText}` : '';
    const detail = text.trim() ? ` — ${text.trim().slice(0, 200)}` : '';
    throw new Error(`${label} failed (${res.status}${statusText})${detail}`);
  }

  // OK status but possibly empty/garbled body — surface the status in the label
  // so an "OK but no JSON" still reads clearly (e.g. a 200 with an empty body).
  return safeJsonParse<T>(text, `${label} (${res.status})`);
}
