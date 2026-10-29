import type { OverlayData } from './overlayData';

/**
 * The overlay page: pick a clip with its scene.json and sam-raw.txt, load
 * them (parse, calibrate, simulate), then watch the overlay, change the
 * parameters or run the day-2 fit.
 */
export type OverlayPageState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly videoUrl: string; readonly data: OverlayData; readonly note: string | null }
  | { readonly status: 'fitting'; readonly videoUrl: string; readonly data: OverlayData }
  | { readonly status: 'error'; readonly message: string };

export type OverlayPageEvent =
  | { readonly type: 'LOAD' }
  | { readonly type: 'LOADED'; readonly videoUrl: string; readonly data: OverlayData }
  | { readonly type: 'FAILED'; readonly message: string }
  | { readonly type: 'PARAMS_CHANGED'; readonly data: OverlayData }
  | { readonly type: 'FIT' }
  | { readonly type: 'FITTED'; readonly data: OverlayData; readonly note: string };

export const initialOverlayPageState: OverlayPageState = { status: 'idle' };

export function overlayPageReducer(state: OverlayPageState, event: OverlayPageEvent): OverlayPageState {
  switch (state.status) {
    case 'idle':
    case 'error':
      return event.type === 'LOAD' ? { status: 'loading' } : state;
    case 'loading':
      if (event.type === 'LOADED') return { status: 'ready', videoUrl: event.videoUrl, data: event.data, note: null };
      if (event.type === 'FAILED') return { status: 'error', message: event.message };
      return state;
    case 'ready':
      if (event.type === 'LOAD') return { status: 'loading' };
      if (event.type === 'PARAMS_CHANGED') return { ...state, data: event.data, note: null };
      if (event.type === 'FIT') return { status: 'fitting', videoUrl: state.videoUrl, data: state.data };
      return state;
    case 'fitting':
      if (event.type === 'FITTED') return { status: 'ready', videoUrl: state.videoUrl, data: event.data, note: event.note };
      if (event.type === 'FAILED') return { status: 'error', message: event.message };
      return state;
  }
}
