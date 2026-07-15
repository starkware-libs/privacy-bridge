import { useWallet, shortenAddress } from '@polymarket-privacy/bridge-core/react';
import { useNetwork } from '../NetworkContext';
import type { Network } from '@polymarket-privacy/bridge-core';
import { styles } from './styles';

export function NavBar() {
  const { isConnected, address, openLoginModal, disconnect } = useWallet();
  const { profile, switchBlocked, switchEnabled, setNetwork } = useNetwork();

  const target: Network = profile.network === 'mainnet' ? 'testnet' : 'mainnet';
  const targetLabel = target === 'mainnet' ? 'Mainnet' : 'Testnet';

  const handleToggle = () => {
    if (switchBlocked) return;
    // Confirm dialog: switching ends the session and clears the derived identity
    // on the current network. The user reconnects + re-derives on the new network.
    const ok = window.confirm(
      `Switch to ${targetLabel}?\n\n` +
        'This disconnects your wallet and clears your derived identity and ' +
        'balances on the current network. Finish any in-progress transfer first.',
    );
    if (!ok) return;
    setNetwork(target);
  };

  const badgeTitle = switchBlocked
    ? 'Cannot switch network while a transfer is in progress — finish it first.'
    : `Active: ${profile.starknetChain} + ${profile.polygonChain}. Click to switch to ${targetLabel}.`;

  return (
    <nav style={styles.nav}>
      <span style={styles.navBrand}>Privacy Bridge</span>

      <div style={styles.navRight}>
        {/* Network toggle — click to switch networks at runtime (confirm-gated).
            DISABLED while any flow is in-flight (fund-safety: a mid-CCTP switch
            would strand funds). See NetworkContext / InFlightContext.
            HIDDEN in prod (switchEnabled=false): prod points both networks at the
            same Starknet upstream, so the runtime switch is DEV-only (Bugbot
            MEDIUM). A prod build shows a STATIC, non-interactive network badge. */}
        {switchEnabled ? (
          <button
            type="button"
            onClick={handleToggle}
            disabled={switchBlocked}
            style={styles.networkBadge(profile.network, switchBlocked)}
            title={badgeTitle}
            aria-label={`Active network: ${profile.network}. ${
              switchBlocked ? 'Switching disabled while a transfer is in progress.' : `Click to switch to ${target}.`
            }`}
          >
            <span style={styles.networkDot(profile.network)} />
            {profile.network === 'testnet' ? 'Testnet' : 'Mainnet'}
          </button>
        ) : (
          <span
            style={styles.networkBadge(profile.network, true)}
            title={`Active network: ${profile.starknetChain} + ${profile.polygonChain}.`}
            aria-label={`Active network: ${profile.network}.`}
          >
            <span style={styles.networkDot(profile.network)} />
            {profile.network === 'testnet' ? 'Testnet' : 'Mainnet'}
          </span>
        )}

        {/* Chain labels */}
        <span style={styles.chainLabel}>
          {profile.starknetChain} / {profile.polygonChain}
        </span>

        {/* Wallet */}
        {isConnected && address ? (
          <button onClick={disconnect} style={styles.walletBtn} title="Click to disconnect">
            {shortenAddress(address)}
          </button>
        ) : (
          <button onClick={openLoginModal} style={styles.connectBtn}>
            Connect
          </button>
        )}
      </div>
    </nav>
  );
}
