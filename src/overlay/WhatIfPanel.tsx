import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { createActor } from 'xstate';
import { whatIfFromApi } from '../api/client';
import { whatIfFlowMachine, type WhatIfFlowEvent, type WhatIfFlowState } from '../machines/whatIfFlow';
import type { PathEvent } from '../predict/events';
import { MAX_RAMP_ANGLE_DEG, type WhatIfEdit } from '../scene/whatIfEdit';
import { fetchPresetTracks, PRESETS, type Preset } from '../presets/presets';
import { DEFAULT_SIM_PARAMS, type SimParams } from '../sim/params';
import { describeEdit, rampAngleDeg } from '../whatif/applyEdit';
import { compareWhatIf, counterfactualFrom, type CounterfactualTake, type EventComparison } from '../whatif/compare';
import { runWhatIf } from '../whatif/run';
import { MAX_WHATIF_TEXT } from '../whatif/textEdit';
import type { WhatIfOverlay } from './drawOverlay';
import { loadOverlayData, type OverlayData } from './overlayData';

interface Props {
  readonly data: OverlayData;
  /** The fit's parameters: the what-if never changes them. */
  readonly params: SimParams;
  /** Clip time of the fitted run's t = 0. */
  readonly clockZeroSec: number;
  /** When the clip ends, seconds from the release: the what-if runs that long. */
  readonly untilSec: number;
  readonly onOverlay: (overlay: WhatIfOverlay | null) => void;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const cm = (v: number | null) => (v === null ? '—' : `${v.toFixed(2)} cm`);
const AMBER = '#b45309';
const RED = '#b91c1c';
/** A counterfactual take's ramp further than this from the asked angle is not the same what-if, degrees. */
const ANGLE_MISMATCH_DEG = 2;

/** The page's what-if actor for one frozen scene, with its snapshot as React state. */
function useWhatIfFlow(blockIds: readonly string[]) {
  const [actor] = useState(() => createActor(whatIfFlowMachine, { input: { blockIds } }).start());
  const subscribe = useCallback(
    (onChange: () => void) => {
      const subscription = actor.subscribe(onChange);
      return () => subscription.unsubscribe();
    },
    [actor],
  );
  const snapshot = useSyncExternalStore(subscribe, () => actor.getSnapshot());
  const send = useCallback((event: WhatIfFlowEvent) => actor.send(event), [actor]);
  return { snapshot, send };
}

const at = (e: PathEvent | null) => (e ? `x ${e.x.toFixed(1)} cm at ${e.t.toFixed(3)} s` : 'none');

function EventRow({ name, c, ppcm }: { name: string; c: EventComparison; ppcm: number }) {
  return (
    <tr>
      <th style={{ textAlign: 'left', paddingRight: 16 }}>{name}</th>
      <td style={{ paddingRight: 16 }}>{at(c.predicted)}</td>
      <td style={{ paddingRight: 16 }}>{at(c.real)}</td>
      <td>
        {c.errorCm === null
          ? c.predicted || c.real
            ? 'only one of them has it'
            : '—'
          : `${cm(c.errorCm)} · ${(c.errorCm * ppcm).toFixed(1)} px · ${c.errorMs?.toFixed(1)} ms`}
      </td>
    </tr>
  );
}

/**
 * The what-if step after the reveal (spec §1, §8 1:50–2:20): sliders for
 * the ramp angle and each block, or a typed what-if that Muse Spark turns
 * into the same edit, both checked by the what-if machine before the frozen
 * scene re-runs with the fitted parameters. A real take filmed with the
 * change (set B, C or D) can be loaded to score the amber run.
 */
export function WhatIfPanel({ data, params, clockZeroSec, untilSec, onOverlay }: Props) {
  const blockIds = useMemo(() => data.world.blocks.map((b) => b.id), [data.world]);
  const { snapshot, send } = useWhatIfFlow(blockIds);
  const state = snapshot.value as WhatIfFlowState;
  const { edit, run, error, note, source, text } = snapshot.context;
  const currentAngle = rampAngleDeg(data.world);
  // Null until the slider moves: the fitted angle is not on the slider's 0.5° steps, and must not become an edit by itself.
  const [angle, setAngle] = useState<number | null>(null);
  const [removed, setRemoved] = useState<readonly string[]>([]);
  const [question, setQuestion] = useState('');
  const asked = useRef(0);
  const [counterfactual, setCounterfactual] = useState<CounterfactualTake | null>(null);
  const [cfError, setCfError] = useState<string | null>(null);

  // A slider move is an edit straight away; one that changes nothing is ignored by the machine.
  function slide(nextAngle: number | null, nextRemoved: readonly string[]) {
    setAngle(nextAngle);
    setRemoved(nextRemoved);
    const edit: WhatIfEdit = {
      rampAngleDeg: nextAngle === null || Math.abs(nextAngle - currentAngle) < 0.05 ? null : nextAngle,
      removeBlockIds: [...nextRemoved],
    };
    send({ type: 'SET_EDIT', edit });
  }

  async function ask(event: FormEvent) {
    event.preventDefault();
    const id = ++asked.current;
    send({ type: 'ASK', text: question });
    try {
      const answer = await whatIfFromApi({ text: question.trim(), rampAngleDeg: currentAngle, blocks: data.world.blocks.map(({ id, label }) => ({ id, label })) });
      // A newer question, or Clear, supersedes this one.
      if (id === asked.current) send({ type: 'ANSWER', edit: answer.edit, note: answer.note });
    } catch (err) {
      if (id === asked.current) send({ type: 'ASK_FAILED', error: message(err) });
    }
  }

  // Runs the edit the machine accepted; the machine shows it only if it is still the current edit.
  useEffect(() => {
    if (state !== 'running' || !edit) return;
    const timer = setTimeout(() => {
      try {
        send({ type: 'RUN_DONE', run: runWhatIf({ world: data.world, params, edit, untilSec }) });
      } catch (err) {
        send({ type: 'RUN_FAILED', error: message(err) });
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [state, edit, data, params, untilSec, send]);

  const shownRun = state === 'shown' ? run : null;
  useEffect(() => {
    onOverlay(shownRun ? { clockZeroSec, run: shownRun, counterfactual } : null);
  }, [shownRun, counterfactual, clockZeroSec, onOverlay]);
  useEffect(() => () => onOverlay(null), [onOverlay]);

  function setCounterfactualFrom(take: string, tracks: { sceneJson: string; samText: string }, fps: number, synthetic = false) {
    try {
      const cfData = loadOverlayData({ ...tracks, fps, params: DEFAULT_SIM_PARAMS });
      setCounterfactual({ ...counterfactualFrom(data, take, cfData), ...(synthetic ? { synthetic } : {}) });
      setCfError(null);
    } catch (err) {
      setCounterfactual(null);
      setCfError(message(err));
    }
  }

  async function loadPresetCounterfactual(preset: Preset) {
    try {
      setCounterfactualFrom(`${preset.take} (${preset.title})`, await fetchPresetTracks(preset), preset.fps, preset.source === 'synthetic');
    } catch (err) {
      setCounterfactual(null);
      setCfError(message(err));
    }
  }

  async function loadCounterfactual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const sceneFile = form.get('cfScene');
    const samFile = form.get('cfSam');
    if (!(sceneFile instanceof File) || !(samFile instanceof File) || !sceneFile.size || !samFile.size) {
      setCfError('Pick the take’s scene.json and sam-raw.txt.');
      return;
    }
    const take = String(form.get('cfName') ?? '').trim() || 'counterfactual';
    setCounterfactualFrom(take, { sceneJson: await sceneFile.text(), samText: await samFile.text() }, Number(form.get('cfFps')) || data.fps);
  }

  const comparison = shownRun && counterfactual ? compareWhatIf(shownRun.edited, counterfactual, data.calibration.pixelsPerCm) : null;
  const ppcm = data.calibration.pixelsPerCm;
  const removedKept = shownRun && counterfactual ? shownRun.edit.removeBlockIds.filter((id) => counterfactual.blockIds.includes(id)) : [];

  return (
    <section aria-live="polite" style={{ border: `1px solid ${AMBER}`, borderRadius: 8, padding: 12, margin: '12px 0' }}>
      <h3 style={{ marginTop: 0, color: AMBER }}>What if</h3>
      <p>
        Change the scene and the twin re-runs it with the fitted parameters, unchanged: the amber ghost is its answer, not a new fit.
      </p>
      <fieldset disabled={state === 'asking'} style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <legend>Sliders</legend>
        <label>
          Ramp angle{' '}
          <input
            type="range"
            min={5}
            max={MAX_RAMP_ANGLE_DEG}
            step={0.5}
            value={angle ?? currentAngle}
            onChange={(e) => slide(e.currentTarget.valueAsNumber, removed)}
          />{' '}
          {(angle ?? currentAngle).toFixed(1)}° (fitted scene {currentAngle.toFixed(1)}°)
        </label>
        {data.world.blocks.map((b) => (
          <label key={b.id}>
            <input
              type="checkbox"
              checked={removed.includes(b.id)}
              onChange={(e) => slide(angle, e.currentTarget.checked ? [...removed, b.id] : removed.filter((id) => id !== b.id))}
            />{' '}
            remove {b.label}
          </label>
        ))}
      </fieldset>
      <form onSubmit={(e) => void ask(e)} style={{ display: 'flex', gap: 8, margin: '8px 0' }}>
        <input
          type="text"
          value={question}
          maxLength={MAX_WHATIF_TEXT}
          onChange={(e) => setQuestion(e.currentTarget.value)}
          placeholder="What if the ramp were twice as steep and the blue block gone?"
          style={{ flex: 1 }}
        />
        <button type="submit" disabled={state === 'asking' || !question.trim()}>
          Ask Muse Spark
        </button>
        {(state === 'shown' || state === 'failed' || state === 'asking') && (
          <button
            type="button"
            onClick={() => {
              asked.current++;
              setAngle(null);
              setRemoved([]);
              send({ type: 'CLEAR' });
            }}
          >
            Clear
          </button>
        )}
      </form>

      {state === 'asking' && <p>Muse Spark is reading “{text}”…</p>}
      {state === 'running' && <p>Running the edited scene…</p>}
      {state === 'failed' && (
        <p role="alert" style={{ color: RED }}>
          {error}
          {note && !error?.includes(note) ? ` (Muse Spark: ${note})` : ''}
        </p>
      )}
      {shownRun && (
        <div>
          <p style={{ color: AMBER, fontWeight: 600 }}>
            {describeEdit(shownRun.edit, data.world)}
            {source === 'text' ? ` (Muse Spark read “${text}”${note ? `: ${note}` : ''})` : ' (sliders)'}
          </p>
          <table style={{ borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr>
                {['', 'Fitted scene', 'What-if'].map((h) => (
                  <th key={h} style={{ textAlign: 'left', paddingRight: 16 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['Ramp', `${shownRun.baseline.rampAngleDeg.toFixed(1)}°`, `${shownRun.edited.rampAngleDeg.toFixed(1)}°`],
                  ['Lands', at(shownRun.baseline.landing), at(shownRun.edited.landing)],
                  ['First turns back', at(shownRun.baseline.turnaround), at(shownRun.edited.turnaround)],
                  [`At ${shownRun.edited.untilSec.toFixed(2)} s`, `x ${shownRun.baseline.end.x.toFixed(1)} cm`, `x ${shownRun.edited.end.x.toFixed(1)} cm`],
                ] as const
              ).map(([k, a, b]) => (
                <tr key={k}>
                  <th style={{ textAlign: 'left', paddingRight: 16 }}>{k}</th>
                  <td style={{ paddingRight: 16 }}>{a}</td>
                  <td>{b}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form onSubmit={(e) => void loadCounterfactual(e)} style={{ display: 'grid', gap: 6, maxWidth: 560, marginTop: 12 }}>
        <strong>Counterfactual take</strong>
        <span>
          A take with the change made (B steeper, C block removed, D both), same camera: filmed, or a synthetic preset. Its tracks are read
          only here, to score the amber run.
        </span>
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {PRESETS.filter((p) => p.set !== 'A').map((p) => (
            <button key={p.id} type="button" onClick={() => void loadPresetCounterfactual(p)}>
              Preset {p.set}: {p.title}
              {p.source === 'synthetic' ? ' (synthetic)' : ''}
            </button>
          ))}
        </span>
        <label>
          Name <input type="text" name="cfName" placeholder="B01" style={{ width: 80 }} />
        </label>
        <label>
          scene.json <input type="file" name="cfScene" accept=".json,application/json" />
        </label>
        <label>
          sam-raw.txt <input type="file" name="cfSam" accept=".txt,text/plain" />
        </label>
        <label>
          Frame rate <input type="number" name="cfFps" defaultValue={data.fps} min={1} step="any" style={{ width: 80 }} /> fps
        </label>
        <button type="submit">Load the take</button>
      </form>
      {cfError && (
        <p role="alert" style={{ color: RED }}>
          {cfError}
        </p>
      )}
      {counterfactual && !shownRun && <p>{counterfactual.take} loaded; make a what-if to compare.</p>}
      {comparison && counterfactual && shownRun && (
        <div>
          <p>
            Amber run against the {counterfactual.synthetic ? 'synthetic (not filmed)' : 'real'} take <strong>{comparison.take}</strong>, each from its own release. Its ramp{' '}
            {comparison.rampAngleDeg.real.toFixed(1)}° ({counterfactual.synthetic ? 'from its scene file' : 'Muse Spark on its frame 0'}) against {comparison.rampAngleDeg.asked.toFixed(1)}° asked.
          </p>
          {Math.abs(comparison.rampAngleDeg.real - comparison.rampAngleDeg.asked) > ANGLE_MISMATCH_DEG && (
            <p style={{ color: RED }}>The counterfactual take’s ramp is not at the angle asked: this compares two different setups.</p>
          )}
          {removedKept.length > 0 && <p style={{ color: RED }}>The counterfactual take still has {removedKept.join(', ')}, which the what-if removed.</p>}
          {comparison.cameraMoved && (
            <p style={{ color: RED }}>
              Its table and ramp foot sit {comparison.cameraShiftPx.toFixed(1)} px from this take’s: the camera or the table probably moved.
            </p>
          )}
          <table style={{ borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr>
                {['', 'What-if', counterfactual.synthetic ? 'Synthetic take' : 'Real take', 'Error'].map((h) => (
                  <th key={h} style={{ textAlign: 'left', paddingRight: 16 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <EventRow name="Lands" c={comparison.landing} ppcm={ppcm} />
              <EventRow name="First turns back" c={comparison.turnaround} ppcm={ppcm} />
              <tr>
                <th style={{ textAlign: 'left', paddingRight: 16 }}>At {comparison.end.t.toFixed(2)} s</th>
                <td style={{ paddingRight: 16 }}>{comparison.end.predicted ? `x ${comparison.end.predicted.x.toFixed(1)} cm` : '—'}</td>
                <td style={{ paddingRight: 16 }}>{comparison.end.real ? `x ${comparison.end.real.x.toFixed(1)} cm` : 'not tracked'}</td>
                <td>{comparison.end.errorCm === null ? '—' : `${cm(comparison.end.errorCm)} · ${comparison.end.errorPx?.toFixed(1)} px`}</td>
              </tr>
              <tr>
                <th style={{ textAlign: 'left', paddingRight: 16 }}>Trajectory RMS</th>
                <td colSpan={3}>
                  {comparison.trajectory.rmsMm === null
                    ? '—'
                    : `${comparison.trajectory.rmsMm.toFixed(1)} mm · ${comparison.trajectory.rmsPx?.toFixed(1)} px over ${comparison.trajectory.points} points`}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
