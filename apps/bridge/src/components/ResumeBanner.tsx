/**
 * Interrupted-transfer banner shared by MoveIntoPool/MoveFromPool: shows the
 * detected resume status, then either a resuming spinner or an error + manual
 * Continue button. Purely presentational over a `BridgeResume` value.
 */
import type { BridgeResume } from '../useBridgeResume';
import { formatResumeAmount, phaseLabel } from '../useBridgeResume';
import { styles } from './styles';

export function ResumeBanner({ resume }: { resume: BridgeResume }) {
  if (!resume.status) return null;
  // Phase-aware label: an into-pool deposit resume reads as "Continue deposit"; every
  // other phase keeps the generic "Continue transfer". Purely presentational.
  const isDeposit = resume.status.phase === 'pool-deposit' || resume.status.phase === 'cctp-mint-in';
  const continueLabel = isDeposit ? 'Continue deposit' : 'Continue transfer';
  return (
    <div>
      <p style={{ ...styles.muted, marginBottom: '0.5rem' }}>
        Interrupted transfer detected — {phaseLabel(resume.status.phase)}{' '}
        {formatResumeAmount(resume.status.amountWei)} USDC.
      </p>
      {resume.resuming ? (
        <>
          <div style={styles.statusBox('info')}>
            Resuming interrupted transfer…
            {resume.step ? ` ${resume.step}` : ''}
          </div>
          {/* A resume needs the identity signature again after a reload; if the
              wallet prompt is ignored it can sit here. A hard reload re-detects the
              cursor and safely re-continues (the concurrency guard makes an in-flight
              manual click a no-op, so a reload — not a button — is the real escape). */}
          <p style={{ ...styles.muted, marginTop: '0.5rem' }}>
            Taking longer than expected? Check your wallet for a signature prompt, or
            reload the page to retry.
          </p>
        </>
      ) : (
        <>
          {resume.error && <div style={styles.statusBox('error')}>{resume.error}</div>}
          <button
            onClick={() => resume.resume(true)}
            style={{ ...styles.primaryBtn, marginTop: resume.error ? '0.5rem' : '0.25rem' }}
          >
            {continueLabel}
          </button>
        </>
      )}
    </div>
  );
}
