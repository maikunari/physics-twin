# Day-3 fit: Nelder–Mead and the Muse Spark fitting agent

The fit tunes the simulation until it matches the measured ball over the **first 1.0 s after the release**, and reads nothing after it. Everything past that on the overlay is the fitted simulation running on its own (drawn violet).

## How one fit runs

The FitLoop machine (`src/machines/fitLoop.ts`) drives it, in a Web Worker (`src/fit/fit.worker.ts`):

1. **Release refinement, once.** The release is detected from the track to about a frame, and 2 ms of error moves μ_ramp by about 0.007. On the ramp the ball accelerates uniformly, so its path pins down both μ_ramp and when it started; a golden-section search over that ramp-only profile picks a correction of up to ±20 ms, held for the rest of the fit (`fitReleaseShift`).
2. **Propose.** Muse Spark gets the best run's error per segment (ramp, flight, bounce, roll: RMS, mean offset, worst miss), may call `simulate` up to 3 times, then calls `propose` with parameters and a one-line note for the log. Every tool argument and result goes through zod; a bad argument goes back to the model as an error.
3. **Fine-tune.** Nelder–Mead (`src/fit/nelderMead.ts`) starts from the proposal: μ_ramp on the ramp segment, then μ_ramp and e on the whole window, from the proposed e and two spread ones.
4. **Simulate and score** the result on the window. Repeat until the RMS is down to the tracker's noise (1 mm) or after 6 iterations, and keep the best run.

If the agent fails (no key, a timeout, a reply without a tool call), the loop logs why and carries on with Nelder–Mead alone, restarting from a spread of e values. μ_table, rolling damping, v0 and ω0 are held: they barely move the first second.

## Synthetic results

Fixture scene, 0.7 px jitter, 5% lost frames, 3% wrong boxes (`src/fit/session.test.ts`, `src/overlay/overlayData.test.ts`):

| Path | Stated tolerance | Seen |
|---|---|---|
| Release at frame 0 | Δμ_ramp ≤ 0.002, Δe ≤ 0.05 | Δμ ≤ 0.0004, Δe ≤ 0.017 over 6 truths |
| Release detected from the track (as on real takes) | release ≤ 0.5 ms, Δμ_ramp ≤ 0.003, Δe ≤ 0.05 | release ≤ 0.35 ms, Δμ ≤ 0.0023, Δe ≤ 0.02 |

One limit seen: the whole-window error is jagged where a bounce decides whether the ball reaches the block before the freeze, so a local search can settle in a nearby basin (one synthetic take from a stand-in agent's starts ended at e 0.45 against a true 0.55, RMS 3.1 mm). The numeric restarts and the spread e starts are there for this; the RMS shown after every fit says how well it worked.

## No peeking

The fit window is cut before anything reaches the worker, again inside it, and the agent only sees scores computed from that cut. The tests replace every point after 1.0 s with a wildly wrong one and check the fit, its log, and every byte sent to the model stay identical.

## The agent's API key

The browser never holds the key. On `npm run dev`, `/api/spark` (in `vite.config.ts`) forwards only the agent's own request shape to the Meta Model API with `MODEL_API_KEY` from the shell or a git-ignored `.env.local`. Without a key it answers 503 and the fit runs numeric-only, which the log says. The deployed `/api/agent` replaces it on day 5.

From the terminal, the same loop:

```sh
MODEL_API_KEY=... npm run fit -- smoke-out/scene.json smoke-out/sam-raw.txt   # --no-agent for Nelder–Mead alone
```

Not yet verified against a live call: that `muse-spark-1.3` accepts function tools with `strict: true`, `tool_choice: "required"` and `parallel_tool_calls: false`, and a stateless conversation that resends `function_call` and `function_call_output` items. It has run end to end against a local mock of the Responses API only.
