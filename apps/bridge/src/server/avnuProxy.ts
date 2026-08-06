// AVNU paymaster proxy — a framework-agnostic (Request) => Promise<Response>
// handler. The SPA points bridge-core's paymaster endpoint at this same-origin
// route (initBridge.ts) so the real AVNU bearer key lives ONLY in server-side
// env (AVNU_PAYMASTER_API_KEY — never VITE_*, never in the JS bundle). The
// JSON-RPC body is forwarded verbatim; the proxy only adds the
// x-paymaster-api-key header. NEVER log the request/response bodies (they
// carry proofs + signed typed-data).
//
// Wire this into whatever host serves the app (Vercel/Cloudflare/Node/etc.) at
// the path `/api/avnu`.

// The ONLY JSON-RPC methods bridge-core's paymaster clients issue — the direct
// AVNU client (bridge-core avnuPaymaster.ts: paymaster_buildTransaction /
// paymaster_executeTransaction) and starknet.js's PaymasterRpc (provider.ts /
// deploy.ts: those two plus paymaster_isAvailable / paymaster_getSupportedTokens).
// Everything else is rejected — the key must not become a general AVNU proxy.
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  'paymaster_isAvailable',
  'paymaster_getSupportedTokens',
  'paymaster_buildTransaction',
  'paymaster_executeTransaction',
]);

const DEFAULT_AVNU_URL = 'https://starknet.paymaster.avnu.fi';

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const apiKey = process.env.AVNU_PAYMASTER_API_KEY;
  if (!apiKey) {
    return new Response('AVNU paymaster is not configured (AVNU_PAYMASTER_API_KEY).', {
      status: 500,
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response('invalid JSON body', { status: 400 });
  }
  // Single JSON-RPC request only (no batches — neither client sends them), with
  // an allowlisted method. Reject as a JSON-RPC error so both paymaster clients
  // surface the reason instead of a bare HTTP failure.
  const rpc = (body ?? {}) as { method?: unknown; id?: unknown };
  if (Array.isArray(body) || typeof rpc.method !== 'string' || !ALLOWED_METHODS.has(rpc.method)) {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: typeof rpc.id === 'number' || typeof rpc.id === 'string' ? rpc.id : null,
        error: { code: -32601, message: 'method not allowed by the /api/avnu proxy' },
      }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );
  }

  // `||` (not `??`) so a blank env line falls through to the default endpoint.
  const upstream = process.env.AVNU_PAYMASTER_URL || DEFAULT_AVNU_URL;
  const res = await fetch(upstream, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-paymaster-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}
