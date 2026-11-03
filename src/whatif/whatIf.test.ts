import { beforeAll, describe, expect, it } from 'vitest';
import { calibrate, toWorldScene, worldToPixel, type Vec2, type WorldScene } from '../scene/calibration';
import { FIXTURE_IMAGE_SIZE, FIXTURE_SCENE } from '../scene/fixtures';
import type { GridPoint, GroundedScene } from '../scene/schema';
import { DEFAULT_SIM_PARAMS } from '../sim/params';
import { initRapier } from '../sim/sceneWorld';
import { SYNTHETIC_MEASUREMENT, syntheticTruth } from '../synthetic/syntheticProblem';
import { makeSyntheticTake } from '../synthetic/syntheticTake';
import { loadOverlayData, type OverlayData } from '../overlay/overlayData';
import { applyWhatIf, describeEdit, rampAngleDeg } from './applyEdit';
import { compareWhatIf, counterfactualFrom } from './compare';
import { firstLanding, runWhatIf } from './run';

const FPS = 240;
const TRUTH = syntheticTruth(0.08, 0.55);
const cal = calibrate(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE);
const world = toWorldScene(FIXTURE_SCENE, cal);
const close = (a: Vec2, b: Vec2, eps = 1e-9) => Math.hypot(a.x - b.x, a.y - b.y) < eps;

/** World cm back to the 0–1000 grid on the fixture image. */
function toGrid(p: Vec2): GridPoint {
  const px = worldToPixel(cal, p);
  return { x: (px.x * 1000) / FIXTURE_IMAGE_SIZE.width, y: (px.y * 1000) / FIXTURE_IMAGE_SIZE.height };
}

/** The fixture with the change made for real: what Muse Spark would ground on a counterfactual take's frame 0. */
function groundedLike(edited: WorldScene, blocks: GroundedScene['blocks']): GroundedScene {
  return {
    ...FIXTURE_SCENE,
    ramp: { top: toGrid(edited.ramp.top), bottom: toGrid(edited.ramp.bottom) },
    ball: { ...FIXTURE_SCENE.ball, center: toGrid(edited.ball.center) },
    blocks,
  };
}

/** A synthetic take of a scene, loaded as the page loads one. */
function takeOf(scene: GroundedScene, seed: number): OverlayData {
  const take = makeSyntheticTake(scene, FIXTURE_IMAGE_SIZE, TRUTH, { durationSec: 2.2, releaseDelaySec: 0.5, seed, ...SYNTHETIC_MEASUREMENT });
  return loadOverlayData({
    sceneJson: JSON.stringify({ imageSize: FIXTURE_IMAGE_SIZE, markerDistanceCm: 50, scene }),
    samText: take.samText,
    fps: FPS,
    params: DEFAULT_SIM_PARAMS,
  });
}

beforeAll(async () => {
  await initRapier();
});

describe('applyWhatIf', () => {
  it('turns the ramp about its low end, keeping its length and the ball at the same release mark', () => {
    const before = rampAngleDeg(world);
    const edited = applyWhatIf(world, { rampAngleDeg: 40, removeBlockIds: [] });
    expect(rampAngleDeg(edited)).toBeCloseTo(40, 9);
    expect(edited.ramp.bottom).toEqual(world.ramp.bottom);
    const len = (w: WorldScene) => Math.hypot(w.ramp.top.x - w.ramp.bottom.x, w.ramp.top.y - w.ramp.bottom.y);
    expect(len(edited)).toBeCloseTo(len(world), 9);
    // Same distance from the top end and the same height off the surface.
    const fromTop = (w: WorldScene) => Math.hypot(w.ball.center.x - w.ramp.top.x, w.ball.center.y - w.ramp.top.y);
    expect(fromTop(edited)).toBeCloseTo(fromTop(world), 9);
    expect(edited.blocks).toEqual(world.blocks);
    expect(before).not.toBeCloseTo(40, 1);
    // Undoing the edit gives the scene back.
    const back = applyWhatIf(edited, { rampAngleDeg: before, removeBlockIds: [] });
    expect(close(back.ramp.top, world.ramp.top, 1e-9)).toBe(true);
    expect(close(back.ball.center, world.ball.center, 1e-9)).toBe(true);
  });

  it('takes out the named blocks and nothing else', () => {
    const edited = applyWhatIf(world, { rampAngleDeg: null, removeBlockIds: ['blue'] });
    expect(edited.blocks).toEqual([]);
    expect(edited.ramp).toEqual(world.ramp);
    expect(edited.ball).toEqual(world.ball);
    expect(describeEdit({ rampAngleDeg: null, removeBlockIds: ['blue'] }, world)).toBe('without blue block');
  });

  it('refuses a block the scene does not have', () => {
    expect(() => applyWhatIf(world, { rampAngleDeg: null, removeBlockIds: ['red'] })).toThrow(/no block red/);
  });
});

describe('runWhatIf', () => {
  it('is deterministic and leaves the fitted parameters alone', () => {
    const edit = { rampAngleDeg: 40, removeBlockIds: [] };
    const a = runWhatIf({ world, params: TRUTH, edit, untilSec: 2 });
    const b = runWhatIf({ world, params: TRUTH, edit, untilSec: 2 });
    expect(a).toEqual(b);
    expect(a.edited.rampAngleDeg).toBeCloseTo(40, 6);
    expect(a.baseline.rampAngleDeg).toBeCloseTo(rampAngleDeg(world), 9);
  });

  it('a steeper ramp lands the ball sooner', () => {
    const run = runWhatIf({ world, params: TRUTH, edit: { rampAngleDeg: 45, removeBlockIds: [] }, untilSec: 2 });
    expect(run.baseline.landing).not.toBeNull();
    expect(run.edited.landing).not.toBeNull();
    expect(run.edited.landing!.t).toBeLessThan(run.baseline.landing!.t);
  });

  it('without the block the ball no longer turns back', () => {
    const run = runWhatIf({ world, params: TRUTH, edit: { rampAngleDeg: null, removeBlockIds: ['blue'] }, untilSec: 2.2 });
    expect(run.baseline.turnaround?.kind).toBe('turnaround');
    expect(run.edited.turnaround).toBeNull();
    expect(run.edited.end.x).toBeGreaterThan(run.baseline.turnaround!.x);
  });
});

describe('firstLanding', () => {
  const rest = world.ball.radius;
  // Down off the ramp, a contact, up into a bounce, down again: 240 fps samples.
  const bounce = [6, 4, 2, 1, 0.3, 0, 0.35, 1.2, 1.8, 1.2, 0.3, 0].map((h, i) => ({ t: i / 240, x: 40 + i, y: rest + h }));

  it('finds the first landing, not the bounce after it', () => {
    expect(firstLanding(bounce, world, 1)).toMatchObject({ kind: 'touchdown', x: 45 });
  });

  it('still finds it when the contact frame was lost and the nearest frames sit above the touch band', () => {
    const lost = bounce.filter((_, i) => i !== 5);
    expect(firstLanding(lost, world, 1)).toMatchObject({ x: 44 });
  });

  it('needs the ball to have been off the table, and the landing before the limit', () => {
    // Starting on the table: the contact there is not a landing; the one after the bounce is, at its lowest point.
    expect(firstLanding(bounce.slice(5), world, 1)).toMatchObject({ x: 51 });
    expect(firstLanding(bounce, world, 3 / 240)).toBeNull();
    expect(firstLanding([], world, 1)).toBeNull();
  });
});

describe('compareWhatIf against a counterfactual take', () => {
  let baseline: OverlayData;
  beforeAll(() => {
    baseline = takeOf(FIXTURE_SCENE, 1);
  });

  it('reads a take of the unchanged scene as the baseline itself (no camera shift)', () => {
    const same = counterfactualFrom(baseline, 'A02', takeOf(FIXTURE_SCENE, 2));
    expect(same.cameraShiftPx).toBeLessThan(1e-6);
    expect(same.rampAngleDeg).toBeCloseTo(rampAngleDeg(baseline.world), 6);
    expect(same.blockIds).toEqual(['blue']);
  });

  it('the twin with the true parameters matches a steeper take filmed for real', () => {
    const edit = { rampAngleDeg: 38, removeBlockIds: [] };
    const steeper = takeOf(groundedLike(applyWhatIf(baseline.world, edit), FIXTURE_SCENE.blocks), 4);
    const real = counterfactualFrom(baseline, 'B01', steeper);
    expect(real.rampAngleDeg).toBeCloseTo(38, 0);
    const run = runWhatIf({ world: baseline.world, params: TRUTH, edit, untilSec: 2.2 });
    const c = compareWhatIf(run.edited, real, baseline.calibration.pixelsPerCm);
    expect(c.cameraMoved).toBe(false);
    expect(c.trajectory.points).toBeGreaterThan(300);
    // Measurement noise and the release detector only: a few millimetres.
    expect(c.trajectory.rmsMm).toBeLessThan(8);
    expect(c.landing.errorCm).toBeLessThan(1);
    expect(Math.abs(c.landing.errorMs!)).toBeLessThan(10);
  });

  it('the twin with the true parameters matches a block-removed take, and a wrong twin does not', () => {
    const edit = { rampAngleDeg: null, removeBlockIds: ['blue'] };
    const real = counterfactualFrom(baseline, 'C01', takeOf({ ...FIXTURE_SCENE, blocks: [] }, 5));
    expect(real.blockIds).toEqual([]);
    const good = compareWhatIf(runWhatIf({ world: baseline.world, params: TRUTH, edit, untilSec: 2.2 }).edited, real, baseline.calibration.pixelsPerCm);
    expect(good.turnaround.predicted).toBeNull();
    expect(good.turnaround.real).toBeNull();
    expect(good.trajectory.rmsMm).toBeLessThan(8);
    const wrong = compareWhatIf(
      runWhatIf({ world: baseline.world, params: { ...TRUTH, muRamp: 0.02, rollingDamping: 2 }, edit, untilSec: 2.2 }).edited,
      real,
      baseline.calibration.pixelsPerCm,
    );
    expect(wrong.trajectory.rmsMm!).toBeGreaterThan(5 * good.trajectory.rmsMm!);
  });

  it('flags a take whose camera moved, and refuses one filmed at another size', () => {
    const moved = takeOf(
      {
        ...FIXTURE_SCENE,
        table: { left: { x: 50, y: 640 }, right: { x: 970, y: 640 } },
        ramp: { top: { x: 90, y: 360 }, bottom: { x: 330, y: 600 } },
        ball: { ...FIXTURE_SCENE.ball, center: { x: 115, y: 364 } },
        scaleMarkers: [
          { x: 410, y: 660 },
          { x: 710, y: 660 },
        ],
        blocks: [{ id: 'blue', label: 'blue block', box: { x_min: 790, y_min: 560, x_max: 840, y_max: 640 } }],
      },
      6,
    );
    const shifted = counterfactualFrom(baseline, 'A03', moved);
    expect(shifted.cameraShiftPx).toBeGreaterThan(15);
    const run = runWhatIf({ world: baseline.world, params: TRUTH, edit: { rampAngleDeg: null, removeBlockIds: ['blue'] } });
    expect(compareWhatIf(run.edited, shifted, baseline.calibration.pixelsPerCm).cameraMoved).toBe(true);
    const other = { ...baseline, calibration: { ...baseline.calibration, imageSize: { width: 1280, height: 720 } } };
    expect(() => counterfactualFrom(other, 'B02', moved)).toThrow(/not the same camera setup/);
  });
});
