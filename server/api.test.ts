import { describe, expect, it } from 'vitest';
import { AGENT_TOOLS } from '../src/agent/fitAgent';
import { sceneFileSchema } from '../src/overlay/overlayData';
import { FIXTURE_IMAGE_SIZE, FIXTURE_SCENE } from '../src/scene/fixtures';
import { formatSamFrameLine } from '../src/tracks/samText';
import { envFrom, type ApiEnv, type ApiReply, type ApiRequest, type RouteName } from './api';
import { createApi } from './index';
import { DailyCap, RateLimiter, ReplyCache } from './limits';
import { sseEvents } from './routes';

const KEY = 'sk-secret-test-key';
const ENV: ApiEnv = { apiKey: KEY, baseUrl: 'https://api.example/v1', apiOff: false, dailyCap: 1000 };

const AGENT_REQUEST = {
  model: 'muse-spark-1.3',
  instructions: 'fit',
  input: [{ type: 'message', role: 'user', content: 'turn 1' }],
  tools: AGENT_TOOLS,
  tool_choice: 'required',
  parallel_tool_calls: false,
};
const IMAGE = `data:image/jpeg;base64,${Buffer.from('frame0').toString('base64')}`;
const VIDEO = `data:video/quicktime;base64,${Buffer.from('clip').toString('base64')}`;
const SCENE_REQUEST = { image: IMAGE, imageSize: FIXTURE_IMAGE_SIZE };
const TRACK_REQUEST = { video: VIDEO, size: FIXTURE_IMAGE_SIZE, objects: [{ id: '1', box: { left: 190, top: 380, right: 230, bottom: 420 } }] };
const WHATIF_REQUEST = { text: 'twice as steep', rampAngleDeg: 20, blocks: [{ id: 'blue', label: 'blue block' }] };
const REQUESTS: Record<RouteName, unknown> = { agent: AGENT_REQUEST, scene: SCENE_REQUEST, track: TRACK_REQUEST, whatif: WHATIF_REQUEST };

/** A Responses API reply carrying `text` as its output message. */
const responsesJson = (text: string) => JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });

const sse = (events: readonly object[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const lane = { item_id: 'msg_1', output_index: 0, content_index: 0 };
const SAM_TEXT = formatSamFrameLine(0, [{ objectId: '1', box: { left: 190, top: 380, right: 230, bottom: 420 }, confidence: 0.95 }], FIXTURE_IMAGE_SIZE);
const SAM_STREAM = sse([
  { type: 'response.created' },
  { type: 'response.output_text.delta', ...lane, delta: SAM_TEXT.slice(0, 20) },
  { type: 'response.output_text.delta', ...lane, delta: SAM_TEXT.slice(20) },
  { type: 'response.output_text.done', ...lane, text: SAM_TEXT },
  { type: 'response.completed', response: {} },
]);

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fake Meta Model API: answers each route's request the way the real one would, and records every call. */
function fakeApi(override?: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    if (override) return override(call);
    const body = JSON.parse(String(init.body)) as { model: string; stream?: boolean; text?: { format?: { name?: string } } };
    if (body.stream) return new Response(SAM_STREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    if (body.text?.format?.name === 'grounded_scene') return new Response(responsesJson(JSON.stringify(FIXTURE_SCENE)));
    if (body.text?.format?.name === 'whatif_edit') return new Response(responsesJson('{"rampAngleDeg":40,"removeBlockIds":[],"note":"2 × 20°"}'));
    return new Response('{"output":[]}');
  }) as typeof fetch;
  return { impl, calls };
}

function api(env: Partial<ApiEnv> = {}, override?: (call: Call) => Response | Promise<Response>, now?: () => number) {
  const fake = fakeApi(override);
  const handlers = createApi({ env: { ...ENV, ...env }, fetchImpl: fake.impl, ...(now ? { now } : {}) });
  const send = (route: RouteName, body: unknown = REQUESTS[route], extra: Partial<ApiRequest> = {}): Promise<ApiReply> =>
    handlers[route]({ method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), clientIp: '203.0.113.1', ...extra });
  return { send, calls: fake.calls };
}

const errorOf = (reply: ApiReply) => (JSON.parse(reply.body) as { error?: string }).error ?? '';

describe('envFrom', () => {
  it('reads the key, base URL, kill switch and daily cap from the environment only', () => {
    expect(envFrom({})).toEqual({ apiKey: undefined, baseUrl: 'https://api.meta.ai/v1', apiOff: false, dailyCap: 400 });
    expect(
      envFrom({ MODEL_API_KEY: ' k ', META_API_BASE_URL: 'http://localhost:9/v1/', PHYSICS_TWIN_API_OFF: 'true', PHYSICS_TWIN_DAILY_CAP: '25' }),
    ).toEqual({ apiKey: 'k', baseUrl: 'http://localhost:9/v1', apiOff: true, dailyCap: 25 });
    expect(envFrom({ PHYSICS_TWIN_DAILY_CAP: 'lots', PHYSICS_TWIN_API_OFF: '0' })).toMatchObject({ dailyCap: 400, apiOff: false });
  });
});

describe('limits', () => {
  it('the cache forgets the least recently used entry and expired ones', () => {
    let t = 0;
    const cache = new ReplyCache<number>(2, 1000, () => t);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    t = 1000;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(1);
  });

  it('the rate limiter counts per key per window and says when to come back', () => {
    let t = 0;
    const limiter = new RateLimiter(2, 60_000, () => t);
    expect(limiter.take('x').ok).toBe(true);
    expect(limiter.take('x').ok).toBe(true);
    expect(limiter.take('x')).toEqual({ ok: false, retryAfterSec: 60 });
    expect(limiter.take('y').ok).toBe(true);
    t = 30_000;
    expect(limiter.take('x').retryAfterSec).toBe(30);
    t = 60_000;
    expect(limiter.take('x').ok).toBe(true);
  });

  it('the daily cap resets at UTC midnight', () => {
    let t = Date.parse('2026-11-03T23:59:00Z');
    const cap = new DailyCap(1, () => t);
    expect(cap.take().ok).toBe(true);
    expect(cap.take()).toEqual({ ok: false, retryAfterSec: 60 });
    t = Date.parse('2026-11-04T00:00:00Z');
    expect(cap.take().ok).toBe(true);
  });
});

describe('every route', () => {
  it.each(['track', 'scene', 'agent', 'whatif'] as const)('%s: refuses early without calling the API', async (route) => {
    const { send, calls } = api();
    expect((await send(route, REQUESTS[route], { method: 'GET' })).status).toBe(405);
    expect((await send(route, '{')).status).toBe(400);
    expect((await send(route, { nope: true })).status).toBe(400);
    expect((await send(route, REQUESTS[route], { bodyTooLarge: true })).status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it.each(['track', 'scene', 'agent', 'whatif'] as const)('%s: the kill switch answers 503 for everything', async (route) => {
    const { send, calls } = api({ apiOff: true });
    const reply = await send(route);
    expect(reply.status).toBe(503);
    expect(errorOf(reply)).toMatch(/switched off.*presets/);
    expect(calls).toHaveLength(0);
  });

  it.each(['track', 'scene', 'agent', 'whatif'] as const)('%s: without a key answers 503, without calling out', async (route) => {
    const { send, calls } = api({ apiKey: undefined });
    const reply = await send(route);
    expect(reply.status).toBe(503);
    expect(errorOf(reply)).toMatch(/MODEL_API_KEY is not set/);
    expect(calls).toHaveLength(0);
  });

  it.each(['track', 'scene', 'agent', 'whatif'] as const)('%s: answers a repeat from the cache, sends the key only upstream', async (route) => {
    const { send, calls } = api();
    const first = await send(route);
    const second = await send(route);
    expect(first.status).toBe(200);
    expect(first.headers['x-cache']).toBe('miss');
    expect(second.headers['x-cache']).toBe('hit');
    expect(second.body).toBe(first.body);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.example/v1/responses');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    for (const reply of [first, second]) {
      expect(reply.body).not.toContain(KEY);
      expect(JSON.stringify(reply.headers)).not.toContain(KEY);
    }
  });
});

describe('limits on the routes', () => {
  it('limits each caller per hour; cache hits and other callers are not counted', async () => {
    let t = 0;
    const { send, calls } = api({}, undefined, () => t);
    const ask = (text: string, clientIp = '203.0.113.1') => send('whatif', { ...WHATIF_REQUEST, text }, { clientIp });
    for (let i = 0; i < 30; i++) expect((await ask(`steeper ${i}`)).status).toBe(200);
    expect((await ask('steeper 0')).headers['x-cache']).toBe('hit');
    const limited = await ask('steeper 30');
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('3600');
    expect((await ask('steeper 30', '198.51.100.7')).status).toBe(200);
    t = 3600 * 1000;
    expect((await ask('steeper 31')).status).toBe(200);
    expect(calls).toHaveLength(32);
  });

  it('the daily cap covers every route of the server together', async () => {
    const { send, calls } = api({ dailyCap: 2 });
    expect((await send('agent')).status).toBe(200);
    expect((await send('whatif')).status).toBe(200);
    const capped = await send('scene');
    expect(capped.status).toBe(429);
    expect(errorOf(capped)).toMatch(/daily/);
    // Already-answered requests still come from the cache.
    expect((await send('agent')).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('does not cache a failure, and reports an unreachable API as 502', async () => {
    let fail = true;
    const { send, calls } = api({}, () => (fail ? new Response('{"error":"busy"}', { status: 500 }) : new Response('{"output":[]}')));
    const first = await send('agent');
    expect(first.status).toBe(500);
    fail = false;
    expect((await send('agent')).status).toBe(200);
    expect(calls).toHaveLength(2);
    const down = api({}, () => Promise.reject(new TypeError('fetch failed')));
    const reply = await down.send('whatif');
    expect(reply.status).toBe(502);
    expect(errorOf(reply)).toBe('could not reach the Model API');
  });
});

describe('/api/agent', () => {
  it('forwards the agent request unchanged', async () => {
    const { send, calls } = api();
    expect((await send('agent')).body).toBe('{"output":[]}');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(AGENT_REQUEST);
  });

  it.each([
    ['another model', { ...AGENT_REQUEST, model: 'muse-image' }],
    ['extra fields', { ...AGENT_REQUEST, stream: true }],
  ])('refuses %s', async (_name, body) => {
    const { send, calls } = api();
    expect((await send('agent', body)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe('/api/scene', () => {
  it('answers the scene file the page loads', async () => {
    const { send, calls } = api();
    const reply = await send('scene');
    const file = sceneFileSchema.parse(JSON.parse(reply.body));
    expect(file).toEqual({ imageSize: FIXTURE_IMAGE_SIZE, markerDistanceCm: 50, scene: FIXTURE_SCENE });
    const sent = JSON.parse(String(calls[0]?.init.body)) as { model: string; input: { content: { type: string; image_url?: string }[] }[] };
    expect(sent.model).toBe('muse-spark-1.3');
    expect(sent.input[0]?.content[1]).toEqual({ type: 'input_image', image_url: IMAGE });
  });

  it('refuses a scene without a usable scale, or a reply that is not a scene', async () => {
    const noScale = { ...FIXTURE_SCENE, scaleMarkers: [FIXTURE_SCENE.scaleMarkers[0], FIXTURE_SCENE.scaleMarkers[0]] };
    const a = api({}, () => new Response(responsesJson(JSON.stringify(noScale))));
    expect((await a.send('scene')).status).toBe(422);
    const b = api({}, () => new Response(responsesJson('{"ramp":1}')));
    expect((await b.send('scene')).status).toBe(422);
  });

  it('only takes a JPEG or PNG data URL', async () => {
    const { send } = api();
    expect((await send('scene', { ...SCENE_REQUEST, image: 'https://example.com/frame.jpg' })).status).toBe(400);
    expect((await send('scene', { ...SCENE_REQUEST, image: VIDEO })).status).toBe(400);
  });
});

describe('/api/track', () => {
  it('builds the SAM prompt from the boxes, streams, and answers the raw output', async () => {
    const { send, calls } = api();
    const reply = await send('track');
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ rawOutput: SAM_TEXT, outcome: { status: 'completed' }, errors: 0 });
    const sent = JSON.parse(String(calls[0]?.init.body)) as {
      model: string;
      stream: boolean;
      metadata: Record<string, string>;
      input: { content: { type: string; text?: string; video_url?: string }[] }[];
    };
    expect(sent.model).toBe('sam-3.1');
    expect(sent.stream).toBe(true);
    expect(sent.metadata.include_confidence).toBe('true');
    expect(sent.input[0]?.content[0]?.text).toContain('190');
    expect(sent.input[0]?.content[1]).toEqual({ type: 'input_video', video_url: VIDEO });
  });

  it('reports a failed stream as 502 with the reason, and does not cache it', async () => {
    const failed = sse([{ type: 'response.failed', response: { error: { message: 'video too long' } } }]);
    const { send, calls } = api({}, () => new Response(failed, { status: 200 }));
    const reply = await send('track');
    expect(reply.status).toBe(502);
    expect(errorOf(reply)).toMatch(/video too long/);
    await send('track');
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['a non-video data URL', { ...TRACK_REQUEST, video: IMAGE }],
    ['no objects', { ...TRACK_REQUEST, objects: [] }],
    ['an empty box', { ...TRACK_REQUEST, objects: [{ id: '1', box: { left: 5, top: 5, right: 5, bottom: 9 } }] }],
    ['a bad object id', { ...TRACK_REQUEST, objects: [{ id: 'ball', box: TRACK_REQUEST.objects[0]!.box }] }],
  ])('refuses %s', async (_name, body) => {
    const { send, calls } = api();
    expect((await send('track', body)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe('/api/whatif', () => {
  it('answers a validated edit with the model note', async () => {
    const { send } = api();
    expect(JSON.parse((await send('whatif')).body)).toEqual({ edit: { rampAngleDeg: 40, removeBlockIds: [] }, note: '2 × 20°' });
  });

  it('refuses an edit past the limits with 422, and does not cache it', async () => {
    const { send, calls } = api({}, () => new Response(responsesJson('{"rampAngleDeg":90,"removeBlockIds":[],"note":"vertical"}')));
    const reply = await send('whatif');
    expect(reply.status).toBe(422);
    expect(errorOf(reply)).toMatch(/rampAngleDeg/);
    await send('whatif');
    expect(calls).toHaveLength(2);
  });

  it('passes an upstream error on as 502 with its status', async () => {
    const { send } = api({}, () => new Response('{"error":{"message":"invalid model"}}', { status: 404 }));
    const reply = await send('whatif');
    expect(reply.status).toBe(502);
    expect(errorOf(reply)).toBe('Meta Model API answered 404');
  });
});

describe('sseEvents', () => {
  it('reads events split across chunks, with CRLF, comments and [DONE]', async () => {
    const text = ': keep-alive\r\n\r\nevent: a\r\ndata: {"type":"a","n":1}\r\n\r\ndata: {"type":"b"}\n\ndata: [DONE]\n\n';
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    });
    const seen: unknown[] = [];
    for await (const e of sseEvents(stream)) seen.push(e);
    expect(seen).toEqual([{ type: 'a', n: 1 }, { type: 'b' }]);
  });
});
