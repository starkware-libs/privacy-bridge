// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { createContext } from 'react';
import type { WalletContextValue } from './types.js';

export const WalletContext = createContext<WalletContextValue | null>(null);
