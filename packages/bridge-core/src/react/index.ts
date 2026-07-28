// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// bridge-core/react — React hooks for bridge functionality.
// Wallet plumbing and identity hooks for both apps/bridge and apps/web.

export { useBridgeFundingEstimate, bridgeFundingEstimateHint } from './useBridgeFundingEstimate';
export type { BridgeFundingEstimate } from './useBridgeFundingEstimate';
// Card on-ramp funding phase machine (Slice E2) — moved out of DepositModal; owns
// the session/token/isLive invariant (baseline → widget → poll/grace → deposit).
export { useOnrampFunding } from './useOnrampFunding';
export type {
  UseOnrampFunding,
  OnrampPhase,
  OnrampSession,
  OnrampDepositArgs,
  OnrampFundingDeps,
  OnrampMessages,
} from './useOnrampFunding';
// Fee-estimate hook (Slice C) — moved out of DepositModal.
export { useDepositCctpFeeEstimate } from './useDepositCctpFeeEstimate';
export type { DepositCctpFeeEstimate } from './useDepositCctpFeeEstimate';
export { useWithdrawCctpFeeEstimate } from './useWithdrawCctpFeeEstimate';
export type { WithdrawCctpFeeEstimate } from './useWithdrawCctpFeeEstimate';

// Unified wallet layer: injected EIP-6963 extensions (MetaMask, Rabby, …) AND
// WalletConnect coexist behind one picker (selectProvider → getEthereumProvider →
// signMessage). See docs/architecture.md Key decisions.
export { WalletProvider } from './wallet/WalletProvider';
export { useWallet } from './wallet/useWallet';
export type { WalletContextValue } from './wallet/types';
// shortenAddress + switchChain: the EIP-1193 helpers apps/web consumes alongside
// useWallet (switchChain runs the Polygon-leg chain switch off the connected
// provider in SellContext/TradeContext's wallet-trade path).
export { shortenAddress, switchChain } from './wallet/signMessage';
export type { EthereumProvider, AddChainParams } from './wallet/signMessage';
// EIP-6963 provider info type consumed by the app pickers (WalletModal/LoginModal).
export type { EIP6963ProviderInfo } from './wallet/injectedProvider';
