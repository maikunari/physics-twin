import { describe, expect, it } from 'vitest';
import { calibrate, toWorldScene } from '../scene/calibration';
import { FIXTURE_IMAGE_SIZE, FIXTURE_SCENE } from '../scene/fixtures';
import { initialSimPageState, simPageReducer, type SimPageEvent } from './simPageState';

const scene = toWorldScene(FIXTURE_SCENE, calibrate(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE));
const simulated: SimPageEvent = { type: 'SIMULATED', scene, trajectory: { dt: 1 / 240, samples: [] } };
const failed: SimPageEvent = { type: 'FAILED', message: 'WASM failed to load' };

describe('simPageReducer', () => {
  it('starts loading', () => {
    expect(initialSimPageState).toEqual({ status: 'loading' });
  });

  it('loading --SIMULATED--> ready', () => {
    expect(simPageReducer(initialSimPageState, simulated)).toMatchObject({ status: 'ready', scene });
  });

  it('loading --FAILED--> error', () => {
    expect(simPageReducer(initialSimPageState, failed)).toEqual({ status: 'error', message: 'WASM failed to load' });
  });

  it.each([
    ['ready', simPageReducer(initialSimPageState, simulated)],
    ['error', simPageReducer(initialSimPageState, failed)],
  ])('%s is terminal and ignores later events', (_name, state) => {
    expect(simPageReducer(state, simulated)).toBe(state);
    expect(simPageReducer(state, failed)).toBe(state);
  });
});
