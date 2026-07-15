import { useWallet } from '@polymarket-privacy/bridge-core/react';
import { useNetwork } from '../NetworkContext';
import { styles } from './styles';

/**
 * Unified connect modal for apps/bridge: one button per discovered wallet —
 * injected EIP-6963 extensions (MetaMask, Rabby, …) AND the synthetic
 * WalletConnect entry. Picking one PINS all subsequent requests to that provider
 * (the multi-wallet fix); WalletConnect opens its own QR modal on click.
 */
export function LoginModal() {
  const {
    isModalOpen,
    closeLoginModal,
    connect,
    isConnecting,
    connectingRdns,
    error,
    hasMetaMask,
    providers,
  } = useWallet();
  const { profile } = useNetwork();

  if (!isModalOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={closeLoginModal}
      role="dialog"
      aria-modal="true"
      aria-label="Connect wallet"
    >
      <div
        style={{
          background: '#1a1d27',
          border: '1px solid #2a2d3d',
          borderRadius: '12px',
          padding: '2rem',
          maxWidth: '340px',
          width: '90%',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ marginBottom: '0.5rem', fontSize: '1.1rem', fontWeight: 700 }}>
          Connect wallet
        </h2>
        <p style={styles.muted}>
          Network: {profile.starknetChain} / {profile.polygonChain}
        </p>

        {error && (
          <div style={{ ...styles.statusBox('error'), marginTop: '1rem' }}>{error}</div>
        )}

        {providers.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '1.25rem' }}>
            {providers.map((p) => (
              <button
                key={p.uuid}
                onClick={() => void connect(p.rdns)}
                disabled={isConnecting}
                style={{
                  ...styles.primaryBtn,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  justifyContent: 'center',
                  opacity: isConnecting ? 0.6 : 1,
                }}
              >
                <img src={p.icon} alt="" aria-hidden width={20} height={20} />
                {isConnecting && connectingRdns === p.rdns ? 'Connecting…' : p.name}
              </button>
            ))}
          </div>
        ) : hasMetaMask ? (
          <button
            onClick={() => void connect()}
            disabled={isConnecting}
            style={{ ...styles.primaryBtn, marginTop: '1.25rem', opacity: isConnecting ? 0.6 : 1 }}
          >
            {isConnecting ? 'Connecting…' : 'Connect MetaMask'}
          </button>
        ) : (
          <p style={{ ...styles.muted, marginTop: '1.25rem' }}>
            No EVM wallet detected. Install{' '}
            <a href="https://metamask.io/download/" target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa' }}>
              MetaMask
            </a>{' '}
            or a WalletConnect-compatible wallet, then refresh.
          </p>
        )}

        <button
          onClick={closeLoginModal}
          style={{
            ...styles.disabledBtn,
            marginTop: '0.5rem',
            background: 'transparent',
            border: '1px solid #2a2d3d',
            color: '#94a3b8',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
