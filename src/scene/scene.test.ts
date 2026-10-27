import { describe, expect, it } from 'vitest';
import { groundedSceneJsonSchema, groundedSceneSchema, hasUsableScale } from './schema';
import { ballPixelBox, gridToPixel, toWorldScene } from './calibration';
import { FIXTURE_IMAGE_SIZE, FIXTURE_SCENE } from './fixtures';

const clone = () => structuredClone(FIXTURE_SCENE);

describe('groundedSceneSchema', () => {
  it('accepts the fixture scene', () => {
    expect(groundedSceneSchema.safeParse(FIXTURE_SCENE).success).toBe(true);
  });

  it('tolerates the small grid overshoot the model can emit', () => {
    const s = clone();
    s.table.right.x = 1001;
    expect(groundedSceneSchema.safeParse(s).success).toBe(true);
  });

  it.each([
    ['coordinate far off the grid', (s: ReturnType<typeof clone>) => void (s.ramp.top.x = 1500)],
    ['inverted block box', (s: ReturnType<typeof clone>) => void (s.blocks[0]!.box.x_max = 700)],
    ['negative ball radius', (s: ReturnType<typeof clone>) => void (s.ball.radius = -1)],
    ['one scale marker', (s: ReturnType<typeof clone>) => void s.scaleMarkers.pop()],
    ['unknown key', (s: ReturnType<typeof clone>) => void Object.assign(s, { extra: 1 })],
  ])('rejects %s', (_name, mutate) => {
    const s = clone();
    mutate(s);
    expect(groundedSceneSchema.safeParse(s).success).toBe(false);
  });

  it('rejects more than five blocks', () => {
    const s = clone();
    const block = s.blocks[0]!;
    s.blocks = Array.from({ length: 6 }, (_, i) => ({ ...block, id: `b${i}` }));
    expect(groundedSceneSchema.safeParse(s).success).toBe(false);
  });

  it('finds the scale only when the markers are apart', () => {
    expect(hasUsableScale(FIXTURE_SCENE)).toBe(true);
    const s = clone();
    s.scaleMarkers = [
      { x: 500, y: 660 },
      { x: 505, y: 660 },
    ];
    expect(hasUsableScale(s)).toBe(false);
  });

  it('emits a strict-mode compatible JSON schema', () => {
    const schema = groundedSceneJsonSchema() as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());
  });
});

describe('calibration', () => {
  it('maps the grid corners to the image corners and clamps overshoot', () => {
    expect(gridToPixel({ x: 0, y: 0 }, FIXTURE_IMAGE_SIZE)).toEqual({ x: 0, y: 0 });
    expect(gridToPixel({ x: 1000, y: 1000 }, FIXTURE_IMAGE_SIZE)).toEqual({ x: 1920, y: 1080 });
    expect(gridToPixel({ x: 1010, y: -5 }, FIXTURE_IMAGE_SIZE)).toEqual({ x: 1920, y: 0 });
  });

  it('builds an integer half-open ball box inside the frame', () => {
    const box = ballPixelBox(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE);
    for (const v of Object.values(box)) expect(Number.isInteger(v)).toBe(true);
    expect(box.right).toBeGreaterThan(box.left);
    expect(box.bottom).toBeGreaterThan(box.top);
    expect(box.right - box.left).toBeGreaterThanOrEqual(38);
  });

  it('scales by the tape marks, puts the origin at the table left end and flips y', () => {
    const w = toWorldScene(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE, 0.5);
    // Markers are 300 grid units = 576 px apart for 0.5 m.
    expect(w.pixelsPerMetre).toBeCloseTo(1152);
    expect(w.table.left).toEqual({ x: 0, y: 0 });
    expect(w.table.right.y).toBeCloseTo(0);
    expect(w.ramp.top.y).toBeGreaterThan(w.ramp.bottom.y);
    expect(w.ball.radius).toBeCloseTo((10 * 1.92) / 1152);
    expect(w.blocks[0]!.halfExtents.x).toBeGreaterThan(0);
  });
});
