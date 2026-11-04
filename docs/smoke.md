# Day-1 smoke tests: SAM 3.1 and Muse Spark

Two scripts check that the Meta Model API does what Physics Twin needs, using one real test take. Run them before going further: they are the go/no-go.

| Script | Checks |
|---|---|
| `scripts/smoke-spark.ts` | Muse Spark 1.3 reads frame 0 into the scene JSON (ramp, table, blocks, ball, tape marks). The reply must pass the zod schema, and the scale has to be found. |
| `scripts/smoke-sam.ts` | SAM 3.1 tracks the ball (and blocks) through the clip from box prompts on frame 0, with confidence. The output is parsed with `@meta-sam/parser`, then a GO / NO-GO verdict is printed for the ball track. |

## Before you start

- Node 20 or newer, and `npm ci` in the repo.
- ffmpeg (`brew install ffmpeg`), which reads the clip's size, rotation and fps and pulls out frame 0.
- Your Model API key. Pass it on the command line as shown below. Never commit it. `.env*` files are git-ignored if you keep it in one.
- A test take, side-on, with both tape marks in frame. Trim it to 3 s or less, since SAM bills per frame:

  ```sh
  mkdir -p clips   # git-ignored
  ffmpeg -ss 0 -t 2 -i ~/Downloads/IMG_0001.MOV -c copy clips/take1.mov
  ```

## Run

1. **Scene from frame 0 (Muse Spark):**

   ```sh
   MODEL_API_KEY=... npx tsx scripts/smoke-spark.ts clips/take1.mov
   ```

   This writes `smoke-out/scene.json` and `smoke-out/scene-overlay.jpg`. Open the overlay and check the boxes:

   | Colour | Should sit on |
   |---|---|
   | Orange | The ball |
   | Blue | The blocks |
   | Red | The ramp ends |
   | Green | The table ends |
   | Magenta | The tape marks |

   If the marks are not 50 cm apart, add `--marker-cm <distance>`.

2. **Tracking (SAM 3.1):**

   ```sh
   MODEL_API_KEY=... npx tsx scripts/smoke-sam.ts clips/take1.mov
   ```

   This takes its box prompts from `smoke-out/scene.json`. To prompt the ball by hand instead, pass `--box left,top,right,bottom` in displayed pixels. The clip goes up through the Files API. If that upload fails, add `--inline` to send it as a data URL instead.

   The first line it prints should show about 240 fps. If it shows 30 fps, the phone sent a rendered copy rather than the original slo-mo; re-send it with AirDrop **Options → All Photos Data**.

Both scripts exit non-zero on failure. Their raw output and summaries are in `smoke-out/`, which is git-ignored (or in `--out <dir>`, which the day-4 results script uses for one folder per take). Send that folder back with the clip.

## Reading the verdict

`smoke-sam.ts` says **GO** when all of these hold for the ball:

- It has a box on at least 30 frames (AppFlow's `TRACKS_READY` guard).
- It has a box on at least 90% of the first second's frames (the fit window).
- Its mean confidence is at least 0.5.
- Its box centre never jumps more than 1.5 ball diameters in one frame. A bigger jump usually means the tracker hopped to another object.

These thresholds are a first guess. They get tuned once real takes are in.

**On NO-GO** (spec §9), try these before building further:

- Use a brighter or bigger ball (a golf ball rather than a marble).
- Use a dark matte backdrop and more light.
- Make sure the take really is 240 fps.
- Prompt the ball on more than one frame. The script prompts frame 0 only today.

## Checked against live calls (Nov 3)

The first live runs were on a **synthetic** clip (preset A, drawn from the simulation; no real take exists yet). [live-calls.md](live-calls.md) has the full record. Against the points this section used to list:

- **Spark structured output:** works. `muse-spark-1.3` took `text.format` `json_schema` with `strict: true` on this schema, with the image in the same request, and the reply passed the zod schema.
- **Spark grounding grid:** replies are on the 0–1000 grid. The block and table ends came back within 2 px; the ramp ends were 42–51 px (about 4 cm) off and the ball and tape marks 27 px, so the ramp read as 27.0° against a true 29.4°.
- **Spark image input:** a base64 data URL with no `detail` field works.
- **Files API upload:** accepted an `.mp4` with `purpose: "user_data"`, and the `file_id` worked in `input_video`. A `.mov` has not been tried.
- **SAM tracking:** SAM 3.1 honoured `include_confidence`, `propagation_direction` and `mask_encoding` together: every record came back with a box, a one-bit mask and a confidence. Prompted with Spark's ball box, which sat half on the ramp, it held a piece of the ramp (NO-GO). Prompted with a box drawn on the ball (`--box`), it held the ball on all 649 frames at 240 fps, mean confidence 0.93 (GO). Whether it holds a real ball on real footage is still open.
- **Fitting agent:** the first live call was rejected: Muse Spark accepts only `"auto"` for `tool_choice`. The agent now sends `"auto"` and asks again when a turn comes back as text only.
- **Costs:** not checked yet; look on the dashboard.
