import { RpcProvider, Account, PaymasterRpc } from 'starknet';
import type { PaymasterInterface } from 'starknet';
import { config } from './config';

export function getRpcProvider(): RpcProvider {
  return new RpcProvider({ nodeUrl: config.rpcUrl });
}

// The AVNU paymaster client, built from config.paymaster (undefined when unset). Used
// for SNIP-29 sponsored/gasless submission (executePaymasterTransaction) — e.g. the
// account deploy (deploy.ts) and the permissionless CCTP mint (snMint.ts). Shared so
// every makeAccount() is sponsored-capable when a paymaster is configured.
export function getPaymasterRpc(): PaymasterRpc | undefined {
  const pm = config.paymaster;
  if (!pm) return undefined;
  return new PaymasterRpc({
    nodeUrl: pm.endpoint,
    headers: { 'x-paymaster-api-key': pm.apiKey },
  });
}

// Builds an Account. When `config.paymaster` is set, a PaymasterRpc is attached by
// default so the account can submit SNIP-29 sponsored/gasless txs
// (executePaymasterTransaction) — harmless for ordinary account.execute() calls,
// which ignore it. Pass an explicit `paymaster` to override, or omit on a config
// without a paymaster for plain fee-paying txs.
export function makeAccount(
  address: string,
  privateKey: string,
  provider?: RpcProvider,
  paymaster?: PaymasterInterface,
): Account {
  const pm = paymaster ?? getPaymasterRpc();
  return new Account({
    provider: provider ?? getRpcProvider(),
    address,
    signer: privateKey,
    cairoVersion: '1',
    ...(pm ? { paymaster: pm } : {}),
  });
}
