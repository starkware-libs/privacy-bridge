/**
 * Generic CCTP chain picker. A native <select> can't render a per-option icon, so this
 * is a small accessible custom dropdown: a trigger button (selected chain's icon + name)
 * opens a role="listbox" of the supported chains. Closes on outside-click / Escape. The
 * chosen chain is reported via onChange. Reused for BOTH directions: the deposit SOURCE
 * chain (Move Into Pool, #191 / #198) and the bridge-out DESTINATION chain (Move From
 * Pool) — pass `label` to set the accessible label ("Source chain" by default).
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ChainIcon } from './chainIcon';
import { styles } from './styles';

export interface SourceChainOption {
  chainId: number;
  chainName: string;
}

const triggerStyle: CSSProperties = {
  ...styles.input,
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  cursor: 'pointer',
  textAlign: 'left',
};

const listStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% - 0.5rem)',
  left: 0,
  right: 0,
  zIndex: 10,
  margin: 0,
  padding: '0.25rem',
  listStyle: 'none',
  background: '#1a1d27',
  border: '1px solid #2a2d3d',
  borderRadius: '6px',
  maxHeight: '14rem',
  overflowY: 'auto',
};

const optionStyle = (selected: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.45rem 0.6rem',
  borderRadius: '4px',
  cursor: 'pointer',
  fontSize: '0.9rem',
  color: '#e2e8f0',
  background: selected ? '#2a2d3d' : 'transparent',
});

export function SourceChainPicker({
  value,
  options,
  disabled = false,
  onChange,
  label = 'Source chain',
}: {
  value: number;
  options: SourceChainOption[];
  disabled?: boolean;
  onChange: (chainId: number) => void;
  // Accessible label for the trigger + listbox. Defaults to "Source chain" so the
  // deposit side (MoveIntoPool) is unchanged; MoveFromPool passes "Destination chain".
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape while open.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = options.find((o) => o.chainId === value);
  const selectedName = selected?.chainName ?? `Chain ${value}`;

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        type="button"
        style={triggerStyle}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${selectedName}`}
        onClick={() => setOpen((v) => !v)}
      >
        <ChainIcon chainId={value} />
        <span style={{ flex: 1 }}>{selectedName}</span>
        <span aria-hidden="true" style={{ color: '#94a3b8', fontSize: '0.7rem' }}>
          ▾
        </span>
      </button>
      {open && (
        <ul role="listbox" aria-label={label} style={listStyle}>
          {options.map((o) => (
            <li
              key={o.chainId}
              role="option"
              aria-selected={o.chainId === value}
              style={optionStyle(o.chainId === value)}
              onClick={() => {
                onChange(o.chainId);
                setOpen(false);
              }}
            >
              <ChainIcon chainId={o.chainId} />
              <span>{o.chainName}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
