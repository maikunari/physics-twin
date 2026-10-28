# Day-2 overlay page

`npm run dev` opens the overlay page. It plays a local clip and draws three things on top of it, in step with the video:

| Drawn | Colour | From |
|---|---|---|
| SAM masks for the frame on screen | orange (ball), blue (blocks) | `sam-raw.txt` |
| The measured ball trail so far | cyan line | `sam-raw.txt` → trajectories in cm |
| The simulated ball and its path | white circle, dashed line | `scene.json` → Rapier, started at the detected release |

Load three files: the clip, its `scene.json` (from `smoke-spark.ts`) and its `sam-raw.txt` (from `smoke-sam.ts`). The frame rate defaults to 240 fps. The tape-mark distance comes from `scene.json` unless you type another one. Under the summary you can change μ ramp, μ table and e, or press **Fit μ ramp and e** to run the day-2 numeric fit on the first second after release.

## Without footage

```sh
npm run synthetic -- --out smoke-out/synthetic   # optional: --mu 0.08 --e 0.55 --seed 1 --delay 1
```

This simulates the fixture scene with known μ ramp and e and writes `synthetic.mp4` (240 fps), `scene.json`, `sam-raw.txt` and `truth.json`. Load the first three on the page. The masks in synthetic SAM output are a placeholder raster stretched over each box, because the parser has no mask encoder; real SAM output has the real shapes.

## Still to check on real footage

- That the clip plays at real speed in your browser: an iPhone slo-mo `.mov` should hold 240 fps frames. If the page's time and frame numbers disagree with the clip, set the frame rate the first line of `smoke-sam.ts` reports.
- That `scene.json` was read on the same clip. The page warns when the clip's shape does not match the frame the scene was read on.
