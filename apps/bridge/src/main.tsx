// MUST be first: injects the app's env into bridge-core (Slice X) before any module
// reads bridge-core `config`.
import './initBridge';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WalletProvider } from '@starkware-libs/starknet-privacy-bridge/react';
import { InFlightProvider } from './InFlightContext';
import { NetworkProvider } from './NetworkContext';
import { IdentityProvider } from './IdentityContext';
import { App } from './App';
import { installDebugLogging, installLogSink } from './debug';
import './index.css';

installLogSink(); // dev-only console→file mirror (VITE_DEBUG_SINK); no-op when unset
installDebugLogging();

const root = document.getElementById('root');
if (!root) throw new Error('root element #root not found');

// Provider order: WalletProvider (EVM transport) → InFlightProvider (flow signal,
// read by NetworkProvider's switch guard) → NetworkProvider (runtime network swap;
// needs useWallet().disconnect + useInFlight()) → IdentityProvider (derived session;
// wiped on a network switch via NetworkContext.networkEpoch).
createRoot(root).render(
  <StrictMode>
    <WalletProvider>
      <InFlightProvider>
        <NetworkProvider>
          <IdentityProvider>
            <App />
          </IdentityProvider>
        </NetworkProvider>
      </InFlightProvider>
    </WalletProvider>
  </StrictMode>,
);
