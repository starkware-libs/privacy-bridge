// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// bridge-core/react — React hooks for bridge functionality.
// Wallet plumbing and identity hooks for both apps/bridge and apps/web.

export { useBridgeFundingEstimate, bridgeFundingEstimateHint } from './useBridgeFundingEstimate.js';
export type { BridgeFundingEstimate } from './useBridgeFundingEstimate.js';
// Card on-ramp funding phase machine (Slice E2) — moved out of DepositModal; owns
// the session/token/isLive invariant (baseline → widget → poll/grace → deposit).
export { useOnrampFunding } from './useOnrampFunding.js';
export type {
  UseOnrampFunding,
  OnrampPhase,
  OnrampSession,
  OnrampDepositArgs,
  OnrampFundingDeps,
  OnrampMessages,
} from './useOnrampFunding.js';
// Fee-estimate hook (Slice C) — moved out of DepositModal.
export { useDepositCctpFeeEstimate } from './useDepositCctpFeeEstimate.js';
export type { DepositCctpFeeEstimate } from './useDepositCctpFeeEstimate.js';
export { useWithdrawCctpFeeEstimate } from './useWithdrawCctpFeeEstimate.js';
export type { WithdrawCctpFeeEstimate } from './useWithdrawCctpFeeEstimate.js';

// Unified wallet layer: injected EIP-6963 extensions (MetaMask, Rabby, …) AND
// WalletConnect coexist behind one picker (selectProvider → getEthereumProvider →
// signMessage).
export { WalletProvider } from './wallet/WalletProvider.js';
export { useWallet } from './wallet/useWallet.js';
export type { WalletContextValue } from './wallet/types.js';
// shortenAddress + switchChain: the EIP-1193 helpers apps/web consumes alongside
// useWallet (switchChain runs the Polygon-leg chain switch off the connected
// provider in SellContext/TradeContext's wallet-trade path).
export { shortenAddress, switchChain } from './wallet/signMessage.js';
export type { EthereumProvider, AddChainParams } from './wallet/signMessage.js';
// EIP-6963 provider info type consumed by the app pickers (WalletModal/LoginModal).
export type { EIP6963ProviderInfo } from './wallet/injectedProvider.js';
