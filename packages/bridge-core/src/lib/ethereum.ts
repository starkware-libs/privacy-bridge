// Minimal EVM wallet provider types + helpers used by bridge-core modules.
// The WalletConnect-only React wallet layer lives in bridge-core/react.
//
// WC-only: there is NO window.ethereum injected-provider fallback. The live
// provider is owned by the React WalletProvider (useWallet().getProvider()) and
// passed EXPLICITLY into the modules that need it (e.g. fundFromMetaMask's
// `provider` arg). Core code here only needs the chain-switch helper + the
// shared EIP-1193 / chain-param shapes; it never reaches for a global provider.

export interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  removeListener(event: string, handler: (...args: unknown[]) => void): void;
  isMetaMask?: boolean;
  isWalletConnect?: boolean;
}

// Description of an EVM chain for wallet_addEthereumChain.
export interface AddChainParams {
  chainId: number;
  chainName: string;
  rpcUrls: string[];
  nativeCurrency: { name: string; symbol: string; decimals: number };
  blockExplorerUrls?: string[];
}

// Ask the wallet to switch to `chainId` (decimal). If the wallet doesn't know
// the chain (error 4902) and `addParams` is supplied, add it then switch.
export async function switchChain(
  provider: EthereumProvider,
  chainId: number,
  addParams?: AddChainParams,
): Promise<void> {
  const hexChainId = '0x' + chainId.toString(16);
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexChainId }],
    });
  } catch (err) {
    // 4902 = chain not added to the wallet yet.
    const code = (err as { code?: number })?.code;
    if (code === 4902 && addParams) {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: '0x' + addParams.chainId.toString(16),
            chainName: addParams.chainName,
            rpcUrls: addParams.rpcUrls,
            nativeCurrency: addParams.nativeCurrency,
            blockExplorerUrls: addParams.blockExplorerUrls,
          },
        ],
      });
      return;
    }
    throw err;
  }
}
