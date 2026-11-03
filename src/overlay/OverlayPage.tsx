import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { createActor } from 'xstate';
import { sceneFromApi, trackFromApi } from '../api/client';
import { clipIntakeMachine, type ClipIntakeState } from '../machines/clipIntake';
import { samPromptObjects } from '../tracks/samText';
import { muRampRollingThreshold } from '../fit/fitter';
import type { FitWorkerMessage } from '../fit/fitWorkerProtocol';
import { DEFAULT_WINDOW_END_SEC } from '../fit/recover';
import { SEGMENT_NAMES } from '../fit/segments';
import { describeShift, type FitLogEntry } from '../fit/session';
import { rollRadians } from '../scene/calibration';
import { DEFAULT_SIM_PARAMS, type SimParams } from '../sim/params';
import { initRapier } from '../sim/sceneWorld';
import { DEFAULT_FPS } from '../tracks/trajectories';
import { commitPrediction } from '../predict/commitment';
import { makePrediction } from '../predict/prediction';
import { scoreReveal, type RevealOutcome } from '../predict/reveal';
import type { PredictOverlay, WhatIfOverlay } from './drawOverlay';
import { ballTrajectory, fitRequestForOverlay, loadOverlayData, predictionInputs, sceneFileSchema, withParams, type OverlayData } from './overlayData';
import { initialOverlayPageState, overlayPageReducer, type FitReport } from './overlayPageState';
import { OverlayPlayer } from './OverlayPlayer';
import { PredictPanel } from './PredictPanel';
import { fileToDataUrl, readClip } from './readClip';
import { usePredictFlow } from './usePredictFlow';
import { WhatIfPanel } from './WhatIfPanel';

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

/** The page's clip-intake actor (a clip with no tracks, through `/api/scene` and `/api/track`), with its state as React state. */
function useClipIntake() {
  const [actor] = useState(() => createActor(clipIntakeMachine).start());
  const subscribe = useCallback(
    (onChange: () => void) => {
      const subscription = actor.subscribe(onChange);
      return () => subscription.unsubscribe();
    },
    [actor],
  );
  const snapshot = useSyncExternalStore(subscribe, () => actor.getSnapshot());
  return { actor, snapshot };
}

const INTAKE_STATUS: Partial<Record<ClipIntakeState, string>> = {
  readingScene: 'Muse Spark is reading frame 0 into the scene…',
  tracking: 'SAM 3.1 is tracking the clip (a minute or so)…',
};

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Saves what the API made, so a tracked clip need not be tracked (and paid for) again. */
function IntakeDownloads({ sceneJson, samText, take }: { sceneJson: string; samText: string; take: string }) {
  return (
    <p>
      Tracked through the API. Keep the results:{' '}
      <button type="button" onClick={() => download(`${take}-scene.json`, sceneJson, 'application/json')}>
        scene.json
      </button>{' '}
      <button type="button" onClick={() => download(`${take}-sam-raw.txt`, samText, 'text/plain')}>
        sam-raw.txt
      </button>
    </p>
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
  const [take, setTake] = useState('take');
  const predict = usePredictFlow();
  const [pendingOutcome, setPendingOutcome] = useState<RevealOutcome | null>(null);
  const [whatIfOverlay, setWhatIfOverlay] = useState<WhatIfOverlay | null>(null);
  const intake = useClipIntake();
  const intakeState = intake.snapshot.value as ClipIntakeState;
  const fitReport = state.status === 'ready' ? state.fit : null;
  const predictState = predict.snapshot.value;
  const { prediction, commitment, outcome } = predict.snapshot.context;

  // A new fit (or none) unfreezes: any prediction made from the old one is dropped.
  const sendPredict = predict.send;
  useEffect(() => {
    sendPredict({ type: 'RESET' });
  }, [fitReport, sendPredict]);

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
            detectedReleaseSec: fittingData.releaseSec,
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

  /** A clip without tracks: Muse Spark grounds frame 0, SAM 3.1 tracks from its boxes, then it loads like picked files. */
  async function trackWithApi(clip: File, markerDistanceCm: number | undefined): Promise<{ sceneJson: string; samText: string }> {
    const { actor } = intake;
    actor.send({ type: 'RESET' });
    const info = await readClip(clip);
    actor.send({ type: 'PICK', clip: { mimeType: clip.type || 'video/quicktime', durationSec: info.durationSec, sizeBytes: clip.size } });
    const size = { width: info.width, height: info.height };
    if (actor.getSnapshot().matches('readingScene')) {
      try {
        const file = await sceneFromApi({ image: info.frame0, imageSize: size, ...(markerDistanceCm ? { markerDistanceCm } : {}) });
        actor.send({ type: 'SCENE_READY', sceneJson: JSON.stringify(file, null, 2) });
      } catch (err) {
        actor.send({ type: 'SCENE_FAILED', error: message(err) });
      }
    }
    const sceneJson = actor.getSnapshot().context.sceneJson;
    if (actor.getSnapshot().matches('tracking') && sceneJson) {
      try {
        const scene = sceneFileSchema.parse(JSON.parse(sceneJson)).scene;
        // A file the browser could not type is sent as a MOV, which is what the filming guide's iPhone records.
        const video = (await fileToDataUrl(clip)).replace(/^data:[^;]*;/, `data:${clip.type || 'video/quicktime'};`);
        const tracked = await trackFromApi({ video, size, objects: samPromptObjects(scene, size) });
        actor.send({ type: 'TRACKS_READY', samText: tracked.rawOutput });
      } catch (err) {
        actor.send({ type: 'TRACK_FAILED', error: message(err) });
      }
    }
    const done = actor.getSnapshot();
    if (!done.matches('done') || !done.context.sceneJson || !done.context.samText) throw new Error(done.context.error ?? 'tracking through the API failed');
    return { sceneJson: done.context.sceneJson, samText: done.context.samText };
  }

  async function onLoad(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const clip = form.get('clip');
    const sceneFile = form.get('scene');
    const samFile = form.get('sam');
    const hasTracks = sceneFile instanceof File && sceneFile.size > 0 && samFile instanceof File && samFile.size > 0;
    if (!(clip instanceof File) || !clip.size) {
      dispatch({ type: 'LOAD' });
      dispatch({ type: 'FAILED', message: 'Pick a clip, and its scene.json and sam-raw.txt if it has been tracked.' });
      return;
    }
    const fps = Number(form.get('fps')) || DEFAULT_FPS;
    const markerRaw = String(form.get('marker') ?? '').trim();
    const markerDistanceCm = markerRaw ? Number(markerRaw) : undefined;
    dispatch({ type: 'LOAD' });
    if (hasTracks) intake.actor.send({ type: 'RESET' });
    try {
      await initRapier();
      const tracks = hasTracks
        ? { sceneJson: await sceneFile.text(), samText: await samFile.text() }
        : await trackWithApi(clip, markerDistanceCm);
      const data = loadOverlayData({
        ...tracks,
        fps,
        params,
        ...(markerDistanceCm ? { markerDistanceCm } : {}),
      });
      setTake(clip.name.replace(/\.[^.]+$/, '') || 'take');
      dispatch({ type: 'LOADED', videoUrl: URL.createObjectURL(clip), data });
    } catch (err) {
      dispatch({ type: 'FAILED', message: message(err) });
    }
  }

  async function onPredict() {
    if (state.status !== 'ready' || !state.fit) return;
    const { data, fit } = state;
    predict.send({ type: 'PREDICT' });
    // Let "predicting" paint before the ensemble runs on this thread.
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      // The fit window only: the prediction cannot read the track past the freeze.
      const { problem, clipEndSec } = predictionInputs(data, fit.detectedReleaseSec);
      const made = makePrediction(problem, fit.best, { clipEndSec });
      const committed = await commitPrediction(take, made);
      console.info(`[physics-twin] ${take}: prediction committed, sha256 ${committed.hash}`, committed.payload);
      predict.send({ type: 'PREDICTION_READY', prediction: made, commitment: committed });
    } catch (err) {
      predict.send({ type: 'PREDICTION_FAILED', error: message(err) });
    }
  }

  function onReveal() {
    if (state.status !== 'ready' || !state.fit || !prediction || !commitment) return;
    const { measured } = predictionInputs(state.data, state.fit.detectedReleaseSec);
    setPendingOutcome(
      scoreReveal({
        prediction,
        commitment,
        measured,
        world: state.data.world,
        pixelsPerCm: state.data.calibration.pixelsPerCm,
        fps: state.data.fps,
      }),
    );
    predict.send({ type: 'REVEAL' });
  }

  // The reveal is done once the clip has played to the prediction's horizon.
  const revealEndSec =
    predictState === 'revealing' && fitReport && prediction ? fitReport.detectedReleaseSec + prediction.horizonEndSec : null;
  const onTime = useCallback(
    (t: number) => {
      if (revealEndSec !== null && pendingOutcome && t >= revealEndSec - 1e-3) sendPredict({ type: 'REVEAL_DONE', outcome: pendingOutcome });
    },
    [revealEndSec, pendingOutcome, sendPredict],
  );

  const showPrediction = (predictState === 'committed' || predictState === 'revealing' || predictState === 'result') && prediction && commitment && fitReport;
  const predictOverlay: PredictOverlay | null = showPrediction
    ? {
        clockZeroSec: fitReport.detectedReleaseSec,
        prediction,
        commitmentShort: commitment.short,
        revealed: predictState !== 'committed',
        outcome: outcome ?? pendingOutcome,
      }
    : null;

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
        <small>
          Without scene.json and sam-raw.txt the clip (at most 5 s) goes through the thin server: Muse Spark reads frame 0, SAM 3.1
          tracks from its boxes. That needs MODEL_API_KEY on the server.
        </small>
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

      {state.status === 'loading' && <p>{INTAKE_STATUS[intakeState] ?? 'Loading…'}</p>}
      {intakeState === 'done' && intake.snapshot.context.sceneJson && intake.snapshot.context.samText && state.status !== 'loading' && (
        <IntakeDownloads sceneJson={intake.snapshot.context.sceneJson} samText={intake.snapshot.context.samText} take={take} />
      )}
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
          {state.status === 'ready' && state.fit && (
            <PredictPanel
              state={predictState}
              prediction={prediction}
              commitment={commitment}
              outcome={outcome ?? pendingOutcome}
              error={predict.snapshot.context.error}
              onPredict={() => void onPredict()}
              onReveal={onReveal}
              send={predict.send}
            />
          )}
          {state.status === 'ready' && state.fit && predictState === 'result' && commitment && (
            // AppFlow result → whatIf (spec §6.1): one what-if panel per committed prediction.
            <WhatIfPanel
              key={commitment.hash}
              data={state.data}
              params={state.fit.best.params}
              clockZeroSec={state.data.releaseSec}
              untilSec={state.data.clipEndSec - state.data.releaseSec}
              onOverlay={setWhatIfOverlay}
            />
          )}
          <OverlayPlayer
            videoUrl={state.videoUrl}
            data={state.data}
            predict={predictOverlay}
            whatIf={predictState === 'result' ? whatIfOverlay : null}
            onTime={onTime}
          />
        </>
      )}
    </section>
  );
}
