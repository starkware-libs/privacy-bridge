import { useEffect } from 'react';
import { useWallet, shortenAddress } from '@starkware-libs/starknet-privacy-bridge/react';
import { NavBar } from './components/NavBar';
import { LoginModal } from './components/LoginModal';
import { MoveIntoPool } from './components/MoveIntoPool';
import { MoveFromPool } from './components/MoveFromPool';
import { PrivateBalance } from './components/PrivateBalance';
import { useIdentity } from './IdentityContext';
import { styles } from './components/styles';

/** Auto-derive identity once per connected address (mirrors apps/web SessionEffect). */
function SessionEffect() {
  const { isConnected, address, sessionRestored } = useWallet();
  const { snAddress, deriveStatus, deriveIdentity } = useIdentity();
  // Trigger once when a new address connects and we don't yet have keys.
  useEffect(() => {
    if (!isConnected || !address) return;
    if (snAddress || deriveStatus.status !== 'idle') return;
    // A session RESTORED across a page refresh had no user gesture behind it, so
    // prompting here would open a personal_sign popup unbidden on every page load.
    // The dashboard offers the sign button instead (see needsSign there).
    if (sessionRestored) return;
    void deriveIdentity();
  }, [isConnected, address, sessionRestored, snAddress, deriveStatus.status, deriveIdentity]);
  return null;
}

function ConnectedDashboard() {
  const { address } = useWallet();
  const { snAddress, deriveStatus, deriveIdentity } = useIdentity();
  // Connected but keyless and nothing in flight — either a failed/rejected derive, or a
  // session restored across a refresh (which deliberately does NOT auto-prompt). Both need
  // the same explicit affordance, or a restored session strands with no way to sign in.
  const needsSign = !snAddress && (deriveStatus.status === 'error' || deriveStatus.status === 'idle');

  return (
    <div style={styles.page}>
      {/* EVM address */}
      <div style={{ ...styles.muted, fontFamily: 'monospace', marginBottom: '0.5rem', wordBreak: 'break-all' }}>
        Wallet: {address ? shortenAddress(address) : '—'}
      </div>

      {/* Live private (in-pool) balance — gates itself on a derived session. */}
      <PrivateBalance />

      {/* SN identity status */}
      {deriveStatus.status === 'pending' && (
        <p style={{ ...styles.muted, marginBottom: '1rem' }}>Deriving identity…</p>
      )}
      {needsSign && (
        <div style={{ marginBottom: '1rem' }}>
          {deriveStatus.status === 'error' && (
            <div style={styles.statusBox('error')}>{deriveStatus.message}</div>
          )}
          <button
            onClick={() => void deriveIdentity()}
            style={{ ...styles.primaryBtn, marginTop: '0.5rem' }}
          >
            Sign to derive identity
          </button>
        </div>
      )}

      {/* Flows */}
      <MoveIntoPool />
      <MoveFromPool />
    </div>
  );
}

export function App() {
  const { isConnected, openLoginModal } = useWallet();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <NavBar />
      <LoginModal />
      <SessionEffect />
      <main style={{ flex: 1 }}>
        {isConnected ? (
          <ConnectedDashboard />
        ) : (
          <div
            style={{
              ...styles.page,
              textAlign: 'center',
              paddingTop: '4rem',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
            }}
          >
            <h2 style={{ marginBottom: '0.75rem', fontSize: '1.4rem' }}>Privacy Bridge</h2>
            <p
              style={{
                ...styles.muted,
                marginBottom: '1.5rem',
                maxWidth: '360px',
              }}
            >
              Move USDC bidirectionally between EVM wallets and the starknet-privacy pool.
              Polymarket-free.
            </p>
            <button
              onClick={openLoginModal}
              style={{
                ...styles.connectBtn,
                fontSize: '1rem',
                padding: '0.65rem 1.5rem',
              }}
            >
              Connect Wallet
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
