import { describe, expect, it } from 'vitest';
import { AGENT_TOOLS } from '../../src/agent/fitAgent';
import { proxySparkRequest } from './sparkProxy';

const valid = JSON.stringify({
  model: 'muse-spark-1.3',
  instructions: 'fit',
  input: [{ type: 'message', role: 'user', content: 'turn 1' }],
  tools: AGENT_TOOLS,
  tool_choice: 'required',
  parallel_tool_calls: false,
});

function fakeFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response('{"output":[]}', { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

describe('dev /api/spark proxy', () => {
  it('forwards an agent request with the key from the server environment', async () => {
    const f = fakeFetch();
    const r = await proxySparkRequest(valid, { apiKey: 'sk-test', baseUrl: 'https://api.example/v1/', fetchImpl: f.impl });
    expect(r).toEqual({ status: 200, body: '{"output":[]}' });
    expect(f.calls[0]?.url).toBe('https://api.example/v1/responses');
    expect((f.calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual(JSON.parse(valid));
  });

  it('says so when there is no key, without calling out', async () => {
    const f = fakeFetch();
    const r = await proxySparkRequest(valid, { apiKey: undefined, baseUrl: 'https://api.example/v1', fetchImpl: f.impl });
    expect(r.status).toBe(503);
    expect(f.calls).toHaveLength(0);
  });

  it.each([
    ['not JSON', '{'],
    ['another model', valid.replace('muse-spark-1.3', 'muse-image')],
    ['extra fields', JSON.stringify({ ...JSON.parse(valid), stream: true })],
  ])('refuses %s', async (_name, body) => {
    const f = fakeFetch();
    const r = await proxySparkRequest(body, { apiKey: 'sk-test', baseUrl: 'https://api.example/v1', fetchImpl: f.impl });
    expect(r.status).toBe(400);
    expect(f.calls).toHaveLength(0);
  });

  it('refuses an oversized body', async () => {
    const r = await proxySparkRequest('x'.repeat(300 * 1024), { apiKey: 'k', baseUrl: 'https://api.example/v1' });
    expect(r.status).toBe(413);
  });
});
