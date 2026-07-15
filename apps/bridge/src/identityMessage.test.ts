import { describe, expect, it } from 'vitest';
import { BRIDGE_IDENTITY_SIGN_MESSAGE } from './identityMessage';

describe('BRIDGE_IDENTITY_SIGN_MESSAGE', () => {
  it('binds this app to its own identity domain and pins a version', () => {
    expect(BRIDGE_IDENTITY_SIGN_MESSAGE).toMatch(/Version: 2/);
    expect(BRIDGE_IDENTITY_SIGN_MESSAGE.toLowerCase()).toContain('bridge');
    expect(BRIDGE_IDENTITY_SIGN_MESSAGE.toLowerCase()).toContain('starknet');
    // Reassures the user it is off-chain / gasless.
    expect(BRIDGE_IDENTITY_SIGN_MESSAGE.toLowerCase()).toContain('gas');
  });
});
