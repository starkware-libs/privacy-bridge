import { afterEach, describe, expect, it } from 'vitest';
import { spyOnSecretSinks } from './secretSinks';

describe('spyOnSecretSinks', () => {
  afterEach(() => {
    // Nothing to clean up if a test already called restore(); double-restore is safe
    // because vi.spyOn mocks no-op past their first mockRestore().
  });

  it('does not flag anything when no secret ever reaches console/storage', () => {
    const sinks = spyOnSecretSinks();
    console.log('deploy step done');
    localStorage.setItem('pmp.step', 'done');
    expect(() => sinks.assertNeverLeaked('0xdeadbeef-signature')).not.toThrow();
    sinks.restore();
  });

  it('catches a raw signature leaked via console.log', () => {
    const sinks = spyOnSecretSinks();
    const signature = '0xdeadbeef-signature';
    // eslint-disable-next-line no-console -- deliberate fixture, proving the spy catches it
    console.log('signing done', signature);
    expect(() => sinks.assertNeverLeaked(signature)).toThrow(/leaked/);
    sinks.restore();
  });

  it('catches a secret nested inside an object argument', () => {
    const sinks = spyOnSecretSinks();
    const privateKey = '0xabc123-private-key';
    console.error({ context: 'derive failed', privateKey });
    expect(() => sinks.assertNeverLeaked(privateKey)).toThrow(/leaked/);
    sinks.restore();
  });

  it('catches a secret persisted to localStorage', () => {
    const sinks = spyOnSecretSinks();
    const signature = '0xsig-in-storage';
    localStorage.setItem('pmp.debug', signature);
    expect(() => sinks.assertNeverLeaked(signature)).toThrow(/leaked/);
    sinks.restore();
  });

  it('restores console after restore()', () => {
    const original = console.log;
    const sinks = spyOnSecretSinks();
    expect(console.log).not.toBe(original);
    sinks.restore();
    expect(console.log).toBe(original);
  });
});
