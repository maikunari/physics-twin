# Day-6 presets: three scenes that run with the API off

The overlay page opens with three preset buttons, one per configuration in the filming guide: **A** baseline (ramp and blue block), **B** steeper ramp, **C** blue block removed. A preset is a clip with its cached Muse Spark `scene.json` and SAM 3.1 `sam-raw.txt`, served with the site from `public/presets/`, so loading one calls no API. Everything after that runs in the browser: the fit (Nelder–Mead in its worker; the agent's call fails with the kill switch's 503, the log says so, and the fit carries on numeric-only), freeze, commitment, band, reveal, and the what-if with sliders. In the what-if panel, the B and C presets can be loaded as the counterfactual take with one click.

The list lives in `src/presets/manifest.json` (checked with zod in `src/presets/schema.ts`), written by `npm run presets`.

## The presets are synthetic for now

No real takes were on the build machine on day 6 (`~/physics-twin/footage/` did not exist), so all three presets are **synthetic**: the fixture scene (B with the ramp turned to 38°, C with the block taken out) simulated with one set of true parameters (μ ramp 0.08, e 0.55, μ table 0.25, rolling damping 0.2), "filmed" as SAM 3.1 output with 0.7 px jitter, 5% lost frames and 3% wrong boxes, and drawn as a flat-shapes 240 fps clip. The page marks each one *Synthetic: drawn from the simulation with known parameters, not filmed* and shows the true values, and calls a synthetic counterfactual "synthetic (not filmed)", never "real".

What they show, through the same `runTake` path as `npm run results` (Nelder–Mead alone, first 1.0 s after the release):

| Preset | Fit RMS mm | μ ramp | e | Event | Band (cm) | Real (cm) | Error cm / px / ms | Inside band | Trajectory RMS mm |
|---|---|---|---|---|---|---|---|---|---|
| A baseline | 1.10 | 0.0802 | 0.562 | turnaround (block hit), 12/12 runs | 119.5–120.7 | 119.9 | 0.18 / 2.1 / 0.0 | yes | 26.5 |
| B steeper, 38° | 1.24 | 0.0802 | 0.550 | horizon at 2.0 s, 12/12 runs | 68.6–73.0 | 74.4 | 4.50 / 51.8 / — | **no** | 24.6 |
| C block removed | 0.91 | 0.0802 | 0.545 | horizon at 1.27 s (leaves the frame), 12/12 runs | 159.2–161.5 | 159.9 | 1.48 / 17.0 / — | yes | 3.0 |

**B misses its band, and the page says so in red.** The fit recovers μ ramp and e, but holds μ table and rolling damping at 0.3 and 0.2 (the first second barely moves them; the synthetic truth has μ table 0.25), and the band spreads only μ ramp and e. On B the ball hits the block hard and rolls back for a full second, so the held table friction adds up to 4.5 cm by the 2.0 s horizon. This is the same limit the day-5 what-if table showed (B trajectory RMS 21 mm), and it is kept on the site rather than swapped for a take that lands inside.

## Swapping in real takes

Once the final takes are on this machine and tracked:

1. Put the original videos in one folder, e.g. `~/physics-twin/footage/2026-10-30/`, named by set and number: `A01.mov … A10.mov`, `B01.mov … B10.mov`, `C01.mov … C10.mov` (filming guide §4–5).
2. Track every take once (needs `MODEL_API_KEY`; costs SAM 3.1 frames and one Muse Spark call per take):
   `npm run results -- ~/physics-twin/footage/2026-10-30 --track`
   This leaves `A01/scene.json` and `A01/sam-raw.txt` (and so on) next to the videos, and the every-take table in `results/`.
3. Pick one take per set (state which in the README; picking the best one is fine only with the every-take table next to it) and swap them in:
   `npm run presets -- --from ~/physics-twin/footage/2026-10-30 --takes A03,B02,C05`
   Each take's set letter picks the slot it replaces; slots not named keep what they had. The video is re-encoded to H.264 MP4 (iPhone HEVC does not play in Chrome) at its own frame rate, 1280 px wide (`--width` to change). Its `scene.json` and `sam-raw.txt` are copied unchanged. The manifest entry becomes `source: "recorded"`, labelled *Recorded run, take A03: cached SAM 3.1 tracks and Muse Spark scene*.
4. `npm test` checks that every preset's files exist, its clip is under 25 MB, B is steeper than A and C has no blocks, and that each preset fits, commits and reveals with no API. The parameter-recovery checks apply to synthetic presets only.

`npm run presets` with no arguments rebuilds the synthetic three.
