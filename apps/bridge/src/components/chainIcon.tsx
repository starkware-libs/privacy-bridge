/**
 * Inline SVG brand marks for the CCTP source chains, keyed by EIP-155 chain id
 * (mainnet + testnet share a brand). Self-contained (no external asset fetch — the
 * app's CSP would block a remote logo); simplified marks in each chain's brand
 * colour, enough to make the source-chain picker scannable. Unknown ids fall back to
 * a neutral disc so a newly-added chain still renders.
 */
import type { CSSProperties } from 'react';

type Brand = 'ethereum' | 'polygon' | 'base' | 'arbitrum' | 'optimism' | 'unknown';

// chainId → brand. Testnet ids map to the same brand as their mainnet counterpart.
const BRAND_BY_CHAIN: Record<number, Brand> = {
  1: 'ethereum',
  11155111: 'ethereum',
  137: 'polygon',
  80002: 'polygon',
  8453: 'base',
  84532: 'base',
  42161: 'arbitrum',
  421614: 'arbitrum',
  10: 'optimism',
  11155420: 'optimism',
};

export function ChainIcon({ chainId, size = 18 }: { chainId: number; size?: number }) {
  const brand = BRAND_BY_CHAIN[chainId] ?? 'unknown';
  const common: CSSProperties = { flexShrink: 0, display: 'block' };
  switch (brand) {
    case 'ethereum':
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} style={common} aria-hidden="true">
          <path fill="#627EEA" d="M12 2 6 12.22l6 3.54V2z" />
          <path fill="#8A9BF0" d="M12 2v13.76l6-3.54L12 2z" />
          <path fill="#627EEA" d="M12 16.9 6 13.36 12 21.82V16.9z" />
          <path fill="#8A9BF0" d="M12 21.82v-4.92l6-3.54-6 8.46z" />
        </svg>
      );
    case 'polygon':
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} style={common} aria-hidden="true">
          <path fill="#8247E5" d="M12 2.5 20 7v10l-8 4.5L4 17V7z" />
          <circle cx="12" cy="12" r="3.4" fill="#0f1117" />
        </svg>
      );
    case 'base':
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} style={common} aria-hidden="true">
          <circle cx="12" cy="12" r="9.5" fill="#0052FF" />
          <rect x="8.4" y="11" width="7.2" height="2" rx="1" fill="#fff" />
        </svg>
      );
    case 'arbitrum':
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} style={common} aria-hidden="true">
          <circle cx="12" cy="12" r="9.5" fill="#2D374B" />
          <path fill="#28A0F0" d="M12 5.2 16 14l-2 1.2L12 10 10 15.2 8 14z" />
        </svg>
      );
    case 'optimism':
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} style={common} aria-hidden="true">
          <circle cx="12" cy="12" r="9.5" fill="#FF0420" />
          <circle cx="9.4" cy="12" r="2.1" fill="none" stroke="#fff" strokeWidth="1.5" />
          <circle cx="14.6" cy="12" r="2.1" fill="none" stroke="#fff" strokeWidth="1.5" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} style={common} aria-hidden="true">
          <circle cx="12" cy="12" r="9.5" fill="#475569" />
        </svg>
      );
  }
}
