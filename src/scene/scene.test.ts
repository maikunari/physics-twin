import { describe, expect, it } from 'vitest';
import { groundedSceneJsonSchema, groundedSceneSchema, hasUsableScale } from './schema';
import {
  ballPixelBox,
  calibrate,
  gridToPixel,
  pixelToWorld,
  rollRadians,
  toWorldScene,
  worldToPixel,
  type Vec2,
} from './calibration';
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
    const cal = calibrate(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE, 50);
    // Markers are 300 grid units = 576 px apart for 50 cm.
    expect(cal.pixelsPerCm).toBeCloseTo(11.52);
    expect(rollRadians(cal)).toBeCloseTo(0);
    const w = toWorldScene(FIXTURE_SCENE, cal);
    expect(w.table.left).toEqual({ x: 0, y: 0 });
    expect(w.table.right.y).toBeCloseTo(0);
    expect(w.table.right.x).toBeCloseTo((920 * 1.92) / 11.52);
    expect(w.ramp.top.y).toBeGreaterThan(w.ramp.bottom.y);
    expect(w.ball.radius).toBeCloseTo((10 * 1.92) / 11.52);
    expect(w.blocks[0]!.halfExtents).toEqual({ x: expect.closeTo((25 * 1.92) / 11.52), y: expect.closeTo((40 * 1.08) / 11.52) });
  });

  it('round-trips pixels through the world frame', () => {
    const cal = calibrate(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE);
    for (const p of [{ x: 0, y: 0 }, { x: 1919, y: 1079 }, { x: 640, y: 300 }]) {
      const back = worldToPixel(cal, pixelToWorld(cal, p));
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  it('rejects a zero marker distance and a zero-length table', () => {
    expect(() => calibrate(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE, 0)).toThrow(/usable scale/);
    const s = clone();
    s.table.right = { ...s.table.left };
    expect(() => calibrate(s, FIXTURE_IMAGE_SIZE)).toThrow(/table line/);
  });

  it('corrects camera roll: a rolled frame gives the same world scene', () => {
    const roll = (4 * Math.PI) / 180;
    const pivot = { x: 960, y: 540 };
    const { width, height } = FIXTURE_IMAGE_SIZE;
    // Rotate a grid point about the frame centre in pixel space, as a rolled camera would see it.
    const rolled = (g: Vec2): Vec2 => {
      const p = gridToPixel(g, FIXTURE_IMAGE_SIZE);
      const dx = p.x - pivot.x;
      const dy = p.y - pivot.y;
      return {
        x: ((pivot.x + dx * Math.cos(roll) - dy * Math.sin(roll)) * 1000) / width,
        y: ((pivot.y + dx * Math.sin(roll) + dy * Math.cos(roll)) * 1000) / height,
      };
    };
    const s = clone();
    s.ramp = { top: rolled(s.ramp.top), bottom: rolled(s.ramp.bottom) };
    s.table = { left: rolled(s.table.left), right: rolled(s.table.right) };
    s.ball.center = rolled(s.ball.center);
    s.scaleMarkers = [rolled(s.scaleMarkers[0]!), rolled(s.scaleMarkers[1]!)];

    const cal = calibrate(s, FIXTURE_IMAGE_SIZE);
    expect(rollRadians(cal)).toBeCloseTo(roll, 9);
    expect(cal.pixelsPerCm).toBeCloseTo(11.52, 9);
    const level = toWorldScene(FIXTURE_SCENE, calibrate(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE));
    const fixed = toWorldScene(s, cal);
    for (const [a, b] of [
      [fixed.ramp.top, level.ramp.top],
      [fixed.ramp.bottom, level.ramp.bottom],
      [fixed.table.right, level.table.right],
      [fixed.ball.center, level.ball.center],
    ] as const) {
      expect(a.x).toBeCloseTo(b.x, 6);
      expect(a.y).toBeCloseTo(b.y, 6);
    }
  });
});
