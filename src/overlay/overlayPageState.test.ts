import { describe, expect, it } from 'vitest';
import type { OverlayData } from './overlayData';
import { initialOverlayPageState, overlayPageReducer, type OverlayPageEvent, type OverlayPageState } from './overlayPageState';

// The reducer never looks inside the data, so stand-ins are enough.
const data = { tag: 'loaded' } as unknown as OverlayData;
const refit = { tag: 'fitted' } as unknown as OverlayData;
const changed = { tag: 'changed' } as unknown as OverlayData;

const events: Record<OverlayPageEvent['type'], OverlayPageEvent> = {
  LOAD: { type: 'LOAD' },
  LOADED: { type: 'LOADED', videoUrl: 'blob:clip', data },
  FAILED: { type: 'FAILED', message: 'scene.json is not JSON' },
  PARAMS_CHANGED: { type: 'PARAMS_CHANGED', data: changed },
  FIT: { type: 'FIT' },
  FITTED: { type: 'FITTED', data: refit, note: 'μ_ramp 0.08, e 0.55' },
};

const run = (...types: OverlayPageEvent['type'][]) =>
  types.reduce<OverlayPageState>((s, t) => overlayPageReducer(s, events[t]), initialOverlayPageState);

describe('overlayPageReducer', () => {
  it('starts idle', () => {
    expect(initialOverlayPageState).toEqual({ status: 'idle' });
  });

  it.each<[string, OverlayPageEvent['type'][], OverlayPageState]>([
    ['idle --LOAD--> loading', ['LOAD'], { status: 'loading' }],
    ['loading --LOADED--> ready', ['LOAD', 'LOADED'], { status: 'ready', videoUrl: 'blob:clip', data, note: null }],
    ['loading --FAILED--> error', ['LOAD', 'FAILED'], { status: 'error', message: 'scene.json is not JSON' }],
    ['ready --PARAMS_CHANGED--> ready', ['LOAD', 'LOADED', 'PARAMS_CHANGED'], { status: 'ready', videoUrl: 'blob:clip', data: changed, note: null }],
    ['ready --FIT--> fitting', ['LOAD', 'LOADED', 'FIT'], { status: 'fitting', videoUrl: 'blob:clip', data }],
    ['fitting --FITTED--> ready', ['LOAD', 'LOADED', 'FIT', 'FITTED'], { status: 'ready', videoUrl: 'blob:clip', data: refit, note: 'μ_ramp 0.08, e 0.55' }],
    ['fitting --FAILED--> error', ['LOAD', 'LOADED', 'FIT', 'FAILED'], { status: 'error', message: 'scene.json is not JSON' }],
    ['ready --LOAD--> loading', ['LOAD', 'LOADED', 'LOAD'], { status: 'loading' }],
    ['error --LOAD--> loading', ['LOAD', 'FAILED', 'LOAD'], { status: 'loading' }],
  ])('%s', (_name, types, expected) => {
    expect(run(...types)).toEqual(expected);
  });

  it('a parameter change clears the fit note', () => {
    expect(run('LOAD', 'LOADED', 'FIT', 'FITTED', 'PARAMS_CHANGED')).toMatchObject({ status: 'ready', note: null });
  });

  it.each<[string, OverlayPageEvent['type'][], OverlayPageEvent['type'][]]>([
    ['idle', [], ['LOADED', 'FAILED', 'PARAMS_CHANGED', 'FIT', 'FITTED']],
    ['loading', ['LOAD'], ['LOAD', 'PARAMS_CHANGED', 'FIT', 'FITTED']],
    ['ready', ['LOAD', 'LOADED'], ['LOADED', 'FAILED', 'FITTED']],
    ['fitting', ['LOAD', 'LOADED', 'FIT'], ['LOAD', 'LOADED', 'PARAMS_CHANGED', 'FIT']],
    ['error', ['LOAD', 'FAILED'], ['LOADED', 'FAILED', 'PARAMS_CHANGED', 'FIT', 'FITTED']],
  ])('%s ignores events that do not apply', (_name, path, ignored) => {
    const state = run(...path);
    for (const type of ignored) expect(overlayPageReducer(state, events[type])).toBe(state);
  });
});
