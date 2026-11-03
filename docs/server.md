# Day-5 thin server: /api/track, /api/scene, /api/agent, /api/whatif

The page never holds the Model API key. Four routes do the Meta Model API calls with `MODEL_API_KEY` from the server's environment (spec §5). The same handlers (`server/`) run on the Vite dev server (`npm run dev`, mounted in `vite.config.ts` by `server/node.ts`) and as Vercel functions (`api/*.ts`, via `server/vercel.ts`; `vercel.json` sets the build). Vercel runs each function as an ES module, so every relative import the functions load names its `.js` file; `server/functionImports.test.ts` checks it.

| Route | Body (zod-checked) | Calls | Answers |
|---|---|---|---|
| `/api/scene` | frame 0 as a JPEG/PNG data URL, its size, tape-mark distance | Muse Spark 1.3 grounding, strict structured output (`src/scene/groundingPrompt.ts`) | the scene file the page loads (`{ imageSize, markerDistanceCm, scene }`); 422 if the reply does not match the schema or has no usable scale |
| `/api/track` | the clip as an MP4/MOV data URL, its size, a frame-0 box per object (ball = 1, blocks after) | SAM 3.1, streamed; the server builds the prompt with `buildObjectPrompt` and parses the stream with `@meta-sam/parser` | `{ rawOutput, outcome, errors }`: `rawOutput` is what the scripts save as sam-raw.txt |
| `/api/agent` | one fitting-agent turn, only the agent's own request shape (`sparkRequestSchema`) | Muse Spark 1.3 with the agent's tools | the Responses reply, unchanged (replaces day 3's dev-only `/api/spark`) |
| `/api/whatif` | the typed what-if, the scene's ramp angle and its blocks | Muse Spark 1.3, strict structured output | `{ edit, note }`, validated (`docs/whatif.md`); 422 with the reason otherwise |

Request types live in `src/api/contract.ts`; the page's calls are in `src/api/client.ts`.

## Checks, in order

`server/api.ts`, for every route:

1. **Kill switch:** `PHYSICS_TWIN_API_OFF=1` answers 503 to everything ("the recorded presets still work").
2. POST only (405), body size (413), JSON (400), the route's zod schema (400 with the first issue).
3. **Cache:** a request identical to one already answered (SHA-256 of the route and the validated body; for track and scene that includes the whole clip or frame) is answered from memory with `x-cache: hit`, without the API and without counting against any limit. Up to 200 answers per route, kept 24 h. Only 200s are cached.
4. No key: 503, without calling out.
5. **Rate limit per caller** (the `x-forwarded-for` address on Vercel, the socket on the dev server), per hour: track 6, scene 20, agent 150 (a fit is at most 6 iterations of up to 5 model calls), whatif 30. 429 with `retry-after`.
6. **Daily cap** on calls that reach the API, all routes together: `PHYSICS_TWIN_DAILY_CAP` (default 400), reset at 00:00 UTC. 429 with `retry-after`.
7. The call, with a timeout (track 280 s, scene 90 s, agent and whatif 60 s): 504 if it runs out, 502 if the API cannot be reached. Upstream errors pass on as 502 with the API's status (the agent route passes the reply through as it is).

The key is read from the environment only and never put in a reply, a header or a log; the tests check every route's replies for it.

## Environment

See `.env.example`. On the dev server, put them in the shell or a git-ignored `.env.local`; on Vercel, in the project's environment variables.

| Variable | Meaning |
|---|---|
| `MODEL_API_KEY` | Meta Model API key (required for any call) |
| `META_API_BASE_URL` | Only to point the server at a local mock of the API |
| `PHYSICS_TWIN_API_OFF` | `1` switches every route off (presets only) |
| `PHYSICS_TWIN_DAILY_CAP` | Calls that may reach the API per UTC day (default 400) |

## Limits to know

- The cache and the limits live in memory: one dev server, or one warm Vercel instance. A cold start empties them, and two instances do not share them. That stops a page in a loop or a curious visitor from spending the credits; it is not a quota system.
- A Vercel function takes at most 4.5 MB of request body, so on the deployed site `/api/track` only takes a short, small clip (the 240 fps originals are tens of MB). The dev server takes up to 50 MB (spec §6.1). The presets ([presets.md](presets.md)) need no upload.
- Like the day-1 smoke scripts, the requests follow Meta's docs and have been run against a local mock only. Not yet checked against the live API: that SAM 3.1 takes the clip inline as a `video_url` data URL (the smoke script's `--inline` path). On Vercel, a day-6 preview with the kill switch on answered all four routes with the kill switch's 503 and served the presets; no deployed route has called the API yet.

## Uploading a clip on the page

On the overlay page, pick only a clip (no scene.json or sam-raw.txt) and **Load**: the page draws frame 0, `/api/scene` grounds it, `/api/track` tracks the clip from its boxes, and it loads like picked files, with buttons to save the scene.json and sam-raw.txt so the clip is never tracked (and paid for) twice. The steps are a typed XState machine, `src/machines/clipIntake.ts`: `idle → readingScene → tracking → done`, plus `failed` with the reason. Its guards are AppFlow's: a video of at most 5 s and 50 MB, a scene with a usable scale, and a ball tracked on at least 30 frames.
