import { useCallback, useState, useSyncExternalStore } from 'react';
import { createActor } from 'xstate';
import { predictFlowMachine, type PredictFlowEvent } from '../machines/predictFlow';

/** The page's predict flow actor, with its snapshot as React state. One per page; it outlives re-renders. */
export function usePredictFlow() {
  const [actor] = useState(() => createActor(predictFlowMachine).start());
  const subscribe = useCallback(
    (onChange: () => void) => {
      const subscription = actor.subscribe(onChange);
      return () => subscription.unsubscribe();
    },
    [actor],
  );
  const snapshot = useSyncExternalStore(subscribe, () => actor.getSnapshot());
  const send = useCallback((event: PredictFlowEvent) => actor.send(event), [actor]);
  return { snapshot, send };
}
