import type { FitEvaluation } from '../fit/fitter';
import type { FitMode } from '../machines/fitLoop';
import type { FitLogEntry } from '../fit/session';
import type { OverlayData } from './overlayData';

/** What a finished fit leaves on the page: the log, the RMS per iteration and the best run's segment errors. */
export interface FitReport {
  readonly mode: FitMode;
  readonly reason: 'converged' | 'maxIter';
  readonly iterations: number;
  readonly best: FitEvaluation;
  readonly log: readonly FitLogEntry[];
  /** Window RMS after each iteration, cm. */
  readonly rmsCm: readonly number[];
  /** Set when the fitted μ_ramp is at or past the rolling threshold, so it is only a lower bound. */
  readonly muRampLowerBound: number | null;
}

/**
 * The overlay page: pick a clip with its scene.json and sam-raw.txt, load
 * them (parse, calibrate, simulate), then watch the overlay, change the
 * parameters or run the day-3 fit in its worker, which streams its log.
 */
export type OverlayPageState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly videoUrl: string;
      readonly data: OverlayData;
      readonly fit: FitReport | null;
      readonly fitError: string | null;
    }
  | {
      readonly status: 'fitting';
      readonly videoUrl: string;
      readonly data: OverlayData;
      readonly log: readonly FitLogEntry[];
      readonly rmsCm: readonly number[];
    }
  | { readonly status: 'error'; readonly message: string };

export type OverlayPageEvent =
  | { readonly type: 'LOAD' }
  | { readonly type: 'LOADED'; readonly videoUrl: string; readonly data: OverlayData }
  | { readonly type: 'FAILED'; readonly message: string }
  | { readonly type: 'PARAMS_CHANGED'; readonly data: OverlayData }
  | { readonly type: 'FIT' }
  | { readonly type: 'FIT_LOG'; readonly entry: FitLogEntry }
  | { readonly type: 'FIT_PROGRESS'; readonly rmsCm: number }
  | { readonly type: 'FITTED'; readonly data: OverlayData; readonly report: FitReport }
  | { readonly type: 'FIT_FAILED'; readonly message: string };

export const initialOverlayPageState: OverlayPageState = { status: 'idle' };

export function overlayPageReducer(state: OverlayPageState, event: OverlayPageEvent): OverlayPageState {
  switch (state.status) {
    case 'idle':
    case 'error':
      return event.type === 'LOAD' ? { status: 'loading' } : state;
    case 'loading':
      if (event.type === 'LOADED')
        return { status: 'ready', videoUrl: event.videoUrl, data: event.data, fit: null, fitError: null };
      if (event.type === 'FAILED') return { status: 'error', message: event.message };
      return state;
    case 'ready':
      if (event.type === 'LOAD') return { status: 'loading' };
      // The ghost no longer shows the fitted parameters, so the report goes with them.
      if (event.type === 'PARAMS_CHANGED') return { ...state, data: event.data, fit: null, fitError: null };
      if (event.type === 'FIT') return { status: 'fitting', videoUrl: state.videoUrl, data: state.data, log: [], rmsCm: [] };
      return state;
    case 'fitting':
      if (event.type === 'FIT_LOG') return { ...state, log: [...state.log, event.entry] };
      if (event.type === 'FIT_PROGRESS') return { ...state, rmsCm: [...state.rmsCm, event.rmsCm] };
      if (event.type === 'FITTED')
        return { status: 'ready', videoUrl: state.videoUrl, data: event.data, fit: event.report, fitError: null };
      // A failed fit keeps the clip: the overlay is still good, only the fit is not.
      if (event.type === 'FIT_FAILED')
        return { status: 'ready', videoUrl: state.videoUrl, data: state.data, fit: null, fitError: event.message };
      return state;
  }
}
