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

Both scripts exit non-zero on failure. Their raw output and summaries are in `smoke-out/`, which is git-ignored. Send that folder back with the clip.

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

## Not yet verified against a live call

The scripts follow Meta's docs (dev.meta.ai, read Oct 27 2026) and have been run end to end only against a local mock of the API. These points still need a real run:

- **Spark structured output:** that `muse-spark-1.3` accepts `text.format` `json_schema` with `strict: true` on a schema this size, with numeric `minimum`/`maximum`, `minItems`/`maxItems`, and an image in the same request.
- **Spark grounding grid:** that grounding replies on the 0–1000 grid when the format comes from our own schema rather than from Meta's grounding prompt formats.
- **Spark image input:** that `input_image` works with a base64 data URL and no `detail` field.
- **Files API upload:** that it accepts a `.mov` with `purpose: "user_data"`, and that the returned `file_id` works in `input_video`.
- **SAM tracking:** that SAM 3.1 honours `metadata.include_confidence: "true"`, `propagation_direction: "forward"` and `mask_encoding: "one_bit"` together. Also that it tracks a small ball at speed on 240 fps footage, which is the real go/no-go.
- **Costs:** prices per frame and per token. Check them on the dashboard after the run.
