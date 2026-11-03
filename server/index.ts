import { createRouteHandler, type ApiDeps, type ApiReply, type ApiRequest, type RouteName } from './api.js';
import { DailyCap } from './limits.js';
import { agentRoute, sceneRoute, trackRoute, whatIfRoute } from './routes.js';

export type ApiHandler = (req: ApiRequest) => Promise<ApiReply>;

/** Longest body each route reads, so a host can stop reading early. */
export const MAX_BODY_BYTES: Readonly<Record<RouteName, number>> = {
  track: trackRoute.maxBodyBytes,
  scene: sceneRoute.maxBodyBytes,
  agent: agentRoute.maxBodyBytes,
  whatif: whatIfRoute.maxBodyBytes,
};

/** The thin server (spec §5): every route with its own cache and per-caller limit, and one daily cap for them all. */
export function createApi(deps: ApiDeps): Readonly<Record<RouteName, ApiHandler>> {
  const shared = { ...deps, dailyCap: deps.dailyCap ?? new DailyCap(deps.env.dailyCap, deps.now) };
  return {
    track: createRouteHandler(trackRoute, shared),
    scene: createRouteHandler(sceneRoute, shared),
    agent: createRouteHandler(agentRoute, shared),
    whatif: createRouteHandler(whatIfRoute, shared),
  };
}
