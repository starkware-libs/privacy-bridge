// The signature message this app asks the wallet to sign — the sole secret input
// to identity derivation. App-owned (the SDK carries no app branding): the string
// IS the identity domain, so changing a byte (text or "Version") re-derives every
// key and orphans existing funds. Never edit except via a deliberate migration.
//
// A separate identity domain from the trade app's message (isolated by design):
// distinct first line + Version.
export const BRIDGE_IDENTITY_SIGN_MESSAGE = [
  'Enter the privacy pool bridge — derive Starknet keys',
  '',
  'Sign this message to deterministically derive your Starknet account and',
  'privacy-pool viewing key in your browser. The signature never leaves this',
  'device and no keys are stored.',
  '',
  'This is an off-chain signature. It is not a transaction and costs no gas.',
  '',
  'Version: 2',
].join('\n');
