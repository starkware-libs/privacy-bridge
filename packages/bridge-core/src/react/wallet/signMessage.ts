// EIP-1193 provider helpers for the WalletConnect-only wallet layer:
// signMessage (with the signer-binding guard), shortenAddress, switchChain.
//
// Extracted from apps/web's wallet/ethereum.ts. The hex-encoding of the message
// in signMessage is BYTE-IDENTICAL to that implementation: it is the seed for
// in-browser key derivation (deriveStarknetPrivateKey / deriveViewingKey), so
// any change here would silently re-key every user. Do not "clean it up".

import { getAddress, isAddressEqual, recoverMessageAddress } from 'viem';
import { switchChain, type EthereumProvider, type AddChainParams } from '../../lib/ethereum';

export { switchChain, type EthereumProvider, type AddChainParams };

export function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export async function signMessage(
  provider: EthereumProvider,
  address: string,
  message: string,
): Promise<string> {
  // Hex-encode the UTF-8 message: passing a 0x string avoids wallet-specific
  // ambiguity over how a raw string is interpreted by personal_sign.
  const hexMessage =
    '0x' +
    Array.from(new TextEncoder().encode(message))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  // personal_sign param order is [data, address].
  const signature = (await provider.request({
    method: 'personal_sign',
    params: [hexMessage, address],
  })) as `0x${string}`;
  // Bind the signature to the connected account: recover the signer from the
  // exact bytes we sent and reject if the wallet signed with a DIFFERENT account
  // (e.g. the active account in the extension drifted from the one we connected).
  // All derivation downstream keys off this signature, so a foreign signature
  // would silently fund/control the wrong identity. Verifying here covers EVERY
  // caller.
  const recovered = await recoverMessageAddress({
    message: { raw: hexMessage as `0x${string}` },
    signature,
  });
  if (!isAddressEqual(getAddress(recovered), getAddress(address))) {
    throw new Error(
      `Signature came from a different account (${recovered}) than the connected account (${address}) — check which wallet/account is active in your extension.`,
    );
  }
  return signature;
}
