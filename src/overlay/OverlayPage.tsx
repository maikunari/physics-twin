import { useEffect, useReducer, useRef, useState, type FormEvent } from 'react';
import { rollRadians } from '../scene/calibration';
import { DEFAULT_SIM_PARAMS, type SimParams } from '../sim/params';
import { initRapier } from '../sim/sceneWorld';
import { DEFAULT_FPS } from '../tracks/trajectories';
import { ballTrajectory, fitOverlay, loadOverlayData, withParams, type OverlayData } from './overlayData';
import { initialOverlayPageState, overlayPageReducer } from './overlayPageState';
import { OverlayPlayer } from './OverlayPlayer';

const EDITABLE: readonly { key: 'muRamp' | 'muTable' | 'restitution'; label: string }[] = [
  { key: 'muRamp', label: 'μ ramp' },
  { key: 'muTable', label: 'μ table' },
  { key: 'restitution', label: 'e (bounce)' },
];

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

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
      <li>Release detected at {data.releaseSec.toFixed(3)} s (the simulation's t = 0)</li>
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

  // The fit runs on the main thread (about a second); entering `fitting` first lets the page say so.
  useEffect(() => {
    if (state.status !== 'fitting') return;
    const timer = setTimeout(() => {
      try {
        const { data, recovery } = fitOverlay(state.data);
        setParams(data.params);
        const mu = recovery.muRampIdentifiable
          ? `μ ramp ${recovery.params.muRamp.toFixed(3)}`
          : `μ ramp ≥ ${recovery.muRampRollingThreshold.toFixed(3)} (the ball rolls without slipping, so only a lower bound)`;
        dispatch({
          type: 'FITTED',
          data,
          note: `Fitted on the first second after release: ${mu}, e ${recovery.params.restitution.toFixed(3)}; RMS ${(recovery.rmsCm * 10).toFixed(1)} mm.`,
        });
      } catch (err) {
        dispatch({ type: 'FAILED', message: message(err) });
      }
    }, 30);
    return () => clearTimeout(timer);
  }, [state]);

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
        simulated ball (white, dashed) drawn on the video.
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
            <button type="button" onClick={() => dispatch({ type: 'FIT' })}>
              Fit μ ramp and e
            </button>
          </fieldset>
          {state.status === 'fitting' && <p>Fitting…</p>}
          {state.status === 'ready' && state.note && <p>{state.note}</p>}
          <OverlayPlayer videoUrl={state.videoUrl} data={state.data} />
        </>
      )}
    </section>
  );
}
