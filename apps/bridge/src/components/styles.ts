/**
 * Inline style tokens for apps/bridge. Kept as a single module so each
 * component doesn't repeat colours. No external CSS-in-JS dep — plain objects.
 */
import type { CSSProperties } from 'react';
import type { Network } from '@polymarket-privacy/bridge-core';

const CLR = {
  bg: '#0f1117',
  surface: '#1a1d27',
  border: '#2a2d3d',
  text: '#e2e8f0',
  muted: '#94a3b8',
  primary: '#6366f1',
  primaryHover: '#4f52d4',
  testnet: '#f59e0b',
  mainnet: '#22c55e',
  danger: '#ef4444',
  dangerHover: '#dc2626',
};

export const styles = {
  nav: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.75rem 1.5rem',
    background: CLR.surface,
    borderBottom: `1px solid ${CLR.border}`,
  } satisfies CSSProperties,

  navBrand: {
    fontWeight: 700,
    fontSize: '1.1rem',
    letterSpacing: '-0.01em',
  } satisfies CSSProperties,

  navRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
  } satisfies CSSProperties,

  // Interactive network toggle. `disabled` (in-flight) dims it + shows not-allowed.
  networkBadge: (network: Network, disabled = false): CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '0.35rem',
    padding: '0.25rem 0.6rem',
    borderRadius: '999px',
    fontSize: '0.75rem',
    fontWeight: 600,
    letterSpacing: '0.02em',
    border: `1px solid ${network === 'mainnet' ? CLR.mainnet : CLR.testnet}`,
    background: 'transparent',
    color: network === 'mainnet' ? CLR.mainnet : CLR.testnet,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    font: 'inherit',
  }),

  networkDot: (network: Network): CSSProperties => ({
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    background: network === 'mainnet' ? CLR.mainnet : CLR.testnet,
    display: 'inline-block',
  }),

  chainLabel: {
    fontSize: '0.72rem',
    color: CLR.muted,
    display: 'none',
  } satisfies CSSProperties,

  walletBtn: {
    padding: '0.35rem 0.75rem',
    borderRadius: '6px',
    border: `1px solid ${CLR.border}`,
    background: CLR.surface,
    color: CLR.text,
    fontSize: '0.82rem',
    fontFamily: 'monospace',
    cursor: 'pointer',
  } satisfies CSSProperties,

  connectBtn: {
    padding: '0.35rem 0.75rem',
    borderRadius: '6px',
    border: 'none',
    background: CLR.primary,
    color: '#fff',
    fontSize: '0.85rem',
    fontWeight: 600,
    cursor: 'pointer',
  } satisfies CSSProperties,

  // Page layout
  page: {
    flex: 1,
    padding: '2rem 1.5rem',
    maxWidth: '680px',
    margin: '0 auto',
    width: '100%',
  } satisfies CSSProperties,

  // Card
  card: {
    background: CLR.surface,
    border: `1px solid ${CLR.border}`,
    borderRadius: '10px',
    padding: '1.5rem',
    marginBottom: '1.25rem',
  } satisfies CSSProperties,

  cardTitle: {
    fontWeight: 700,
    fontSize: '0.95rem',
    marginBottom: '1rem',
    color: CLR.text,
  } satisfies CSSProperties,

  // Form elements
  label: {
    display: 'block',
    fontSize: '0.78rem',
    color: CLR.muted,
    marginBottom: '0.35rem',
  } satisfies CSSProperties,

  input: {
    width: '100%',
    padding: '0.55rem 0.75rem',
    borderRadius: '6px',
    border: `1px solid ${CLR.border}`,
    background: CLR.bg,
    color: CLR.text,
    fontSize: '0.9rem',
    outline: 'none',
    marginBottom: '0.75rem',
    fontFamily: 'monospace',
  } satisfies CSSProperties,

  primaryBtn: {
    width: '100%',
    padding: '0.65rem',
    borderRadius: '6px',
    border: 'none',
    background: CLR.primary,
    color: '#fff',
    fontSize: '0.9rem',
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: '0.25rem',
  } satisfies CSSProperties,

  disabledBtn: {
    width: '100%',
    padding: '0.65rem',
    borderRadius: '6px',
    border: 'none',
    background: CLR.border,
    color: CLR.muted,
    fontSize: '0.9rem',
    fontWeight: 600,
    cursor: 'not-allowed',
    marginTop: '0.25rem',
  } satisfies CSSProperties,

  statusBox: (variant: 'info' | 'error' | 'success'): CSSProperties => ({
    padding: '0.65rem 0.85rem',
    borderRadius: '6px',
    fontSize: '0.82rem',
    marginTop: '0.75rem',
    background:
      variant === 'error'
        ? '#3b1a1a'
        : variant === 'success'
          ? '#1a3b25'
          : '#1a2040',
    color:
      variant === 'error'
        ? CLR.danger
        : variant === 'success'
          ? CLR.mainnet
          : CLR.primary,
    border: `1px solid ${
      variant === 'error' ? CLR.danger : variant === 'success' ? CLR.mainnet : CLR.primary
    }`,
    wordBreak: 'break-all',
  }),

  estimateRow: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '0.8rem',
    color: CLR.muted,
    marginBottom: '0.35rem',
  } satisfies CSSProperties,

  muted: {
    color: CLR.muted,
    fontSize: '0.82rem',
  } satisfies CSSProperties,

  // Compact card for the live private-balance readout at the top of the
  // dashboard. Same surface/border idiom as `card`, but banner-tight.
  balanceCard: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: '0.75rem',
    padding: '0.7rem 0.95rem',
    borderRadius: '8px',
    background: CLR.surface,
    border: `1px solid ${CLR.border}`,
    marginBottom: '0.75rem',
  } satisfies CSSProperties,

  balanceValue: {
    fontFamily: 'monospace',
    fontWeight: 700,
    fontSize: '1rem',
    color: CLR.text,
  } satisfies CSSProperties,
};
