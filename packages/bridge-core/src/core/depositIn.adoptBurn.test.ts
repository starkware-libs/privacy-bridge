// A caller that submits the CCTP burn through an injected evmSender can learn the burn
// landed only AFTER its own process died (the receipt arrives out of band). Without a
// way to hand that confirmed burn to the resume machinery, the only alternatives are
// re-burning or telling the user to contact support.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adoptInflightDepositBurn, hasAnyInflightDeposit, readInflightDeposit } from './depositIn';

const EVM = '0x000000000000000000000000000000000000dEaD';
const RECORD = {
  burnTx: '0xb0b0b0',
  sourceDomain: 7,
  amountWei: '1000000',
  snRecipient: '0x49abc',
  evmChainId: 80002,
};

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('adoptInflightDepositBurn', () => {
  it('makes a confirmed burn resumable, and the switch guard sees it', () => {
    expect(adoptInflightDepositBurn(EVM, RECORD)).toBe(true);

    expect(readInflightDeposit(EVM)).toMatchObject(RECORD);
    expect(hasAnyInflightDeposit()).toBe(true);
  });

  it('works WITHOUT maxFee — a legacy-shaped cursor re-quotes on resume', () => {
    expect(adoptInflightDepositBurn(EVM, RECORD)).toBe(true);
    expect(readInflightDeposit(EVM)?.maxFee).toBeUndefined();
  });

  it('carries maxFee and the fold flag when the caller knows them', () => {
    adoptInflightDepositBurn(EVM, { ...RECORD, maxFee: '1000', fold: true });

    expect(readInflightDeposit(EVM)).toMatchObject({ maxFee: '1000', fold: true });
  });

  it('is idempotent for the SAME burn', () => {
    adoptInflightDepositBurn(EVM, RECORD);

    expect(adoptInflightDepositBurn(EVM, { ...RECORD, amountWei: '999' })).toBe(true);
    expect(readInflightDeposit(EVM)?.burnTx).toBe('0xb0b0b0');
  });

  it('N6: refuses when a cursor for a DIFFERENT burn already exists', () => {
    adoptInflightDepositBurn(EVM, RECORD);

    // Reporting `true` here would let the caller drop ITS handle on a second live burn.
    expect(adoptInflightDepositBurn(EVM, { ...RECORD, burnTx: '0xd1ffe6' })).toBe(false);
    expect(readInflightDeposit(EVM)?.burnTx).toBe('0xb0b0b0');
  });

  it('refuses a malformed record rather than persisting one that reads back as corrupt', () => {
    expect(adoptInflightDepositBurn(EVM, { ...RECORD, burnTx: 'not-hex' })).toBe(false);
    expect(readInflightDeposit(EVM)).toBeNull();
  });
});
