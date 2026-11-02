# Day-4 predict: freeze, commitment, ensemble band, reveal, every take's error

After the fit (see [fit.md](fit.md)), the clip is held at the freeze, 1.0 s after the release. The twin plays on past it, a hash of what it says is published, and only then does the real footage play on and get scored.

## What is predicted

The **first event after the freeze**, found by the same detector on the simulation and on the SAM track (`src/predict/events.ts`):

| Event | Means | Typical on the lead scene |
|---|---|---|
| `touchdown` | the ball comes down onto the table after being off it | the landing off the ramp, if it is still in the air at the freeze, or a bounce |
| `turnaround` | the ball stops going one way along the table and comes back | the block hit |
| `horizon` | neither happened before the horizon, so: where the ball is at the horizon | block removed, ball rolling on |

On a 60 cm ramp at about 20° the ball has already landed off the ramp before 1.0 s, so the committed event is usually the block hit. The horizon is 1.0 s past the freeze, or the end of the clip if that comes first (the clip's length comes from the block tracks, not the ball's).

## The band

Twelve runs with parameters sampled around the fit (`src/predict/ensemble.ts`): μ_ramp, e and the release-time correction are drawn from the Gauss–Newton covariance of the window fit, s²(JᵀJ)⁻¹, with the residual variance s² inflated for residuals that are correlated over 50 ms, and each spread held between a floor and a cap. The seed is fixed, so a fit always gives the same twelve runs. The band is the range of the event's position and time over the runs that have it ("12/12 runs" says how many do), plus the fitted run.

This is the fit's statistical uncertainty only. It does not include model error: no air drag, rolling loss as angular damping, and μ_table and rolling damping held at their defaults because the first second barely moves them. Past a block hit those held parameters set how the ball rolls back, so expect the band to be narrow and the end-of-horizon error to grow. The reveal measures that, and the UI says in red when reality falls outside the band.

## Commitment

`src/predict/commitment.ts`: the SHA-256 of the prediction's canonical text (take name, freeze and horizon, the fitted run with its event and end point, the band, and every sampled run's parameters, rounded past anything the reveal measures). The page shows the first 12 characters and the full hash while the clip is held, and logs the hash and the text to the console. After the reveal it recomputes the hash from the prediction and shows whether it still matches. The same take gives the same hash in the browser and in Node.

## No peeking

- The prediction is built from a `FitProblem`, which holds no measured point past the freeze. The full track is read only after the commitment exists.
- `src/predict/prediction.test.ts`: footage after the freeze replaced with nonsense gives an identical prediction and hash.
- `src/predict/takeRun.test.ts`: the whole pipeline on a take whose ball track is rewritten from 1.05 s on gives the same fit, prediction and hash; only the score changes.
- The page holds the video at the freeze until **Reveal** (playing or seeking past it snaps back).

## Errors (spec §5)

`src/predict/reveal.ts`, for the committed event kind:

- event error: distance between predicted and real event in **cm** and **px** (cm × the calibration's px/cm, exact for a side-on camera), and real minus predicted time in **ms** (none for a horizon event, whose time is fixed);
- inside the band: position and time both within the band (padded by one pixel and one frame); an event that never happened counts as outside;
- where the ball was at the horizon, cm and px;
- trajectory RMS from the freeze to the horizon, **mm** and px.

## The predict flow machine

`src/machines/predictFlow.ts` (XState, transition tests in `predictFlow.test.ts`):

`frozen → predicting → committed → revealing → result`, plus `failed`, and `RESET` back to `frozen` from any later state. The reveal needs a commitment, and an outcome only counts if it scores the committed hash. It is AppFlow's `frozen → predicting → revealing → result` with the commitment as its own state, so the hash is on screen before the footage moves. The results script runs every take through the same machine.

## On the page

`npm run dev`, load a clip with its `scene.json` and `sam-raw.txt`, fit, then **Freeze and predict**. The amber lines are the twelve runs, the yellow bar is the band, the cyan ring is the predicted event. **Reveal** plays the footage on from the freeze (pick 0.25× first for slow motion); the real event is ringed green inside the band or red outside it, with the errors under the video. A new fit drops the old prediction.

## Every take: `npm run results`

```sh
npm run results -- ~/physics-twin/footage/2026-10-30            # takes already tracked
MODEL_API_KEY=... npm run results -- ~/physics-twin/footage/2026-10-30 --track   # track the rest first
```

A take is a video (`A01.mov`) and/or a folder `A01/` with its `scene.json`, `sam-raw.txt` and `sam-summary.json` (the smoke scripts write these with `--out A01`). `--track` trims each untracked video to its first 3 s and runs `smoke-spark.ts` and `smoke-sam.ts` into its folder. With a key the fit uses the Muse Spark agent; `--no-agent` or no key fits with Nelder–Mead alone.

It writes to `<folder>/results/`:

| File | Holds |
|---|---|
| `results.csv` | one line per take found: fit, commitment, predicted event and band, real event, errors in cm / px / ms, trajectory RMS |
| `results.md` | the same as a rendered table, a summary per set (A baseline, B steeper, C block removed, D both) with mean and worst errors, and every take left out with why |
| `predictions.jsonl` | each take's commitment and its canonical text, appended before that take's reveal |
| `runs.json` | everything, for checking |

Every take found is listed, whatever happened to it: an untracked take is `excluded` with the files it is missing, a take the pipeline could not run is `failed` with the error. Means and worsts are over every run, not only the good ones.

## Final takes: what to send

No final takes were on this machine when this was built (none under `~/physics-twin/footage/`, the folder the filming guide names, or in the repo or data folders), so everything above has run on synthetic takes only. To run the real ones:

1. Copy the original, untrimmed files onto this machine at `~/physics-twin/footage/2026-10-30/` (or the filming date), named `A01.mov … A10.mov`, `B01.mov … B10.mov`, `C01.mov … C10.mov` (and `D01–D05` if filmed). From an iPhone, AirDrop with **Options → All Photos Data** so the 240 fps slo-mo original arrives, not a 30 fps render.
2. Put `notes.txt` (phone model and fps, ramp angle per set, ramp length, tape-mark distance, ball type and diameter, block size and distance from the ramp end, anything odd about a take) and the setup photo in the same folder.
3. Run `MODEL_API_KEY=... npm run results -- ~/physics-twin/footage/2026-10-30 --track`. SAM bills per frame: 30 takes × 3 s × 240 fps is about 21,600 frames.

## Synthetic run

Five synthetic takes (fixture scene, 0.7 px jitter, 5% lost frames, 3% wrong boxes, 2.2 s after release) and one video with no tracks, Nelder–Mead only:

| Take | True μ ramp, e | Event | Error cm / px / ms | Inside band | Trajectory RMS mm |
|---|---|---|---|---|---|
| A01 | 0.08, 0.55 | turnaround | 0.15 / 1.7 / 0.0 | yes | 19.1 |
| A02 | 0.03, 0.45 | horizon | 2.09 / 24.1 / — | yes | 10.6 |
| A03 | 0.12, 0.70 | turnaround | 0.12 / 1.3 / 0.1 | yes | 14.9 |
| A04 | 0.05, 0.30 | turnaround | 0.15 / 1.8 / 0.2 | yes | 7.3 |
| A05 | 0.10, 0.60 | turnaround | 0.15 / 1.7 / −0.1 | yes | 16.7 |
| A06 | (video only) | excluded: not tracked | | | |

On the fixture the ball reaches the block a couple of milliseconds after the freeze, so the turnaround is an easy call; the trajectory RMS afterwards (7–19 mm) is the roll back from the block, which runs on the held μ_table 0.3 against the synthetic truth's 0.25. Real takes, with the block further out, will test the prediction properly.
