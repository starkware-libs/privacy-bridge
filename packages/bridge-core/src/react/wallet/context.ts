import { createContext } from 'react';
import type { WalletContextValue } from './types';

export const WalletContext = createContext<WalletContextValue | null>(null);
