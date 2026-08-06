// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SourceChainPicker } from './SourceChainPicker';

const OPTIONS = [
  { chainId: 80002, chainName: 'Polygon Amoy' },
  { chainId: 84532, chainName: 'Base Sepolia' },
  { chainId: 421614, chainName: 'Arbitrum Sepolia' },
];

describe('SourceChainPicker', () => {
  it('shows the selected chain and opens the option list on click', () => {
    render(<SourceChainPicker value={80002} options={OPTIONS} onChange={vi.fn()} />);
    // Collapsed: trigger names the selection, no listbox yet.
    expect(screen.getByRole('button', { name: /source chain: polygon amoy/i })).toBeTruthy();
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /source chain:/i }));
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('calls onChange with the picked chainId and closes the list', () => {
    const onChange = vi.fn();
    render(<SourceChainPicker value={80002} options={OPTIONS} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /source chain:/i }));
    fireEvent.click(screen.getByRole('option', { name: /arbitrum sepolia/i }));
    expect(onChange).toHaveBeenCalledWith(421614);
    expect(screen.queryByRole('listbox')).toBeNull(); // closed after select
  });

  it('closes on an outside click without selecting', () => {
    const onChange = vi.fn();
    render(
      <div>
        <SourceChainPicker value={80002} options={OPTIONS} onChange={onChange} />
        <button type="button">outside</button>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: /source chain:/i }));
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('uses a custom label for the trigger + listbox when provided', () => {
    render(
      <SourceChainPicker value={80002} options={OPTIONS} label="Destination chain" onChange={vi.fn()} />,
    );
    const trigger = screen.getByRole('button', { name: /destination chain: polygon amoy/i });
    expect(trigger).toBeTruthy();
    fireEvent.click(trigger);
    expect(screen.getByRole('listbox', { name: /destination chain/i })).toBeTruthy();
  });

  it('does not open when disabled', () => {
    render(<SourceChainPicker value={80002} options={OPTIONS} disabled onChange={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: /source chain:/i });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(trigger);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
