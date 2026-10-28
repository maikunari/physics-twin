import { describe, expect, it } from 'vitest';
import { calibrate, worldToPixel, type PixelBox } from '../scene/calibration';
import { FIXTURE_IMAGE_SIZE, FIXTURE_SCENE } from '../scene/fixtures';
import { formatSamFrameLine, parseSamText, type TrackedObject } from './samText';
import { tracksToTrajectories } from './trajectories';

const cal = calibrate(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE);
const objects: TrackedObject[] = [
  { id: '1', kind: 'ball', label: 'ball' },
  { id: '2', kind: 'block', label: 'blue block' },
];

/** A 20 px box centred on the pixel position of a world point (cm). */
function boxAtWorld(x: number, y: number): PixelBox {
  const p = worldToPixel(cal, { x, y });
  return { left: Math.round(p.x) - 10, top: Math.round(p.y) - 10, right: Math.round(p.x) + 10, bottom: Math.round(p.y) + 10 };
}

const line = (frame: number, ...records: Parameters<typeof formatSamFrameLine>[1]) =>
  formatSamFrameLine(frame, records, FIXTURE_IMAGE_SIZE);

describe('formatSamFrameLine', () => {
  it('writes lines the SAM parser reads back without diagnostics', () => {
    const box = { left: 100, top: 300, right: 120, bottom: 320 };
    const { records, diagnostics } = parseSamText(line(7, { objectId: '1', box, confidence: 0.8 }));
    expect(diagnostics).toEqual([]);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ kind: 'box', objectId: '1', frame: { frameIndex: 7 }, ...box, confidence: 0.8 });
    expect(records[1]).toMatchObject({ kind: 'mask', bounds: box });
  });
});

describe('tracksToTrajectories', () => {
  it('converts box centres to cm in the world frame with 240 fps timestamps', () => {
    const text = line(0, { objectId: '1', box: boxAtWorld(10, 30), confidence: 0.9 }) +
      line(1, { objectId: '1', box: boxAtWorld(11, 29), confidence: 0.9 });
    const [ball] = tracksToTrajectories(parseSamText(text).records, objects, cal);
    expect(ball!.fps).toBe(240);
    expect(ball!.points.map((p) => p.frame)).toEqual([0, 1]);
    expect(ball!.points[1]!.t).toBeCloseTo(1 / 240);
    // Boxes snap to whole pixels, so positions are good to half a pixel (< 0.05 cm at 11.5 px/cm).
    expect(ball!.points[0]!.x).toBeCloseTo(10, 1);
    expect(ball!.points[0]!.y).toBeCloseTo(30, 1);
    expect(ball!.points[1]!.x).toBeCloseTo(11, 1);
    expect(ball!.points[1]!.y).toBeCloseTo(29, 1);
    const box = boxAtWorld(10, 30);
    expect(ball!.points[0]!.px).toEqual({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });
  });

  it('uses the clip frame rate it is given', () => {
    const [ball] = tracksToTrajectories(parseSamText(line(60, { objectId: '1', box: boxAtWorld(5, 5) })).records, objects, cal, {
      fps: 120,
    });
    expect(ball!.points[0]!.t).toBeCloseTo(0.5);
  });

  it('sorts out-of-order frames and keeps the first record of a repeated frame', () => {
    const text = [2, 0, 1].map((f) => line(f, { objectId: '1', box: boxAtWorld(10 + f, 30), confidence: 0.9 })).join('') +
      line(1, { objectId: '1', box: boxAtWorld(50, 50), confidence: 0.9 });
    const [ball] = tracksToTrajectories(parseSamText(text).records, objects, cal);
    expect(ball!.points.map((p) => p.frame)).toEqual([0, 1, 2]);
    expect(ball!.points[1]!.x).toBeCloseTo(11, 1);
  });

  it('drops low-confidence frames and lists them; a missing confidence is kept as null', () => {
    const text = line(0, { objectId: '1', box: boxAtWorld(10, 30), confidence: 0.9 }) +
      line(1, { objectId: '1', box: boxAtWorld(40, 2), confidence: 0.2 }) +
      line(2, { objectId: '1', box: boxAtWorld(12, 29) }) +
      line(3, { objectId: '1', box: boxAtWorld(13, 28), confidence: 0.5 });
    const [ball] = tracksToTrajectories(parseSamText(text).records, objects, cal);
    expect(ball!.points.map((p) => p.frame)).toEqual([0, 2, 3]);
    expect(ball!.points.map((p) => p.confidence)).toEqual([0.9, null, 0.5]);
    expect(ball!.lowConfidenceFrames).toEqual([1]);
    expect(ball!.missingFrames).toEqual([]);

    const [strict] = tracksToTrajectories(parseSamText(text).records, objects, cal, { minConfidence: 0.95 });
    expect(strict!.points.map((p) => p.frame)).toEqual([2]);
    expect(strict!.lowConfidenceFrames).toEqual([0, 1, 3]);
  });

  it('lists frames with no box between the first and last as missing, including malformed lines', () => {
    const malformed = '<3f>1<|box;x1=1;y1=2|>\n';
    const text = line(0, { objectId: '1', box: boxAtWorld(10, 30) }) +
      line(1, { objectId: '1', box: boxAtWorld(11, 30) }) +
      malformed +
      line(5, { objectId: '1', box: boxAtWorld(15, 30) });
    const parsed = parseSamText(text);
    expect(parsed.diagnostics.some((d) => d.severity === 'error' && d.line === 3)).toBe(true);
    const [ball] = tracksToTrajectories(parsed.records, objects, cal);
    expect(ball!.points.map((p) => p.frame)).toEqual([0, 1, 5]);
    expect(ball!.missingFrames).toEqual([2, 3, 4]);
  });

  it('keeps objects apart, ignores unprompted ids and text lines, and returns empty tracks for unseen objects', () => {
    const text = 'a text line from the model\n' +
      line(0, { objectId: '1', box: boxAtWorld(10, 30) }, { objectId: '2', box: boxAtWorld(120, 3) }, { objectId: '9', box: boxAtWorld(1, 1) }) +
      line(1, { objectId: '2', box: boxAtWorld(120, 3) });
    const [ball, block] = tracksToTrajectories(parseSamText(text).records, objects, cal);
    expect(ball!.points).toHaveLength(1);
    expect(block!.object.kind).toBe('block');
    expect(block!.points.map((p) => p.frame)).toEqual([0, 1]);
    expect(block!.points[0]!.x).toBeCloseTo(120, 1);

    const [none] = tracksToTrajectories([], objects, cal);
    expect(none).toMatchObject({ points: [], lowConfidenceFrames: [], missingFrames: [] });
  });

  it('rejects a non-positive frame rate', () => {
    expect(() => tracksToTrajectories([], objects, cal, { fps: 0 })).toThrow(/fps/);
  });
});
