import { describe, expect, it } from 'vitest';
import type { OverlayData } from './overlayData';
import {
  initialOverlayPageState,
  overlayPageReducer,
  type FitReport,
  type OverlayPageEvent,
  type OverlayPageState,
} from './overlayPageState';

// The reducer never looks inside the data or the report, so stand-ins are enough.
const data = { tag: 'loaded' } as unknown as OverlayData;
const refit = { tag: 'fitted' } as unknown as OverlayData;
const changed = { tag: 'changed' } as unknown as OverlayData;
const report = { tag: 'report' } as unknown as FitReport;
const entry = { kind: 'agent', text: 'bounce too high, lowering e' } as const;

const events: Record<OverlayPageEvent['type'], OverlayPageEvent> = {
  LOAD: { type: 'LOAD' },
  LOADED: { type: 'LOADED', videoUrl: 'blob:clip', data },
  FAILED: { type: 'FAILED', message: 'scene.json is not JSON' },
  PARAMS_CHANGED: { type: 'PARAMS_CHANGED', data: changed },
  FIT: { type: 'FIT' },
  FIT_LOG: { type: 'FIT_LOG', entry },
  FIT_PROGRESS: { type: 'FIT_PROGRESS', rmsCm: 0.4 },
  FITTED: { type: 'FITTED', data: refit, report },
  FIT_FAILED: { type: 'FIT_FAILED', message: 'need at least two measured points on the ramp' },
};

const run = (...types: OverlayPageEvent['type'][]) =>
  types.reduce<OverlayPageState>((s, t) => overlayPageReducer(s, events[t]), initialOverlayPageState);

const ready = { status: 'ready', videoUrl: 'blob:clip', fit: null, fitError: null } as const;
const fitting = { status: 'fitting', videoUrl: 'blob:clip', data, log: [], rmsCm: [] } as const;

describe('overlayPageReducer', () => {
  it('starts idle', () => {
    expect(initialOverlayPageState).toEqual({ status: 'idle' });
  });

  it.each<[string, OverlayPageEvent['type'][], OverlayPageState]>([
    ['idle --LOAD--> loading', ['LOAD'], { status: 'loading' }],
    ['loading --LOADED--> ready', ['LOAD', 'LOADED'], { ...ready, data }],
    ['loading --FAILED--> error', ['LOAD', 'FAILED'], { status: 'error', message: 'scene.json is not JSON' }],
    ['ready --PARAMS_CHANGED--> ready', ['LOAD', 'LOADED', 'PARAMS_CHANGED'], { ...ready, data: changed }],
    ['ready --FIT--> fitting', ['LOAD', 'LOADED', 'FIT'], fitting],
    ['fitting --FIT_LOG--> fitting', ['LOAD', 'LOADED', 'FIT', 'FIT_LOG', 'FIT_LOG'], { ...fitting, log: [entry, entry] }],
    ['fitting --FIT_PROGRESS--> fitting', ['LOAD', 'LOADED', 'FIT', 'FIT_PROGRESS'], { ...fitting, rmsCm: [0.4] }],
    ['fitting --FITTED--> ready', ['LOAD', 'LOADED', 'FIT', 'FIT_LOG', 'FITTED'], { ...ready, data: refit, fit: report }],
    [
      'fitting --FIT_FAILED--> ready, keeping the clip',
      ['LOAD', 'LOADED', 'FIT', 'FIT_FAILED'],
      { ...ready, data, fitError: 'need at least two measured points on the ramp' },
    ],
    ['ready --LOAD--> loading', ['LOAD', 'LOADED', 'LOAD'], { status: 'loading' }],
    ['error --LOAD--> loading', ['LOAD', 'FAILED', 'LOAD'], { status: 'loading' }],
  ])('%s', (_name, types, expected) => {
    expect(run(...types)).toEqual(expected);
  });

  it('a parameter change clears the fit report and any fit error', () => {
    expect(run('LOAD', 'LOADED', 'FIT', 'FITTED', 'PARAMS_CHANGED')).toMatchObject({ status: 'ready', fit: null });
    expect(run('LOAD', 'LOADED', 'FIT', 'FIT_FAILED', 'PARAMS_CHANGED')).toMatchObject({ status: 'ready', fitError: null });
  });

  it('a new fit starts with an empty log', () => {
    expect(run('LOAD', 'LOADED', 'FIT', 'FIT_LOG', 'FITTED', 'FIT')).toEqual({ ...fitting, data: refit });
  });

  const fitEvents = ['FIT_LOG', 'FIT_PROGRESS', 'FITTED', 'FIT_FAILED'] as const;
  it.each<[string, OverlayPageEvent['type'][], OverlayPageEvent['type'][]]>([
    ['idle', [], ['LOADED', 'FAILED', 'PARAMS_CHANGED', 'FIT', ...fitEvents]],
    ['loading', ['LOAD'], ['LOAD', 'PARAMS_CHANGED', 'FIT', ...fitEvents]],
    ['ready', ['LOAD', 'LOADED'], ['LOADED', 'FAILED', ...fitEvents]],
    ['fitting', ['LOAD', 'LOADED', 'FIT'], ['LOAD', 'LOADED', 'FAILED', 'PARAMS_CHANGED', 'FIT']],
    ['error', ['LOAD', 'FAILED'], ['LOADED', 'FAILED', 'PARAMS_CHANGED', 'FIT', ...fitEvents]],
  ])('%s ignores events that do not apply', (_name, path, ignored) => {
    const state = run(...path);
    for (const type of ignored) expect(overlayPageReducer(state, events[type])).toBe(state);
  });
});
