import { GRID_MAX, type GridBox, type GridPoint, type GroundedScene } from './schema';

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** Half-open integer pixel box, the shape `@meta-sam/parser` uses for box prompts. */
export interface PixelBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * Maps source pixels to the world frame and back (spec §5: two tape marks give
 * px/cm, the table edge gives the level line). The camera is side-on, so a
 * scale, a rotation and an origin are enough.
 *
 * World frame: centimetres, origin at the table line's left end, x along the
 * table line to the right, y up and perpendicular to it. Plain data, so it can
 * be cloned into a worker.
 */
export interface Calibration {
  readonly imageSize: ImageSize;
  /** The table line's left end, source pixels. */
  readonly originPx: Vec2;
  /** Unit vector along the table line in image coordinates (y down). Not (1, 0) when the camera is rolled. */
  readonly axisX: Vec2;
  readonly pixelsPerCm: number;
}

/** The scene in centimetres, in the calibration's world frame. */
export interface WorldScene {
  readonly ramp: { readonly top: Vec2; readonly bottom: Vec2 };
  readonly table: { readonly left: Vec2; readonly right: Vec2 };
  /** Blocks rest flat on the table, so they stay axis-aligned in the world frame. */
  readonly blocks: readonly {
    readonly id: string;
    readonly label: string;
    readonly center: Vec2;
    readonly halfExtents: Vec2;
  }[];
  readonly ball: { readonly center: Vec2; readonly radius: number };
}

/** Default distance between the two tape marks (filming guide: 50 cm). */
export const DEFAULT_MARKER_DISTANCE_CM = 50;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Grid (0–1000) to source pixels, clamped to the image as the Muse Spark docs advise. */
export function gridToPixel(p: GridPoint, size: ImageSize): Vec2 {
  return {
    x: clamp((p.x * size.width) / GRID_MAX, 0, size.width),
    y: clamp((p.y * size.height) / GRID_MAX, 0, size.height),
  };
}

function toPixelBox(x0: number, y0: number, x1: number, y1: number, size: ImageSize): PixelBox {
  const left = clamp(Math.floor(x0), 0, size.width - 1);
  const top = clamp(Math.floor(y0), 0, size.height - 1);
  return {
    left,
    top,
    right: clamp(Math.ceil(x1), left + 1, size.width),
    bottom: clamp(Math.ceil(y1), top + 1, size.height),
  };
}

export function gridBoxToPixelBox(b: GridBox, size: ImageSize): PixelBox {
  const a = gridToPixel({ x: b.x_min, y: b.y_min }, size);
  const c = gridToPixel({ x: b.x_max, y: b.y_max }, size);
  return toPixelBox(a.x, a.y, c.x, c.y, size);
}

/** The ball's radius in source pixels (the grid radius is measured along x). */
export function ballRadiusPx(scene: GroundedScene, size: ImageSize): number {
  return (scene.ball.radius * size.width) / GRID_MAX;
}

/** The ball's bounding box in source pixels, used as SAM's frame-0 box prompt. */
export function ballPixelBox(scene: GroundedScene, size: ImageSize): PixelBox {
  const c = gridToPixel(scene.ball.center, size);
  const r = ballRadiusPx(scene, size);
  return toPixelBox(c.x - r, c.y - r, c.x + r, c.y + r, size);
}

/**
 * Builds the calibration from the grounded scene: scale from the two tape
 * marks `markerDistanceCm` apart, level line and origin from the table line.
 * Assumes the real table is level, so any tilt of its line in frame is camera
 * roll.
 */
export function calibrate(
  scene: GroundedScene,
  imageSize: ImageSize,
  markerDistanceCm: number = DEFAULT_MARKER_DISTANCE_CM,
): Calibration {
  const [m0, m1] = scene.scaleMarkers;
  if (!m0 || !m1) throw new Error('scene needs two scale markers');
  const a = gridToPixel(m0, imageSize);
  const b = gridToPixel(m1, imageSize);
  const markerPx = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(markerPx > 0) || !(markerDistanceCm > 0)) throw new Error('scale markers do not give a usable scale');

  const left = gridToPixel(scene.table.left, imageSize);
  const right = gridToPixel(scene.table.right, imageSize);
  const tableLen = Math.hypot(right.x - left.x, right.y - left.y);
  if (!(tableLen > 0)) throw new Error('table line has no length');

  return {
    imageSize,
    originPx: left,
    axisX: { x: (right.x - left.x) / tableLen, y: (right.y - left.y) / tableLen },
    pixelsPerCm: markerPx / markerDistanceCm,
  };
}

/** Camera roll in radians: how far the table line turns clockwise from the image's horizontal. */
export function rollRadians(cal: Calibration): number {
  return Math.atan2(cal.axisX.y, cal.axisX.x);
}

/** Source pixels to world centimetres. */
export function pixelToWorld(cal: Calibration, p: Vec2): Vec2 {
  const dx = p.x - cal.originPx.x;
  const dy = p.y - cal.originPx.y;
  const { x: ux, y: uy } = cal.axisX;
  // World up is the table axis turned a quarter anticlockwise on screen: (uy, -ux) in y-down image coordinates.
  return {
    x: (dx * ux + dy * uy) / cal.pixelsPerCm,
    y: (dx * uy - dy * ux) / cal.pixelsPerCm,
  };
}

/** World centimetres to source pixels; the inverse of `pixelToWorld`. */
export function worldToPixel(cal: Calibration, w: Vec2): Vec2 {
  const { x: ux, y: uy } = cal.axisX;
  const s = cal.pixelsPerCm;
  return {
    x: cal.originPx.x + s * (w.x * ux + w.y * uy),
    y: cal.originPx.y + s * (w.x * uy - w.y * ux),
  };
}

/** Converts a grounded scene to the calibration's world frame, in centimetres. */
export function toWorldScene(scene: GroundedScene, cal: Calibration): WorldScene {
  const world = (p: GridPoint): Vec2 => pixelToWorld(cal, gridToPixel(p, cal.imageSize));
  return {
    ramp: { top: world(scene.ramp.top), bottom: world(scene.ramp.bottom) },
    table: { left: world(scene.table.left), right: world(scene.table.right) },
    blocks: scene.blocks.map((block) => {
      const tl = gridToPixel({ x: block.box.x_min, y: block.box.y_min }, cal.imageSize);
      const br = gridToPixel({ x: block.box.x_max, y: block.box.y_max }, cal.imageSize);
      return {
        id: block.id,
        label: block.label,
        center: pixelToWorld(cal, { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 }),
        halfExtents: { x: (br.x - tl.x) / 2 / cal.pixelsPerCm, y: (br.y - tl.y) / 2 / cal.pixelsPerCm },
      };
    }),
    ball: {
      center: world(scene.ball.center),
      radius: ballRadiusPx(scene, cal.imageSize) / cal.pixelsPerCm,
    },
  };
}
