import type { EthereumProvider } from './signMessage';
import type { EIP6963ProviderInfo } from './injectedProvider';

// Unified wallet context value: injected EIP-6963 extensions (MetaMask, Rabby, …)
// AND WalletConnect coexist behind ONE picker. `connect(rdnsOrUuid?)` routes
// through the selected provider (backward-compatible: bare connect() uses the
// current selection / window.ethereum fallback / sole WC entry). `getProvider()`
// exposes the live provider for downstream permit/switchChain signing.
export type WalletContextValue = {
  // The wallets discovered via EIP-6963 (+ the synthetic WalletConnect entry), for
  // the picker in WalletModal/LoginModal. Only the serializable `info`
  // (name/icon/rdns/uuid) is exposed — the live provider object stays in the
  // injectedProvider module.
  providers: EIP6963ProviderInfo[];
  // rdns of the wallet the user picked + connected through, or null.
  selectedRdns: string | null;
  address: string | null;
  // EIP-155 chain id (decimal) the wallet is currently on, or null until read.
  // Updated on connect and on every wallet `chainChanged` event so the
  // Polygon-leg expectations can be gated against config.polygon.chainId.
  chainId: number | null;
  isConnecting: boolean;
  // rdns of the provider a connect() attempt is currently in flight for, or null.
  // Lets the picker show "Connecting…" on ONLY the button the user pressed
  // instead of every provider button (#134).
  connectingRdns: string | null;
  error: string | null;
  // True when a MetaMask extension is available (via EIP-6963 io.metamask rdns or
  // the window.ethereum.isMetaMask flag). Drives the picker's install-hint branch.
  hasMetaMask: boolean;
  isModalOpen: boolean;
  // True once an explicit session has been entered (Connect / Resume session).
  // Drives whether the connected/private UI is shown — see the CONNECT GATE note
  // in WalletProvider. Equivalent to `address !== null`.
  isConnected: boolean;
  // True when the wallet has already authorized an account (an injected session
  // or a rehydrated WC session) but the user has NOT entered the session this
  // visit. The app offers a one-click "Resume session" instead of a fresh Connect.
  canResume: boolean;
  // True when the live session was RESTORED from this device's recorded session (a
  // page refresh) rather than entered by a click this visit. Consumers must not fire
  // anything that needs a user GESTURE off a restored session — most importantly an
  // identity `personal_sign`, which would then pop unsolicited on every page load.
  // Offer it behind an explicit control instead. Cleared by a fresh connect/resume,
  // by a wallet-side account switch, and by disconnect.
  sessionRestored: boolean;
  openLoginModal: () => void;
  closeLoginModal: () => void;
  // Select the wallet (by rdns or uuid) and connect through it, entering the
  // session. Omitting the id connects via the current selection / window.ethereum
  // fallback (single-wallet case) or the sole WalletConnect entry. ALL subsequent
  // requests route to the picked provider (the multi-wallet pinning fix).
  connect: (rdnsOrUuid?: string) => Promise<void>;
  // Enter the session for an already-authorized (rehydrated) session without a
  // wallet prompt (falls back to the connect modal if nothing is authorized).
  resumeSession: () => void;
  // End the session AND wipe this device's persisted pmp.* state (Forget device).
  disconnect: () => void;
  requireWallet: () => boolean;
  signMessage: (message: string) => Promise<string>;
  // The live provider once resolved, or undefined (nothing selected / pre-init).
  // A later step needs it for SellContext permit signing / switchChain.
  getProvider: () => EthereumProvider | undefined;
};
