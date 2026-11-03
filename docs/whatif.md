# Day-5 what-if: sliders, Muse Spark text edits, and the real counterfactual takes

After the reveal, the fitted twin answers "what if the ramp were steeper, or the block gone?" on the same clip. The scene changes and the fitted parameters do not, so the amber ghost is the twin's prediction, not a new fit.

## The edit

`src/scene/whatIfEdit.ts` (zod): a new ramp angle (above 0°, at most 60°, or null to keep it) and the ids of blocks to take out. An edit that changes nothing, an angle out of range, extra fields or a block the scene does not have are refused, never clamped (`validateEdit` in `src/whatif/textEdit.ts`, the one check the server and the page both run).

`src/whatif/applyEdit.ts` applies it to the world scene:

- **Ramp angle:** the ramp turns about its low end and keeps its length, the way the filming guide steepens it (raise the book stack under the high end; the low end stays on its block). The ball keeps its place along the ramp (the same release mark) and its offset from the surface.
- **Remove block:** the block is left out of the Rapier world.

`src/whatif/run.ts` runs the edited scene and the unedited one with the same fitted parameters, from the release, and reads where the ball lands off the ramp, where it first turns back (a block hit), and where it ends. Deterministic: the same fit and edit give the same run.

The landing is the first lowest point within 0.5 cm of the table after the ball has been off it (`firstLanding`). The Day-4 touchdown detector needs a sample inside a 0.25 cm band; on a synthetic block-removed take with 5% lost frames it missed the landing and found the next bounce, 19.6 cm further on. The lowest-point rule found the same landing as the twin's path, 0.66 cm and one frame off.

## On the page

Once a take has been predicted and revealed (AppFlow `result → whatIf`), the **What if** panel appears under the prediction:

- **Sliders:** the ramp angle (5°–60°) and a checkbox per block. Each change is an edit at once.
- **Muse Spark:** type "what if the ramp were twice as steep and the blue block gone?" and the page posts it to `/api/whatif` with the scene's current ramp angle and its blocks (ids and labels; no image, no track). Muse Spark answers with structured output (`json_schema`, strict), and the edit goes through the same zod check. "Twice as steep" means twice the angle; a request it cannot express (add a cup, change the ball) comes back as an empty edit with a note, and is refused with that note.

The overlay draws the edited ramp in amber, crosses out a removed block, shows the new path faintly with the amber ball moving on it as the clip plays, and marks where it lands. The table under the panel puts the fitted scene and the what-if side by side.

The what-if flow is a typed XState machine, `src/machines/whatIfFlow.ts`, with transition tests in `whatIfFlow.test.ts`:

`idle → asking → running → shown`, plus `failed`, and `CLEAR` back to `idle`. A slider edit that fails the check is ignored; a Muse Spark edit that fails it goes to `failed` with the reason and the model's note. A run only shows if it is the run of the current edit, so a slow run for an old slider position cannot overwrite a newer one, and a late Muse Spark answer after Clear changes nothing.

## Against the real counterfactual takes

The filming guide films each change for real: set B (ramp ~32°), C (blue block removed), D (both, optional). Scoring the amber run against one of those takes is the honest check of a what-if.

**On the page:** under the panel, load a counterfactual take's `scene.json` and `sam-raw.txt`. The panel shows landing and first-turnaround error (cm, px, ms), position error at the last time both cover, and trajectory RMS (mm, px).

**For every take:** `npm run whatif -- <folder>` fits every set-A take (first second only, Nelder–Mead alone), makes the B/C/D what-if from each, and scores every counterfactual take against every baseline. It writes `whatif.csv` (every pair) and `whatif.md` (mean and worst per set and per take, and every pair left out with why) to `<folder>/results/`.

```sh
npm run results -- ~/physics-twin/footage/2026-10-30 --track   # tracks every take once (MODEL_API_KEY), and the day-4 table
npm run whatif -- ~/physics-twin/footage/2026-10-30            # --angle 32 to ask for a fixed angle instead of each B take's own
```

How the comparison stays fair (`src/whatif/compare.ts`):

- The what-if is made from the baseline take's fit alone. The counterfactual take's motion is read only when it is scored.
- **Its setup is read.** With the default `--angle from-take`, the B what-if asks for the ramp angle Muse Spark read on that B take's own frame 0: the condition that was filmed, not the result. The page shows the real angle next to the one asked, and says in red when they differ by more than 2°, or when the real take still has a block the what-if removed.
- The counterfactual take's ball pixels go through the **baseline's** calibration: the camera did not move between takes, so the same pixel is the same place. If its table origin or ramp foot sits more than 8 px from the baseline's, the comparison is flagged (camera or table moved). A take filmed at another frame size is refused.
- Both runs start from their own detected release, with the same detector as every take.

## Synthetic run

No real takes were on this machine when this was built (`~/physics-twin/footage/` does not exist), so this has run on synthetic takes only: the fixture scene with one set of true parameters (μ ramp 0.08, e 0.55, μ table 0.25), 0.7 px jitter, 5% lost frames, 3% wrong boxes; A01–A03 baseline, B01–B03 with the ramp at 38°, C01–C03 with the block removed.

| Set | Pairs | Landing error cm (mean / worst) | Landing time error ms, abs (mean / worst) | Trajectory RMS mm (mean / worst) |
|---|---|---|---|---|
| B (38°) | 9 | 0.10 / 0.16 | 1.2 / 1.6 | 21.3 / 23.4 |
| C (no block) | 9 | 0.30 / 0.66 | 2.7 / 5.6 | 2.3 / 2.7 |

The B trajectory RMS is the roll back off the block. With the true parameters the same B01 scores 1.4 mm; with the fit it is 1.9 mm up to 1.0 s, 7.0 mm to 1.5 s, and 23.4 mm to 2.2 s. The difference is μ_table and rolling damping, which the fit holds at 0.3 and 0.2 (the first second barely moves them) against the synthetic truth's μ_table 0.25. Real takes will show how much of that is there for real.

## What Mike needs to provide

To run this on the real counterfactual takes:

1. The original takes in one folder on this machine, e.g. `~/physics-twin/footage/2026-10-30/`: `A01.mov … A10.mov` (baseline ~20°, block present), `B01.mov … B10.mov` (steeper ~32°, same release mark, block present), `C01.mov … C10.mov` (baseline angle, blue block removed), and `D01–D05` if filmed. AirDrop with **Options → All Photos Data** so the 240 fps original arrives.
2. `notes.txt` in the same folder (phone and fps, ramp angle per set, ramp length, tape-mark distance, ball, block size and position) and the setup photo.
3. The camera must not move between sets: the comparison reads every take through the baseline's calibration and flags a shift over 8 px.

Then `MODEL_API_KEY=... npm run results -- <folder> --track` once (tracks every take), and `npm run whatif -- <folder>`.
