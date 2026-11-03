/// <reference lib="webworker" />
import { fetchTransport } from '../agent/sparkWire';
import { handleFitRequest, type FitRequest, type FitWorkerMessage } from './fitWorkerProtocol';

/**
 * The fitter's Web Worker: Rapier, Nelder–Mead and the agent loop run here
 * so the page stays responsive. One request per worker; the page starts a
 * new worker per fit and terminates it to cancel.
 */
const scope = self as unknown as DedicatedWorkerGlobalScope;
const transport = fetchTransport(new URL('/api/agent', scope.location.origin).href);

scope.onmessage = (event: MessageEvent<FitRequest>) => {
  void handleFitRequest(event.data, (message: FitWorkerMessage) => scope.postMessage(message), transport);
};
