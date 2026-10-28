import { useEffect, useReducer, useSyncExternalStore } from 'react';
import { OverlayPage } from './overlay/OverlayPage';
import { calibrate, toWorldScene } from './scene/calibration';
import { FIXTURE_IMAGE_SIZE, FIXTURE_SCENE } from './scene/fixtures';
import { DEFAULT_SIM_PARAMS } from './sim/params';
import { initRapier, simulateScene } from './sim/sceneWorld';
import { SimCanvas } from './ui/SimCanvas';
import { initialSimPageState, simPageReducer } from './ui/simPageState';

/** Day-1 smoke page: the fixture scene through Rapier, drawn on a canvas. */
function SimSmokePage() {
  const [state, dispatch] = useReducer(simPageReducer, initialSimPageState);

  useEffect(() => {
    let cancelled = false;
    initRapier()
      .then(() => {
        const scene = toWorldScene(FIXTURE_SCENE, calibrate(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE));
        const trajectory = simulateScene(scene, DEFAULT_SIM_PARAMS, { durationSec: 2.5 });
        if (!cancelled) dispatch({ type: 'SIMULATED', scene, trajectory });
      })
      .catch((err: unknown) => {
        if (!cancelled) dispatch({ type: 'FAILED', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <h2>Simulation smoke test</h2>
      <p>Rapier 2D: a hand-written ramp scene (not real footage) simulated at 240 Hz.</p>
      {state.status === 'loading' && <p>Loading physics…</p>}
      {state.status === 'error' && <p role="alert">Simulation failed: {state.message}</p>}
      {state.status === 'ready' && (
        <SimCanvas scene={state.scene} trajectory={state.trajectory} width={900} height={420} />
      )}
    </section>
  );
}

const subscribeHash = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};

export function App() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 16, maxWidth: 1100, margin: '0 auto' }}>
      <h1>Physics Twin</h1>
      <nav style={{ display: 'flex', gap: 16 }}>
        <a href="#">Overlay</a>
        <a href="#sim">Simulation smoke test</a>
      </nav>
      {hash === '#sim' ? <SimSmokePage /> : <OverlayPage />}
    </main>
  );
}
