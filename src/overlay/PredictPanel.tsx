import { useEffect, useState } from 'react';
import type { PredictFlowEvent, PredictFlowState } from '../machines/predictFlow';
import { verifyCommitment, type Commitment } from '../predict/commitment';
import type { Prediction } from '../predict/prediction';
import type { RevealOutcome } from '../predict/reveal';

interface Props {
  readonly state: PredictFlowState;
  readonly prediction: Prediction | null;
  readonly commitment: Commitment | null;
  /** The scored reveal: pending while the clip plays on, final in `result`. */
  readonly outcome: RevealOutcome | null;
  readonly error: string | null;
  readonly onPredict: () => void;
  readonly onReveal: () => void;
  readonly send: (event: PredictFlowEvent) => void;
}

const cm = (v: number | null | undefined, digits = 2) => (v === null || v === undefined ? '—' : `${v.toFixed(digits)} cm`);
const RED = '#b91c1c';
const GREEN = '#15803d';

function PredictionSummary({ prediction }: { prediction: Prediction }) {
  const { nominal, band } = prediction;
  return (
    <p>
      Predicted <strong>{band.kind}</strong> at x {cm(nominal.event.x, 1)} (band {band.x[0].toFixed(1)}–{band.x[1].toFixed(1)} cm), t{' '}
      {nominal.event.t.toFixed(3)} s after release (band {band.t[0].toFixed(3)}–{band.t[1].toFixed(3)} s); {band.agreeing} of {band.total}{' '}
      sampled runs agree. Horizon {prediction.horizonEndSec.toFixed(3)} s.
    </p>
  );
}

function OutcomeView({ outcome, verified }: { outcome: RevealOutcome; verified: boolean | null }) {
  const { event, end, trajectory } = outcome;
  const rows: [string, string][] = [
    [
      `Event (${event.predicted.kind})`,
      event.real
        ? `${cm(event.errorCm)} · ${event.errorPx?.toFixed(1)} px${event.errorMs === null ? '' : ` · ${event.errorMs.toFixed(1)} ms (real minus predicted)`}`
        : 'did not happen before the horizon',
    ],
    ['Position at the horizon', end.real ? `${cm(end.errorCm)} · ${end.errorPx?.toFixed(1)} px` : 'ball not tracked there'],
    [
      'Trajectory RMS, freeze to horizon',
      trajectory.rmsMm === null ? '—' : `${trajectory.rmsMm.toFixed(1)} mm · ${trajectory.rmsPx?.toFixed(1)} px over ${trajectory.points} points`,
    ],
  ];
  return (
    <div>
      <p style={{ color: event.insideBand ? GREEN : RED, fontWeight: 600 }}>
        {event.insideBand ? 'Reality landed inside the band.' : 'Reality landed OUTSIDE the band.'}
      </p>
      <table style={{ borderCollapse: 'collapse', fontSize: 14 }}>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th style={{ textAlign: 'left', paddingRight: 16 }}>{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Commitment re-checked against the prediction:{' '}
        {verified === null ? 'checking…' : verified ? <span style={{ color: GREEN }}>matches ✓</span> : <span style={{ color: RED }}>does not match ✗</span>}
      </p>
    </div>
  );
}

/**
 * The predict step under the overlay: freeze and predict, show the
 * commitment while the clip is held, reveal, then the errors.
 */
export function PredictPanel({ state, prediction, commitment, outcome, error, onPredict, onReveal, send }: Props) {
  const [verified, setVerified] = useState<boolean | null>(null);
  useEffect(() => {
    if (state !== 'result' || !commitment || !prediction) return;
    let cancelled = false;
    void verifyCommitment(commitment, prediction).then((ok) => {
      if (!cancelled) setVerified(ok);
    });
    return () => {
      cancelled = true;
      setVerified(null);
    };
  }, [state, commitment, prediction]);

  return (
    <section aria-live="polite" style={{ border: '1px solid #cbd5e1', borderRadius: 8, padding: 12, margin: '12px 0' }}>
      <h3 style={{ marginTop: 0 }}>Predict</h3>
      {state === 'frozen' && (
        <>
          <p>
            The fitted parameters are frozen. Predicting runs the twin past the freeze, plus 12 runs sampled within the fit's uncertainty, and
            publishes a hash of the prediction before any footage after the freeze plays.
          </p>
          <button type="button" onClick={onPredict}>
            Freeze and predict
          </button>
        </>
      )}
      {state === 'predicting' && <p>Running 12 futures and hashing the prediction…</p>}
      {state === 'failed' && (
        <>
          <p role="alert">Could not predict: {error}</p>
          <button type="button" onClick={() => send({ type: 'RESET' })}>
            Back
          </button>
        </>
      )}
      {prediction && commitment && (state === 'committed' || state === 'revealing' || state === 'result') && (
        <>
          <p>
            Commitment <code style={{ fontSize: 15, fontWeight: 600 }}>{commitment.short}</code> (SHA-256{' '}
            <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{commitment.hash}</code>), published {commitment.committedAt}.
          </p>
          <PredictionSummary prediction={prediction} />
        </>
      )}
      {state === 'committed' && (
        <button type="button" onClick={onReveal}>
          Reveal: play the real footage past the freeze
        </button>
      )}
      {state === 'revealing' && (
        <p>
          Playing the footage past the freeze…{' '}
          {outcome && (
            <button type="button" onClick={() => send({ type: 'REVEAL_DONE', outcome })}>
              Show the result now
            </button>
          )}
        </p>
      )}
      {state === 'result' && outcome && (
        <>
          <OutcomeView outcome={outcome} verified={verified} />
          <button type="button" onClick={() => send({ type: 'RESET' })}>
            Predict again
          </button>
        </>
      )}
    </section>
  );
}
