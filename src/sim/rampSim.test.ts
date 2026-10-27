import { beforeAll, describe, expect, it } from 'vitest';
import { toWorldScene } from '../scene/calibration';
import { FIXTURE_IMAGE_SIZE, FIXTURE_SCENE } from '../scene/fixtures';
import { DEFAULT_SIM_PARAMS, type SimParams } from './params';
import { createPrng } from './prng';
import { initRapier, simulateRamp } from './rampSim';

const scene = toWorldScene(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE);

/** Parameters drawn from a seed, the way the ensemble will sample them. */
function sampleParams(seed: number): SimParams {
  const r = createPrng(seed);
  return {
    muRamp: 0.1 + 0.5 * r(),
    muTable: 0.1 + 0.5 * r(),
    restitution: 0.2 + 0.6 * r(),
    rollingDamping: r(),
    v0: 0.3 * r(),
    omega0: -5 * r(),
  };
}

beforeAll(async () => {
  await initRapier();
});

describe('simulateRamp', () => {
  it('is deterministic: two runs from the same seed are identical', () => {
    const params = sampleParams(42);
    const a = simulateRamp(scene, params, { durationSec: 2 });
    const b = simulateRamp(scene, params, { durationSec: 2 });
    expect(a.samples).toHaveLength(481);
    expect(b.samples).toEqual(a.samples);
  });

  it('changes when the seed changes', () => {
    const a = simulateRamp(scene, sampleParams(1), { durationSec: 1 });
    const b = simulateRamp(scene, sampleParams(2), { durationSec: 1 });
    expect(b.samples.at(-1)).not.toEqual(a.samples.at(-1));
  });

  it('rolls the ball down the ramp and onto the table without tunnelling', () => {
    const { samples } = simulateRamp(scene, DEFAULT_SIM_PARAMS, { durationSec: 2 });
    const end = samples.at(-1)!;
    expect(end.x).toBeGreaterThan(scene.ramp.bottom.x);
    // Resting on (or rolling along) the table line, never below it.
    for (const s of samples) expect(s.y).toBeGreaterThan(scene.table.left.y - scene.ball.radius * 0.5);
    expect(end.y).toBeCloseTo(scene.table.left.y + scene.ball.radius, 2);
  });

  it('a removed block no longer stops the ball', () => {
    const fast: SimParams = { ...DEFAULT_SIM_PARAMS, muTable: 0.05, rollingDamping: 0, v0: 1 };
    const withBlock = simulateRamp(scene, fast, { durationSec: 3 });
    const without = simulateRamp(scene, fast, { durationSec: 3, omitBlockIds: ['blue'] });
    const block = scene.blocks[0]!;
    expect(withBlock.samples.at(-1)!.x).toBeLessThan(block.center.x);
    expect(without.samples.at(-1)!.x).toBeGreaterThan(withBlock.samples.at(-1)!.x);
  });
});
