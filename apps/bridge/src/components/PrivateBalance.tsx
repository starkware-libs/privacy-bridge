// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

/**
 * Live private (in-pool) balance readout, shown at the top of the dashboard.
 *
 * Gates itself on a derived session (usePrivateBalance is idle until then) and
 * polls once per second. Errors are surfaced non-destructively: with a prior
 * value we keep showing it plus a muted "(updating…)" hint rather than a red box.
 */

import { config, formatUsdcCents } from '@starkware-libs/starknet-privacy-bridge';
import { usePrivateBalance } from '../usePrivateBalance';
import { styles } from './styles';

export function PrivateBalance() {
  const { balance, status } = usePrivateBalance();
  const { decimals, symbol } = config.depositToken;

  // Not derived yet — muted hint.
  if (status === 'idle') {
    return (
      <div style={styles.balanceCard}>
        <span style={styles.muted}>Sign to see your private balance</span>
      </div>
    );
  }

  // First value still loading (no prior balance).
  if (balance == null) {
    return (
      <div style={styles.balanceCard}>
        <span style={styles.muted}>
          {status === 'error' ? 'Private balance unavailable' : 'Loading private balance…'}
        </span>
      </div>
    );
  }

  return (
    <div style={styles.balanceCard}>
      <span style={styles.muted}>Private balance</span>
      <span style={styles.balanceValue}>
        {formatUsdcCents(balance, decimals)} {symbol}
      </span>
    </div>
  );
}
