import { useEffect, useReducer, useRef, useState, type FormEvent } from 'react';
import { muRampRollingThreshold } from '../fit/fitter';
import type { FitWorkerMessage } from '../fit/fitWorkerProtocol';
import { DEFAULT_WINDOW_END_SEC } from '../fit/recover';
import { SEGMENT_NAMES } from '../fit/segments';
import { describeShift, type FitLogEntry } from '../fit/session';
import { rollRadians } from '../scene/calibration';
import { DEFAULT_SIM_PARAMS, type SimParams } from '../sim/params';
import { initRapier } from '../sim/sceneWorld';
import { DEFAULT_FPS } from '../tracks/trajectories';
import { ballTrajectory, fitRequestForOverlay, loadOverlayData, withParams, type OverlayData } from './overlayData';
import { initialOverlayPageState, overlayPageReducer, type FitReport } from './overlayPageState';
import { OverlayPlayer } from './OverlayPlayer';

const EDITABLE: readonly { key: 'muRamp' | 'muTable' | 'restitution'; label: string }[] = [
  { key: 'muRamp', label: 'μ ramp' },
  { key: 'muTable', label: 'μ table' },
  { key: 'restitution', label: 'e (bounce)' },
];

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const mm = (cm: number) => `${(cm * 10).toFixed(2)} mm`;

const LOG_COLOURS: Record<FitLogEntry['kind'], string> = {
  agent: '#0e7490',
  tool: '#475569',
  numeric: '#475569',
  score: '#111827',
  error: '#b91c1c',
};

function FitLog({ log }: { log: readonly FitLogEntry[] }) {
  return (
    <ol aria-label="Fit log" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, maxHeight: 240, overflowY: 'auto' }}>
      {log.map((entry, i) => (
        <li key={i} style={{ color: LOG_COLOURS[entry.kind] }}>
          <strong>{entry.kind}</strong> {entry.text}
        </li>
      ))}
    </ol>
  );
}

function FitReportView({ report }: { report: FitReport }) {
  const { best } = report;
  const mu =
    report.muRampLowerBound === null
      ? `μ ramp ${best.params.muRamp.toFixed(3)}`
      : `μ ramp ≥ ${report.muRampLowerBound.toFixed(3)} (the ball rolls without slipping, so only a lower bound)`;
  return (
    <div>
      <p>
        Fitted on the first {DEFAULT_WINDOW_END_SEC.toFixed(1)} s after release ({report.mode === 'agent' ? 'Muse Spark agent + Nelder–Mead' : 'Nelder–Mead only'},{' '}
        {report.iterations} iterations, {report.reason === 'converged' ? 'converged' : 'iteration budget spent'}): {mu}, e{' '}
        {best.params.restitution.toFixed(3)}, release {describeShift(best.timeShiftSec)} from the detected one; RMS{' '}
        {mm(best.rmsCm)}.
      </p>
      <p>RMS per iteration: {report.rmsCm.map(mm).join(' → ')}</p>
      <table style={{ borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr>
            {['Segment', 'Points', 'RMS', 'Mean offset x, y (sim − real)', 'Worst'].map((h) => (
              <th key={h} style={{ textAlign: 'left', paddingRight: 16 }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SEGMENT_NAMES.map((name) => {
            const seg = best.segments[name];
            return (
              <tr key={name}>
                <td>{name}</td>
                <td>{seg?.points ?? 0}</td>
                <td>{seg ? mm(seg.rmsCm) : '—'}</td>
                <td>{seg ? `${mm(seg.meanOffsetCm.x)}, ${mm(seg.meanOffsetCm.y)}` : '—'}</td>
                <td>{seg ? mm(seg.maxCm) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <FitLog log={report.log} />
    </div>
  );
}

function Summary({ data }: { data: OverlayData }) {
  const ball = ballTrajectory(data);
  const cal = data.calibration;
  return (
    <ul>
      <li>
        Scale {cal.pixelsPerCm.toFixed(2)} px/cm, camera roll {((rollRadians(cal) * 180) / Math.PI).toFixed(2)}°
      </li>
      <li>
        Ball tracked on {ball?.points.length ?? 0} frames; {ball?.lowConfidenceFrames.length ?? 0} dropped for low
        confidence, {ball?.missingFrames.length ?? 0} missing; {data.droppedRecords} malformed records
      </li>
      <li>Release at {data.releaseSec.toFixed(3)} s (the simulation's t = 0): detected from the track, refined by a fit</li>
    </ul>
  );
}

/**
 * Day-2 overlay page: plays a local clip with SAM masks, the measured ball
 * trail and the simulated ball drawn over it. Takes the files the smoke
 * scripts write, or the synthetic set from `scripts/make-synthetic-clip.ts`.
 */
export function OverlayPage() {
  const [state, dispatch] = useReducer(overlayPageReducer, initialOverlayPageState);
  const [params, setParams] = useState<SimParams>(DEFAULT_SIM_PARAMS);
  const [useAgent, setUseAgent] = useState(true);
  const videoUrl = state.status === 'ready' || state.status === 'fitting' ? state.videoUrl : null;
  const urlRef = useRef<string | null>(null);

  // Free the previous clip's object URL whenever a new one replaces it, and on unmount.
  useEffect(() => {
    const previous = urlRef.current;
    urlRef.current = videoUrl;
    if (previous && previous !== videoUrl) URL.revokeObjectURL(previous);
  }, [videoUrl]);
  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  // The fit runs in a Web Worker per fit; leaving `fitting` (or the page) terminates it.
  const fittingData = state.status === 'fitting' ? state.data : null;
  useEffect(() => {
    if (!fittingData) return;
    const worker = new Worker(new URL('../fit/fit.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<FitWorkerMessage>) => {
      const msg = event.data;
      if (msg.type === 'log') dispatch({ type: 'FIT_LOG', entry: msg.entry });
      else if (msg.type === 'progress') dispatch({ type: 'FIT_PROGRESS', rmsCm: msg.progress.evaluation.rmsCm });
      else if (msg.type === 'failed') dispatch({ type: 'FIT_FAILED', message: msg.message });
      else {
        const { best, history, log, loop } = msg.result;
        const threshold = muRampRollingThreshold(fittingData.world);
        setParams(best.params);
        dispatch({
          type: 'FITTED',
          // The fit's release correction moves the simulation's start on the clip with it.
          data: { ...withParams(fittingData, best.params), releaseSec: fittingData.releaseSec + best.timeShiftSec },
          report: {
            mode: loop.mode,
            reason: loop.reason,
            iterations: loop.iterations,
            best,
            log,
            rmsCm: history.map((h) => h.rmsCm),
            muRampLowerBound: best.params.muRamp >= 0.9 * threshold ? threshold : null,
          },
        });
      }
    };
    worker.onerror = (event) => dispatch({ type: 'FIT_FAILED', message: event.message || 'the fit worker crashed' });
    try {
      worker.postMessage(fitRequestForOverlay(fittingData, useAgent));
    } catch (err) {
      dispatch({ type: 'FIT_FAILED', message: message(err) });
    }
    return () => worker.terminate();
  }, [fittingData, useAgent]);

  async function onLoad(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const clip = form.get('clip');
    const sceneFile = form.get('scene');
    const samFile = form.get('sam');
    if (!(clip instanceof File) || !(sceneFile instanceof File) || !(samFile instanceof File) || !clip.size) {
      dispatch({ type: 'LOAD' });
      dispatch({ type: 'FAILED', message: 'Pick a clip, its scene.json and its sam-raw.txt.' });
      return;
    }
    const fps = Number(form.get('fps')) || DEFAULT_FPS;
    const markerRaw = String(form.get('marker') ?? '').trim();
    const markerDistanceCm = markerRaw ? Number(markerRaw) : undefined;
    dispatch({ type: 'LOAD' });
    try {
      await initRapier();
      const data = loadOverlayData({
        sceneJson: await sceneFile.text(),
        samText: await samFile.text(),
        fps,
        params,
        ...(markerDistanceCm ? { markerDistanceCm } : {}),
      });
      dispatch({ type: 'LOADED', videoUrl: URL.createObjectURL(clip), data });
    } catch (err) {
      dispatch({ type: 'FAILED', message: message(err) });
    }
  }

  function onParam(key: (typeof EDITABLE)[number]['key'], value: number) {
    if (!Number.isFinite(value)) return;
    const next = { ...params, [key]: value };
    setParams(next);
    if (state.status === 'ready') dispatch({ type: 'PARAMS_CHANGED', data: withParams(state.data, next) });
  }

  return (
    <section>
      <h2>Overlay</h2>
      <p>
        A clip with its SAM 3.1 tracks and Muse Spark scene: SAM masks, the measured ball trail (cyan) and the
        simulated ball drawn on the video, white while inside the fit window and violet after it, where the fit has
        seen nothing.
      </p>
      <form onSubmit={(e) => void onLoad(e)} style={{ display: 'grid', gap: 8, maxWidth: 520 }}>
        <label>
          Clip <input type="file" name="clip" accept="video/*" />
        </label>
        <label>
          scene.json <input type="file" name="scene" accept=".json,application/json" />
        </label>
        <label>
          sam-raw.txt <input type="file" name="sam" accept=".txt,text/plain" />
        </label>
        <label>
          Frame rate <input type="number" name="fps" defaultValue={DEFAULT_FPS} min={1} step="any" style={{ width: 80 }} /> fps
        </label>
        <label>
          Tape marks <input type="number" name="marker" placeholder="from scene.json" min={1} step="any" style={{ width: 120 }} /> cm
          apart
        </label>
        <button type="submit" disabled={state.status === 'loading' || state.status === 'fitting'}>
          Load
        </button>
      </form>

      {state.status === 'loading' && <p>Loading…</p>}
      {state.status === 'error' && <p role="alert">{state.message}</p>}
      {(state.status === 'ready' || state.status === 'fitting') && (
        <>
          <Summary data={state.data} />
          <fieldset disabled={state.status === 'fitting'} style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <legend>Simulation</legend>
            {EDITABLE.map(({ key, label }) => (
              <label key={key}>
                {label}{' '}
                <input
                  type="number"
                  min={0}
                  max={key === 'restitution' ? 1 : 2}
                  step={0.01}
                  value={params[key]}
                  onChange={(e) => onParam(key, e.currentTarget.valueAsNumber)}
                  style={{ width: 80 }}
                />
              </label>
            ))}
            <label>
              <input type="checkbox" checked={useAgent} onChange={(e) => setUseAgent(e.currentTarget.checked)} /> Muse Spark
              agent (needs MODEL_API_KEY on the dev server)
            </label>
            <button type="button" onClick={() => dispatch({ type: 'FIT' })}>
              Fit on the first {DEFAULT_WINDOW_END_SEC.toFixed(1)} s
            </button>
          </fieldset>
          {state.status === 'fitting' && (
            <div aria-live="polite">
              <p>
                Fitting in the background…{' '}
                {state.rmsCm.length > 0 && `RMS per iteration: ${state.rmsCm.map(mm).join(' → ')}`}
              </p>
              <FitLog log={state.log} />
            </div>
          )}
          {state.status === 'ready' && state.fitError && <p role="alert">Fit failed: {state.fitError}</p>}
          {state.status === 'ready' && state.fit && <FitReportView report={state.fit} />}
          <OverlayPlayer videoUrl={state.videoUrl} data={state.data} />
        </>
      )}
    </section>
  );
}
