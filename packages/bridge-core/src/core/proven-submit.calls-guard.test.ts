// #77 — SECURITY regression: paymasterExecuteLeg must refuse to sign a paymaster
// typed_data whose embedded calls diverge from the caller's actual userCalls.
//
// Prior to this fix, paymasterExecuteLeg signed `ctx.typedData` (server-controlled)
// with NO comparison to the caller's intended calls — a malicious/buggy AVNU
// paymaster could substitute a drain-to-attacker call into the SNIP-9 typed_data and
// the derived account would sign it blind. PR #75 shipped a `callsAreStrictlyEqual`
// guard for the OLD paymaster-submit.ts; it was dropped in the #73 rewrite and never
// re-added to proven-submit.ts / avnuPaymaster.ts. This test pins the re-introduced
// guard: signMessage must NEVER be reached when the typed_data calls mismatch.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  cfg: {
    poolAddress: '0xPOOL',
    depositToken: { address: '0xUSDC' },
    paymaster: { endpoint: 'https://pm.test', apiKey: 'KEY', feeMode: 'sponsored_private', poolFeeToken: '' } as
      | { endpoint: string; apiKey: string; feeMode: 'sponsored_private' | 'sponsored'; poolFeeToken: string }
      | undefined,
    admin: undefined as { address: string; privateKey: string } | undefined,
  },
  buildTransaction: vi.fn(),
  executeTransaction: vi.fn(),
}));

vi.mock('./config', () => ({ config: h.cfg }));
vi.mock('./avnuPaymaster', () => ({
  buildTransaction: h.buildTransaction,
  executeTransaction: h.executeTransaction,
  toAvnuCall: (c: { contractAddress: string; entrypoint: string; calldata: string[] }) => ({
    to: c.contractAddress,
    selector: c.entrypoint,
    calldata: (c.calldata ?? []).map((x) => x.toString()),
  }),
}));
vi.mock('./provider', () => ({ makeAccount: vi.fn() }));

import { paymasterBuildLeg, paymasterExecuteLeg, submitProvenViaPaymaster } from './proven-submit';

const POOL_CALL = { contractAddress: '0xPOOL', entrypoint: 'apply_actions', calldata: ['7'] };
const PROOF = { proof: '0xPROOF', proofFacts: ['0xf1'] };
const HONEST_CALL = { contractAddress: '0xUSDC', entrypoint: 'transfer', calldata: ['0xhonestrecipient', '100', '0'] };

function fakeAccount() {
  return {
    address: '0xACCT',
    signMessage: vi.fn(async () => ['0x1a2b', '0x3c4d']),
  } as unknown as Parameters<typeof submitProvenViaPaymaster>[0] & { signMessage: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.cfg.paymaster = { endpoint: 'https://pm.test', apiKey: 'KEY', feeMode: 'sponsored_private', poolFeeToken: '' };
  h.cfg.admin = undefined;
  h.executeTransaction.mockResolvedValue({ tracking_id: 'trk', transaction_hash: '0xHASH' });
});

describe('#77 — calls-substitution guard (paymasterExecuteLeg)', () => {
  it('refuses to sign typed_data whose embedded calls diverge from the caller-supplied userCalls', async () => {
    // The paymaster echoes an ATTACKER-substituted call in typed_data.message.calls —
    // deliberately different from HONEST_CALL (attacker address, drained amount).
    h.buildTransaction.mockResolvedValue({
      type: 'invoke_and_apply_action',
      typed_data: {
        message: {
          calls: [{ to: '0xUSDC', selector: 'transfer', calldata: ['0xATTACKERADDRESS', '999999', '0'] }],
        },
      },
      fee_action: { type: 'withdraw', recipient: '0xr', token: '0xUSDC', amount: '0x0' },
    });
    const account = fakeAccount();

    await expect(
      submitProvenViaPaymaster(account, POOL_CALL, PROOF, {
        type: 'invoke_and_apply_action',
        userCalls: [HONEST_CALL],
      }),
    ).rejects.toThrow(/calls do not match|calls-substitution/i);

    // The critical assertion: signMessage must NEVER be reached on a mismatch.
    expect(account.signMessage).not.toHaveBeenCalled();
    expect(h.executeTransaction).not.toHaveBeenCalled();
  });

  it('fails closed when typed_data carries no recognizable calls shape at all', async () => {
    const ctx = await paymasterBuildLeg(fakeAccount(), {
      type: 'invoke_and_apply_action',
      userCalls: [HONEST_CALL],
    });
    ctx.typedData = { domain: 'snip9' }; // no message.calls
    const account = fakeAccount();

    await expect(paymasterExecuteLeg(account, POOL_CALL, PROOF, ctx)).rejects.toThrow(
      /calls do not match|calls-substitution/i,
    );
    expect(account.signMessage).not.toHaveBeenCalled();
  });

  it('signs when the typed_data calls exactly echo the honest userCalls (felt-encoding tolerant)', async () => {
    // Paymaster re-encodes the same call with a hex-normalized amount ('0x64' === '100')
    // — must still be treated as a match (normalizeFelt tolerates the base difference).
    h.buildTransaction.mockResolvedValue({
      type: 'invoke_and_apply_action',
      typed_data: {
        message: {
          calls: [{ to: '0xUSDC', selector: 'transfer', calldata: ['0x1', '0x64', '0x0'] }],
        },
      },
      fee_action: { type: 'withdraw', recipient: '0xr', token: '0xUSDC', amount: '0x0' },
    });
    const account = fakeAccount();
    const honestHexCall = { contractAddress: '0xUSDC', entrypoint: 'transfer', calldata: ['1', '100', '0'] };

    await submitProvenViaPaymaster(account, POOL_CALL, PROOF, {
      type: 'invoke_and_apply_action',
      userCalls: [honestHexCall],
    });

    expect(account.signMessage).toHaveBeenCalledOnce();
    expect(h.executeTransaction).toHaveBeenCalledOnce();
  });
});

// The LIVE AVNU server (validated on sepolia.paymaster.avnu.fi, 2026-07-03) returns
// SNIP-12 rev-1 CAPITALIZED typed_data: `message.Calls` with `{ To, Selector, Calldata }`
// (see live-QA probe-result.json, label sponsored-invoke-STRK). The shipped lowercase-only
// extractTypedDataCalls therefore returned undefined for every real invoke_and_apply_action,
// so the #77 guard failed CLOSED and no AVNU pool deposit/withdraw could ever succeed live.
describe('#77 guard — SNIP-12 rev-1 CAPITALIZED live shape (message.Calls / {To,Selector,Calldata})', () => {
  // Exact call observed live (probe-result.json → sponsored-invoke-STRK → message.Calls[0]).
  const LIVE_TO = '0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
  const LIVE_SELECTOR = '0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e';
  const LIVE_CALLDATA = ['0x1', '0x1', '0x0'];

  // The full capitalized typed_data envelope as the live server emits it.
  const liveCapitalizedTypedData = (
    calls: Array<{ To: string; Selector: string; Calldata: string[] }>,
  ) => ({
    primaryType: 'OutsideExecution',
    domain: { name: 'Account.execute_from_outside', version: '2', chainId: 'SN_SEPOLIA', revision: '1' },
    message: {
      Caller: '0x75a180e18e56da1b1cae181c92a288f586f5fe22c18df21cf97886f1e4b316c',
      Nonce: '0xda7b9bd12f032982db4a9b03425a99fc',
      'Execute After': '0x1',
      'Execute Before': '0x6a47fed6',
      Calls: calls,
    },
  });

  it('signs when the CAPITALIZED live-shape Calls match the honest userCalls (RED against shipped lowercase reader)', async () => {
    h.buildTransaction.mockResolvedValue({
      type: 'invoke_and_apply_action',
      typed_data: liveCapitalizedTypedData([
        { To: LIVE_TO, Selector: LIVE_SELECTOR, Calldata: LIVE_CALLDATA },
      ]),
      fee_action: { type: 'withdraw', recipient: '0xr', token: '0xUSDC', amount: '0x0' },
    });
    const account = fakeAccount();
    const liveCall = { contractAddress: LIVE_TO, entrypoint: LIVE_SELECTOR, calldata: LIVE_CALLDATA };

    await submitProvenViaPaymaster(account, POOL_CALL, PROOF, {
      type: 'invoke_and_apply_action',
      userCalls: [liveCall],
    });

    // Shipped code reads `message.calls` (lowercase) → undefined → guard fails closed →
    // signMessage never reached. After the casing fix, the capitalized Calls parse + match.
    expect(account.signMessage).toHaveBeenCalledOnce();
    expect(h.executeTransaction).toHaveBeenCalledOnce();
  });

  it('still REJECTS a MISMATCHED capitalized typed_data — casing tolerance must NOT weaken the guard', async () => {
    // Same capitalized field names, but the server substituted an attacker call.
    h.buildTransaction.mockResolvedValue({
      type: 'invoke_and_apply_action',
      typed_data: liveCapitalizedTypedData([
        { To: '0xUSDC', Selector: 'transfer', Calldata: ['0xATTACKERADDRESS', '999999', '0'] },
      ]),
      fee_action: { type: 'withdraw', recipient: '0xr', token: '0xUSDC', amount: '0x0' },
    });
    const account = fakeAccount();

    await expect(
      submitProvenViaPaymaster(account, POOL_CALL, PROOF, {
        type: 'invoke_and_apply_action',
        userCalls: [HONEST_CALL],
      }),
    ).rejects.toThrow(/calls do not match|calls-substitution/i);

    expect(account.signMessage).not.toHaveBeenCalled();
    expect(h.executeTransaction).not.toHaveBeenCalled();
  });
});
