// Debug-mode logging for diagnosing bridge value-path failures — Starknet RPC /
// prover / indexer (the per-network proxied paths `/rpc/<network>` etc.), plus the
// direct-origin AVNU paymaster, Circle Iris attestation, and Pimlico bundler calls.
//
// Ported from apps/web/src/debug.ts; same gating and exposure notes apply.
// Gated entirely behind `import.meta.env.VITE_DEBUG === 'true'`. When off,
// `installDebugLogging()` is a no-op and `window.fetch` is left untouched.
//
// WHAT IS LOGGED: this ONLY wraps `window.fetch` for the paths below, logging their
// FULL request + response bodies to the console. Be honest about the exposure: the
// `/prover` and `/indexer` request bodies include viewing-key-derived witness
// material — the discovery call sends the viewing key to the indexer, and proofs are
// computed over viewing-key-derived inputs — so that material WILL appear in these
// dev-only logs. This is acceptable here because the viewing key is sent to the
// discovery/indexer by design (see docs/threat-model.md), not an extra leak. AVNU
// bodies carry the typed data + proof facts (public once submitted); Iris and
// bundler traffic is public attestation/UserOp plumbing.
//
// It NEVER wraps or logs `window.ethereum` / personal_sign, and never logs the
// private key, the EVM signature, or claim_secret. All output is console-only;
// nothing is persisted to disk.

const DEBUG = import.meta.env.VITE_DEBUG === 'true';

// Optional local log sink (dev only). When VITE_DEBUG_SINK is set (e.g.
// http://127.0.0.1:8787/log), every console entry is ALSO POSTed there as one
// JSON line so the run can be tailed off disk for debugging. Best-effort and
// fire-and-forget: a down/absent sink never affects the app. Same exposure as
// the console (see the header note) — nothing extra is logged; the raw EVM
// signature / private key / claim_secret are never console-logged, so they never
// reach the sink either. Local-origin only; never enable in production.
const SINK_URL: string | undefined = import.meta.env.VITE_DEBUG_SINK || undefined;

function sinkPost(level: string, args: unknown[]): void {
  if (!SINK_URL) return;
  try {
    const body = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      args: args.map((a) => {
        if (a instanceof Error) return { error: a.message, stack: a.stack };
        if (typeof a === 'object' && a !== null) {
          try {
            return JSON.parse(JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
          } catch {
            return String(a);
          }
        }
        return a;
      }),
    });
    // keepalive so entries emitted during unload/navigation still flush.
    void fetch(SINK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(
      () => undefined,
    );
  } catch {
    // never let logging break the app
  }
}

// Mirror the console into the sink (dev only). Wraps log/info/warn/error/debug so
// EVERYTHING the app prints — the fetch-wrapper output below, step labels, tx
// hashes, thrown errors — is captured to the file, not just the wrapped fetches.
export function installLogSink(): void {
  if (!DEBUG || !SINK_URL) return;
  if (typeof window === 'undefined') return;
  const w = window as Window & { __debugSinkInstalled?: boolean };
  if (w.__debugSinkInstalled) return;
  w.__debugSinkInstalled = true;

  (['log', 'info', 'warn', 'error', 'debug'] as const).forEach((level) => {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      sinkPost(level, args);
    };
  });
  console.info('[logsink] console mirror installed →', SINK_URL);
}

// Paths/hosts whose traffic we want to surface in full for diagnosis.
const DEBUG_PATHS = [
  '/rpc',
  '/prover',
  '/indexer',
  'paymaster.avnu.fi',
  'iris-api',
  'pimlico.io',
  // EVM funding-chain RPC (CCTP burn submit + balance/receipt reads). Public chain
  // traffic only — a raw signed tx carries its own (public) tx signature, never the
  // wallet's personal_sign identity signature or any private key.
  'alchemy.com',
] as const;

function isDebugUrl(url: string): boolean {
  return DEBUG_PATHS.some((p) => url.includes(p));
}

function tagFor(url: string): string {
  const match = DEBUG_PATHS.find((p) => url.includes(p));
  return match ?? '/rpc';
}

// Compactly stringify JSON-RPC params so the console stays readable but the
// full calldata is still visible for diagnosis.
function compact(value: unknown, max = 2000): string {
  try {
    const s = JSON.stringify(value);
    if (s.length <= max) return s;
    return `${s.slice(0, max)}… (truncated, ${s.length} chars total)`;
  } catch {
    return String(value);
  }
}

// Parse a request body (string only — Blob/stream bodies are skipped) and, for
// JSON-RPC, surface method + compact params instead of the whole envelope.
function describeRequestBody(tag: string, body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string' || body.length === 0) return body ?? null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body; // not JSON — log raw text
  }

  if (tag === '/rpc') {
    // JSON-RPC can be a single call or a batch.
    const summarize = (call: Record<string, unknown>) => ({
      method: call.method,
      params: compact(call.params),
    });
    if (Array.isArray(parsed)) {
      return parsed.map((c) => summarize(c as Record<string, unknown>));
    }
    if (parsed && typeof parsed === 'object') {
      return summarize(parsed as Record<string, unknown>);
    }
  }
  return parsed;
}

// Detect a JSON-RPC `error` field (single or batch response).
function findJsonRpcError(parsed: unknown): unknown {
  if (Array.isArray(parsed)) {
    const errs = parsed
      .map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>).error : undefined))
      .filter((e) => e !== undefined);
    return errs.length > 0 ? errs : undefined;
  }
  if (parsed && typeof parsed === 'object') {
    return (parsed as Record<string, unknown>).error;
  }
  return undefined;
}

export function installDebugLogging(): void {
  if (!DEBUG) return;
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;

  // Guard against double-install (e.g. React StrictMode / HMR).
  const w = window as Window & { __debugFetchInstalled?: boolean };
  if (w.__debugFetchInstalled) return;
  w.__debugFetchInstalled = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Resolve the URL + method without disturbing the original call.
    let url = '';
    let method = 'GET';
    try {
      if (typeof input === 'string') {
        url = input;
      } else if (input instanceof URL) {
        url = input.toString();
      } else {
        url = input.url;
        method = input.method ?? method;
      }
      if (init?.method) method = init.method;
    } catch {
      return originalFetch(input as RequestInfo, init);
    }

    if (!isDebugUrl(url)) {
      return originalFetch(input as RequestInfo, init);
    }

    const tag = tagFor(url);

    // Log the outgoing request (best-effort; never throw).
    try {
      const reqBody = describeRequestBody(tag, init?.body);
      console.debug(`[debug ${tag}] → ${method} ${url}`, { request: reqBody });
    } catch {
      // ignore logging failures
    }

    let response: Response;
    try {
      response = await originalFetch(input as RequestInfo, init);
    } catch (err) {
      console.error(`[debug ${tag}] ✗ network error ${method} ${url}`, err);
      throw err;
    }

    // Clone so the app still gets an unconsumed body.
    try {
      const clone = response.clone();
      const text = await clone.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const rpcError = parsed !== undefined ? findJsonRpcError(parsed) : undefined;

      if (!response.ok || rpcError !== undefined) {
        // This is where the apply_actions revert reason lives — log the
        // COMPLETE error object/body at error level.
        console.error(`[debug ${tag}] ✗ ${response.status} ${method} ${url}`, {
          status: response.status,
          statusText: response.statusText,
          error: rpcError,
          body: parsed ?? text,
        });
      } else {
        console.debug(`[debug ${tag}] ← ${response.status} ${method} ${url}`, {
          body: parsed ?? text,
        });
      }
    } catch {
      // Never let logging break the response path.
    }

    return response;
  };
}
