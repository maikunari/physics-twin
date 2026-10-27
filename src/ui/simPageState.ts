import type { WorldScene } from '../scene/calibration';
import type { Trajectory } from '../sim/rampSim';

/** The day-1 sim page: loading Rapier and running the scene, then showing it or the error. */
export type SimPageState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly scene: WorldScene; readonly trajectory: Trajectory }
  | { readonly status: 'error'; readonly message: string };

export type SimPageEvent =
  | { readonly type: 'SIMULATED'; readonly scene: WorldScene; readonly trajectory: Trajectory }
  | { readonly type: 'FAILED'; readonly message: string };

export const initialSimPageState: SimPageState = { status: 'loading' };

export function simPageReducer(state: SimPageState, event: SimPageEvent): SimPageState {
  if (state.status !== 'loading') return state;
  switch (event.type) {
    case 'SIMULATED':
      return { status: 'ready', scene: event.scene, trajectory: event.trajectory };
    case 'FAILED':
      return { status: 'error', message: event.message };
  }
}
