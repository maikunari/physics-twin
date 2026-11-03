# Day-7 live calls: the Meta Model API on a synthetic clip

The API key arrived on Nov 3, so day 7 made the first live calls to SAM 3.1 and Muse Spark 1.3. No real take exists, so every call ran on **synthetic** input: preset A's clip, drawn from the simulation with known parameters (μ ramp 0.08, e 0.55), not filmed. What follows is **real Meta API output on a synthetic scene**. About 82 calls in all, against the local dev server and the smoke scripts; the deployed site was not used.

| What ran | How | Calls | Result |
|---|---|---|---|
| Muse Spark grounding, frame 0 | `scripts/smoke-spark.ts` | 1 | Valid scene in 12 s. Block and table ends within 2 px; ball and tape marks 27 px (2.3 cm) off; ramp ends 42–51 px (about 4 cm) off. Ramp read at 27.0°, true 29.4°. The marks moved together, so the scale (11.52 px/cm) was right. |
| SAM 3.1, prompted with Spark's boxes | `scripts/smoke-sam.ts` | 1 | Spark's ball box sat half on the ramp; SAM held a piece of the ramp: a box on 204 of 649 frames, lost after frame 205, mean confidence 0.58. Block tracked on all 649 at 0.97. **NO-GO.** |
| SAM 3.1, prompted with a box drawn on the ball | `scripts/smoke-sam.ts --box 180,372,222,414` | 1 | The ball on 649 of 649 frames, mean confidence 0.93, largest jump 10 px. **GO.** |
| Fitting agent, first try | `/api/agent` | 1 | Rejected: `only "auto" is supported for tool_choice`. The fit fell back to Nelder–Mead alone, as designed. Fixed (see below). |
| Fitting agent on preset A (take A) | `/api/agent` | ~49 over three fits | Each turn the agent called `simulate` up to three times, then proposed with a reason. The fit used in the demo video: 5 iterations, converged, μ ramp 0.080, e 0.551, RMS 0.97 mm. |
| Fitting agent on the live tracks (take L) | `/api/agent` | ~24 | Same clip, with the live Spark scene and the hand-prompted SAM track. The shallow ramp pushed the fit to μ ramp 0.013, RMS 14.9 mm. |
| What-if text edit | `/api/whatif` | 3 | "What if the ramp were tilted to 38 degrees?" became ramp 29.4° → 38.0° every time. |
| Page upload path | `/api/scene` + `/api/track` | 2 | Clip only, through the thin server (video sent inline). Scene and tracks came back and loaded; the ball was kept on 183 frames (133 dropped for low confidence, 261 missing), consistent with Spark's ball box straddling the ramp. |

## Predictions from the live runs

| Take | Inputs | Event error | Inside band | Trajectory RMS |
|---|---|---|---|---|
| A | Preset A (synthetic scene and tracks), live fitting agent | 0.20 cm · 2.3 px · 0.0 ms | yes | 18.7 mm |
| L | Same clip, live Spark scene + live SAM track (hand-drawn ball box), live fitting agent | 1.10 cm · 12.7 px · −1.5 ms | **no** | 16.5 mm |

What-if on take A's fit, scored on the synthetic counterfactual presets:

| What-if | Against | Landing | First turnaround | Trajectory RMS |
|---|---|---|---|---|
| Ramp 38° (Muse Spark text edit) | Preset B (synthetic) | **27.49 cm** · 316.7 px · 168.3 ms | 0.15 cm · 1.8 px · 1.7 ms | 112.9 mm |
| Blue block removed (slider) | Preset C (synthetic) | 0.06 cm · 0.7 px · 0.1 ms | — | 1.8 mm |

The 27 cm landing gap on B is not explained yet. Preset B was built by applying this same edit to scene A, so the geometry matches; the twin's first touchdown is at 51.6 cm and the one detected on B's track is at 79.1 cm. The day-5 what-if table (different synthetic B takes) had 0.10 cm mean. Its trajectory RMS also moves with the fit: 28–32 mm on two earlier agent fits of the same preset, 112.9 mm on this one.

## What changed because of them

- **`tool_choice: "auto"`.** Muse Spark rejects `"required"`, so the agent sends `"auto"`; a turn that comes back as text only is sent back with "Answer with a tool call", and fails after the usual round budget, keeping the model's last words in the error.
- **Wording.** The reveal said "play the real footage" and "Reality landed inside the band" on synthetic presets. It now says "play the clip", "The tracked ball landed…", "(tracked minus predicted)", and the counterfactual form says "Counterfactual take" rather than "Real counterfactual take".

## Still open

- Spark's ramp ends and ball box are off by 2–4 cm on this flat-shapes frame. That cost take L its band and sent SAM onto the ramp. Prompting SAM from Spark's box needs a check (or a second prompt frame) before real takes.
- Nothing here says how SAM or Spark do on real footage. There is none yet.

The raw outputs (scene.json, sam-raw.txt, summaries) are kept outside the repo, with the day-7 video material.
