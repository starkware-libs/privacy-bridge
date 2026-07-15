import { ec, hash } from 'starknet';
import { STARKNET_KEY_LABEL } from './messages.js';

// Deterministically derive a Starknet private key from an EVM wallet signature.
//
// The EVM signature is the only secret input; the label scopes this seed to the
// account-key domain (see VIEWING_KEY_LABEL for the sibling domain). `grindKey`
// rejection-samples the seed into the valid stark-curve range, returning a bare
// (no `0x`) hex string that strips leading zeros (often 63 nibbles). We
// normalize to a canonical 32-byte (64-nibble) lowercase 0x-hex string, mirroring
// derivePolygonEoa's padStart(64,'0'): the unpadded/odd-width body otherwise
// makes noble's hexToBytes throw and Buffer.from(body,'hex') truncate to 31
// bytes. Padding leading zeros leaves the scalar (and the derived address)
// unchanged.
export function deriveStarknetPrivateKey(evmSignature: string): string {
  const seed = hash.starknetKeccak(`${evmSignature}:${STARKNET_KEY_LABEL}`);
  const ground = ec.starkCurve.grindKey(`0x${seed.toString(16)}`);
  const scalar = BigInt(`0x${ground.replace(/^0x/, '')}`);
  return `0x${scalar.toString(16).padStart(64, '0')}`;
}

export interface StarknetAccount {
  publicKey: string;
  address: string;
}

// Derive the deployable account from a private key + the account class hash.
//
// Using the public key as the deployment salt makes the address a pure function
// of the key, so the user recovers the same account from the same signature
// without any stored state. Constructor calldata `[publicKey]` matches an
// OpenZeppelin-style account (single owner public key).
export function deriveStarknetAccount(privateKey: string, classHash: string): StarknetAccount {
  const publicKey = ec.starkCurve.getStarkKey(privateKey);
  const address = hash.calculateContractAddressFromHash(
    publicKey, // salt
    classHash,
    [publicKey], // constructor calldata
    0, // deployer address
  );
  return { publicKey, address };
}
