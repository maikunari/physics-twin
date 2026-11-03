import { sparkRequestSchema, type SparkTransport } from '../../src/agent/sparkWire';
import { agentRoute } from '../../server/routes';

export interface AgentTransportConfig {
  readonly apiKey: string | undefined;
  /** The Responses API base URL, e.g. https://api.meta.ai/v1. */
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * The fitting agent's transport for a terminal script: the same request
 * check and upstream call as `/api/agent`, without the server's cache and
 * rate limits (a results run over 30 takes makes hundreds of agent calls).
 */
export function scriptSparkTransport(config: AgentTransportConfig): SparkTransport {
  return async (request) => {
    if (!config.apiKey) throw new Error('MODEL_API_KEY is not set');
    const outcome = await agentRoute.call(
      sparkRequestSchema.parse(request),
      { apiKey: config.apiKey, baseUrl: config.baseUrl.replace(/\/$/, ''), fetchImpl: config.fetchImpl ?? fetch },
      AbortSignal.timeout(agentRoute.timeoutMs),
    );
    if (outcome.status !== 200) throw new Error(`Meta Model API answered ${outcome.status}: ${outcome.body.slice(0, 200)}`);
    return JSON.parse(outcome.body) as unknown;
  };
}
