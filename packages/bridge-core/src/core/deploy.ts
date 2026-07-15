import { PaymasterRpc, RpcError } from 'starknet';
import type { PaymasterDetails } from 'starknet';
import { getRpcProvider, makeAccount } from './provider';
import { config } from './config';
import { getDepositTokenBalance } from './deposit';
import { invalidateManagerNonce } from './proven-submit';
import { READ_BLOCK, submitAndTrack } from './tx';
import { getStrkBalance } from './balance';
import { formatTokenAmount } from './discover';

// Funding here covers ONLY the account DEPLOY — the single tx in this lifecycle
// that pays a real fee. The deploy is a server-side tx (not proven), so it carries
// genuine v3 resource bounds and the account must hold enough STRK to cover them.
//
// The downstream proven legs (register / deposit / withdraw) need NO funding: they
// are apply_actions invokes carrying a STARK proof, submitted to a transaction
// prover that runs them with skip_fee_charge = true (ZERO fee), and the prover
// requires every max_price_per_unit AND tip to be 0 (validate_zero_fee_fields).
// With all prices 0 the implied max fee Σ(max_amount × max_price) is 0, so the
// node's __validate__ can NEVER reject with code 55 ("Resources bounds … exceed
// balance") regardless of balance. See proven-submit.ts for the bounds + rationale.
// (An earlier version wrongly right-sized the proven bounds to ~4 STRK each and
// pre-funded the account ~15 STRK as a "proven-leg reserve"; that non-zero implied
// fee is exactly what produced code 55 on a low-balance account.)
//
// 1 STRK safety floor on the deploy funding so an estimate of 0 / a failed estimate
// still funds a server-side deploy.
export const DEPLOY_FUND_FLOOR_WEI = 1n * 10n ** 18n;

// Pure decision helper: how much STRK to transfer to the new address so its
// self-deploy clears, given the deploy fee estimate (wei). Returns the estimate ×3
// (margin over a possibly-stale estimate), floored at DEPLOY_FUND_FLOOR_WEI so a
// zero / failed estimate still funds the deploy. Kept pure (no I/O) so it is
// unit-testable at the boundaries.
export function deployFunding(deployEstimateWei: bigint): bigint {
  const target = deployEstimateWei * 3n;
  return target > DEPLOY_FUND_FLOOR_WEI ? target : DEPLOY_FUND_FLOOR_WEI;
}

// SNIP-29 account-deployment data for the derived OpenZeppelin account, mirroring
// the admin path's deployPayload (classHash + [publicKey] calldata + publicKey
// salt). The paymaster bundles this so a not-yet-deployed account can be deployed
// as part of the sponsored transaction. Kept pure (no I/O) so it is unit-testable.
type DeploymentData = NonNullable<PaymasterDetails['deploymentData']>;

export function buildDeploymentData(address: string, publicKey: string): DeploymentData {
  return {
    address,
    class_hash: config.ozClassHash,
    salt: publicKey,
    calldata: [publicKey],
    version: 1,
  };
}

// Transfers `amount` STRK from the admin account to `to`, committed to L2.
// Pre-checks the admin's STRK so a low gas-funder surfaces a clear, actionable
// error rather than an opaque on-chain revert (mirrors ensureDepositTokenFunded
// in deposit.ts). Never logs key material.
async function transferStrkFromAdmin(
  to: string,
  amount: bigint,
  onStatus?: (s: { phase: string; finality?: string }) => void,
): Promise<void> {
  const admin = config.admin;
  if (!admin?.privateKey) {
    throw new Error(
      'No admin account configured — the testnet admin-funded transfer is unavailable ' +
        '(set ADMIN_* in dev; production must use the paymaster).',
    );
  }
  const provider = getRpcProvider();
  const adminBalance = await getStrkBalance(admin.address);
  if (adminBalance < amount) {
    throw new Error(
      `Admin ${admin.address} is low on STRK to fund the deploy ` +
        `(has ${formatTokenAmount(adminBalance, 18)}, needs ${formatTokenAmount(amount, 18)}) — ` +
        `top it up with testnet STRK (e.g. the Starknet Sepolia faucet).`,
    );
  }
  const adminAccount = makeAccount(admin.address, admin.privateKey, provider);
  const transferCall = {
    contractAddress: config.strkToken,
    entrypoint: 'transfer',
    // u256 amount -> [low, high]. amount fits in 128 bits for any realistic
    // fee, so high is 0; split defensively all the same.
    calldata: [
      to,
      (amount & ((1n << 128n) - 1n)).toString(),
      (amount >> 128n).toString(),
    ],
  };
  await submitAndTrack(provider, () => adminAccount.execute(transferCall), {
    until: 'ACCEPTED_ON_L2',
    onStatus: ({ finality }) => onStatus?.({ phase: 'funding', finality }),
  });
  // #103: this direct adminAccount.execute is invisible to proven-submit.ts's shared
  // localNonce (it never goes through managerExecute) — if adminAccount shares the
  // manager's on-chain address, the next managerExecute would read a stale local
  // counter and collide (code-52) before recovering in-call. Invalidate so the next
  // managerExecute re-seeds from a settled chain read instead of trusting a stale value.
  invalidateManagerNonce();
}

// Distinguishes "the address genuinely has no class deployed" (RPC error
// CONTRACT_NOT_FOUND = 20, the only signal that an account is absent) from ANY OTHER
// failure — a transient transport error (ECONNRESET → the dev proxy's 500), a
// timeout, a rate-limit, an unrelated RPC error. Only the former means "not
// deployed". An ambiguous read MUST NOT be reported as not-deployed: if a flaky RPC
// were swallowed as `false`, ensureAccountDeployed would fire a REDUNDANT deploy of
// an already-deployed account, which reverts on-chain "contract already deployed"
// (paymaster code 156 / node code 41) instead of surfacing the real "RPC
// unavailable, retry". Kept pure (no I/O) so it is unit-testable at the boundary.
export function isContractNotFoundError(err: unknown): boolean {
  if (err instanceof RpcError) return err.isType('CONTRACT_NOT_FOUND');
  // Fallback for non-RpcError wrappers (a transport/batch layer that re-throws a
  // plain Error carrying the RPC code or its canonical message).
  const withCode = err as { code?: unknown; baseError?: { code?: unknown } } | null | undefined;
  const code = withCode?.code ?? withCode?.baseError?.code;
  if (code === 20 || code === '20') return true;
  const msg = (err as { message?: unknown } | null | undefined)?.message;
  return typeof msg === 'string' && /contract not found/i.test(msg);
}

// Returns true if a contract class is already deployed at `address` as of
// `blockTag`. getClassHashAt throws CONTRACT_NOT_FOUND for an undeployed address →
// false; any OTHER error is an ambiguous read (transient RPC failure) and is
// RE-THROWN, never silently reported as not-deployed (see isContractNotFoundError).
async function isDeployedAtBlock(
  address: string,
  blockTag: typeof READ_BLOCK | 'latest',
): Promise<boolean> {
  try {
    await getRpcProvider().getClassHashAt(address, blockTag);
    return true;
  } catch (err) {
    if (isContractNotFoundError(err)) return false;
    throw err;
  }
}

// Returns true if a contract class is already deployed at `address` at the read
// block (pre_confirmed — the fastest stable view).
export function isDeployed(address: string): Promise<boolean> {
  return isDeployedAtBlock(address, READ_BLOCK);
}

// Returns true once the account is deployed in COMMITTED (ACCEPTED_ON_L2) state,
// reading at the 'latest' block rather than 'pre_confirmed'. The prover/indexer
// only see committed state, so registration must wait for this — a freshly
// self-deployed account is initially only pre-confirmed.
export function isDeployedOnL2(address: string): Promise<boolean> {
  return isDeployedAtBlock(address, 'latest');
}

interface EnsureDeployedArgs {
  address: string;
  publicKey: string;
  privateKey: string;
  onStatus?: (s: { phase: string; finality?: string }) => void;
  // Fires with the deploy tx hash once it lands (for a block-explorer link). Not
  // called on the already-deployed skip, which submits nothing.
  onTx?: (hash: string) => void;
}

// PRODUCTION deploy path: deploy the derived account via the AVNU paymaster (SNIP-29).
//
// Fee mode (config.deployFeeMode):
//   'default' (DEFAULT) — the account pays its OWN deploy fee in USDC via AVNU
//     pay-in-token. The fee transfers FROM the account inside the deploy tx, so the
//     account MUST already hold USDC (the caller funds it first — fund-then-deploy).
//     We estimate the fee, pre-check the account's USDC ≥ the suggested max (clear,
//     actionable error on a shortfall instead of an opaque on-chain revert), then
//     submit with that max as the pay-in-token cap.
//   'sponsored' — the paymaster pays the deploy fee, so there is NO admin→account
//     STRK transfer and the account needs no pre-funding (the pre-toggle behaviour).
//
// Tracks to PRE_CONFIRMED and returns the block number (proving-block anchor), same
// contract as the admin path — identical in both fee modes.
async function deployViaPaymaster(
  args: EnsureDeployedArgs,
  paymasterConfig: NonNullable<typeof config.paymaster>,
): Promise<number | undefined> {
  const { address, publicKey, privateKey, onStatus, onTx } = args;
  const provider = getRpcProvider();
  const paymaster = new PaymasterRpc({
    nodeUrl: paymasterConfig.endpoint,
    headers: { 'x-paymaster-api-key': paymasterConfig.apiKey },
  });
  const account = makeAccount(address, privateKey, provider, paymaster);

  const payInToken = config.deployFeeMode === 'default';
  const feesDetails: PaymasterDetails = {
    feeMode: payInToken
      ? { mode: 'default', gasToken: config.depositToken.address }
      : { mode: 'sponsored' },
    deploymentData: buildDeploymentData(address, publicKey),
  };

  // A pure deploy carries no calls — the deploymentData alone deploys the account.
  let maxFeeInGasToken: bigint | undefined;
  if (payInToken) {
    // Estimate the deploy fee in the gas token (USDC), then pre-check the account's
    // balance covers AVNU's suggested max BEFORE submitting — a shortfall would
    // otherwise revert opaquely inside the deploy. Surface an actionable message.
    onStatus?.({ phase: 'estimating' });
    const [est, balance] = await Promise.all([
      account.estimatePaymasterTransactionFee([], feesDetails),
      getDepositTokenBalance(address),
    ]);
    maxFeeInGasToken = BigInt(est.suggested_max_fee_in_gas_token);
    if (balance < maxFeeInGasToken) {
      const symbol = config.depositToken.symbol;
      const decimals = config.depositToken.decimals;
      throw new Error(
        `Account holds ${formatTokenAmount(balance, decimals)} ${symbol} but the one-time deploy ` +
          `fee needs ~${formatTokenAmount(maxFeeInGasToken, decimals)} ${symbol} — increase the deposit ` +
          `so it covers the deploy fee.`,
      );
    }
  }

  // No 'funding' phase: the account is funded by the caller (fund-then-deploy) before
  // this path runs. Sponsored mode pays no fee and transfers no STRK either.
  onStatus?.({ phase: 'deploying' });
  const { blockNumber, transaction_hash } = await submitAndTrack(
    provider,
    () => account.executePaymasterTransaction([], feesDetails, maxFeeInGasToken),
    {
      until: 'PRE_CONFIRMED',
      onStatus: ({ finality }) => onStatus?.({ phase: 'deploying', finality }),
    },
  );
  onTx?.(transaction_hash);

  onStatus?.({ phase: 'deployed' });
  return blockNumber;
}

// TESTNET/DEV deploy path: fund the deploy from the env admin (gas-funder) account.
// The admin transfers deployFunding(estimate) STRK to the new address (committed to
// L2 first), then the account self-deploys. The admin key is dev-only (undefined in
// a production build — see config.ts), so this path is unavailable on mainnet.
// The caller guarantees config.admin is present; transferStrkFromAdmin reads it.
async function deployViaAdmin(args: EnsureDeployedArgs): Promise<number | undefined> {
  const { address, publicKey, privateKey, onStatus, onTx } = args;
  const provider = getRpcProvider();
  const account = makeAccount(address, privateKey, provider);

  const deployPayload = {
    classHash: config.ozClassHash,
    constructorCalldata: [publicKey],
    addressSalt: publicKey,
  };

  // 1. Estimate the deploy fee, then fund deployFunding(estimate) — the deploy's
  //    own fee with a 3× margin, floored at DEPLOY_FUND_FLOOR_WEI. This covers ONLY
  //    the deploy (a server-side v3 tx); the downstream proven legs are zero-fee, so
  //    no extra reserve is retained. On estimate failure, fund the floor so a
  //    server-side deploy still goes through.
  onStatus?.({ phase: 'estimating' });
  let fundAmount: bigint;
  try {
    const estimate = await account.estimateAccountDeployFee({
      ...deployPayload,
      contractAddress: address,
    });
    fundAmount = deployFunding(estimate.overall_fee);
  } catch {
    fundAmount = DEPLOY_FUND_FLOOR_WEI;
  }

  // 2. Fund the new address from the admin account (STRK transfer). The deploy
  //    can only succeed once the funding is committed, so transferStrkFromAdmin
  //    waits for L2 and pre-checks the admin's STRK (clear error on a low
  //    gas-funder instead of an opaque revert).
  onStatus?.({ phase: 'funding' });
  await transferStrkFromAdmin(address, fundAmount, onStatus);

  // 3. Self-deploy the account, tracking to pre-confirmed.
  onStatus?.({ phase: 'deploying' });
  const { blockNumber, transaction_hash } = await submitAndTrack(
    provider,
    () => account.deployAccount(deployPayload),
    {
      until: 'PRE_CONFIRMED',
      onStatus: ({ finality }) => onStatus?.({ phase: 'deploying', finality }),
    },
  );
  onTx?.(transaction_hash);

  onStatus?.({ phase: 'deployed' });
  return blockNumber;
}

// Ensures the derived OpenZeppelin account is DEPLOYED, funding ONLY the deploy.
// The deploy is the single fee-paying tx in this lifecycle (a server-side v3 tx);
// the downstream proven legs (register/deposit/withdraw) are zero-fee and so need
// NO funding — see the file header + proven-submit.ts.
//   - ALREADY deployed: the proven legs are zero-fee, so there is nothing to fund.
//     Just report 'deployed' and return — no balance read, no funding.
//   - NOT deployed: prefer the AVNU paymaster (SNIP-29 sponsored deploy) whenever
//     it is configured (dev AND prod); otherwise fall back to the dev/testnet
//     admin-funded deploy. With neither configured (e.g. a production build with no
//     paymaster key), throw a clear, actionable error.
//
// Returns the deploy tx's block number when the node exposes it (it tracks to
// PRE_CONFIRMED, which usually omits the block, so this is typically undefined);
// the caller seeds the proving-block wait from it (falling back to the current
// block once the account commits). Returns undefined when already deployed.
export async function ensureAccountDeployed(args: EnsureDeployedArgs): Promise<number | undefined> {
  if (await isDeployed(args.address)) {
    // Already deployed — the downstream proven legs are zero-fee, so there is
    // nothing to fund. Report ready and return.
    args.onStatus?.({ phase: 'deployed' });
    return undefined;
  }

  // Prefer the paymaster (production path) when configured — both dev and prod.
  if (config.paymaster) {
    return deployViaPaymaster(args, config.paymaster);
  }

  // Fall back to the dev/testnet admin-funded deploy. Admin is undefined in a
  // production build (see config.ts), so mainnet without a paymaster hits the throw.
  if (config.admin?.privateKey) {
    return deployViaAdmin(args);
  }

  throw new Error(
    'No account-deploy funding configured — set AVNU_PAYMASTER_API_KEY for the ' +
      'production paymaster (SNIP-29 sponsored deploy), or ADMIN_* for the ' +
      'dev/testnet admin-funded deploy.',
  );
}
