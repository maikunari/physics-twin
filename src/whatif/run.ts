import type { WorldScene } from '../scene/calibration';
import type { WhatIfEdit } from '../scene/whatIfEdit';
import type { BallKind, SimParams } from '../sim/params';
import { simulateScene } from '../sim/sceneWorld';
import { findEvent, type PathEvent, type PathPoint } from '../predict/events';
import { applyWhatIf, rampAngleDeg } from './applyEdit';

/** The ball is off the table above this height over its resting one, cm (the predict step's lift band). */
const LIFT_CM = 0.5;

/**
 * Where the ball first comes down onto the table after being off it: the
 * first lowest point within `LIFT_CM` of resting height. Read at the lowest
 * sampled point rather than a narrow touch band, so a contact frame the
 * tracker lost, or a fast bounce between frames, still counts as the landing
 * instead of moving it to the next bounce. The same detector reads the
 * simulated path and the measured track.
 */
export function firstLanding(path: readonly PathPoint[], world: WorldScene, untilSec: number): PathEvent | null {
  const low = world.ball.radius + LIFT_CM;
  let airborne = false;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (!p || p.t > untilSec) break;
    if (p.y > low) {
      airborne = true;
      continue;
    }
    const next = path[i + 1];
    if (airborne && (!next || next.t > untilSec || next.y >= p.y)) return { kind: 'touchdown', t: p.t, x: p.x, y: p.y };
  }
  return null;
}

/** How long a what-if runs past the release when the clip's length does not say, s. */
export const DEFAULT_WHATIF_SEC = 3;
export const MAX_WHATIF_SEC = 6;

/** What one scene does with the fitted parameters: where the ball lands off the ramp, the first turnaround (a block hit), and where it ends. */
export interface ScenarioRun {
  readonly world: WorldScene;
  readonly rampAngleDeg: number;
  /** The simulated path, t from the release, world cm. */
  readonly path: readonly PathPoint[];
  readonly untilSec: number;
  /** First landing on the table after the release (`firstLanding`): off the ramp, or the first bounce. */
  readonly landing: PathEvent | null;
  /** First time the ball turns back along the table: the block hit, if it reaches one. */
  readonly turnaround: PathEvent | null;
  readonly end: PathPoint;
}

/** The edited scene's run next to the unedited one, both with the same fitted parameters. */
export interface WhatIfRun {
  readonly edit: WhatIfEdit;
  readonly baseline: ScenarioRun;
  readonly edited: ScenarioRun;
}

export interface WhatIfInputs {
  /** The frozen scene: the take's world, as fitted. */
  readonly world: WorldScene;
  /** The fitted parameters, unchanged by the edit. */
  readonly params: SimParams;
  readonly edit: WhatIfEdit;
  /** How far past the release to run, s. */
  readonly untilSec?: number;
  readonly ballKind?: BallKind;
}

function runScenario(world: WorldScene, params: SimParams, untilSec: number, ballKind: BallKind | undefined): ScenarioRun {
  const sim = simulateScene(world, params, { durationSec: untilSec, ...(ballKind ? { ballKind } : {}) });
  const path = sim.samples.map((s) => ({ t: s.t, x: s.x, y: s.y }));
  const end = path.at(-1);
  if (!end) throw new Error('the simulation produced no samples');
  return {
    world,
    rampAngleDeg: rampAngleDeg(world),
    path,
    untilSec,
    landing: firstLanding(path, world, untilSec),
    turnaround: findEvent(path, world, 'turnaround', 0, untilSec),
    end,
  };
}

/**
 * Plays a what-if on the frozen scene (spec §1, §4): the fitted parameters
 * stay as they are and only the scene changes, so the amber run is the
 * twin's answer to "what if", not a new fit. Runs from the release, since a
 * steeper ramp changes everything after it. Deterministic: the same inputs
 * give the same run. Rapier must be initialised first.
 */
export function runWhatIf(inputs: WhatIfInputs): WhatIfRun {
  const untilSec = Math.min(MAX_WHATIF_SEC, Math.max(0.5, inputs.untilSec ?? DEFAULT_WHATIF_SEC));
  return {
    edit: inputs.edit,
    baseline: runScenario(inputs.world, inputs.params, untilSec, inputs.ballKind),
    edited: runScenario(applyWhatIf(inputs.world, inputs.edit), inputs.params, untilSec, inputs.ballKind),
  };
}
