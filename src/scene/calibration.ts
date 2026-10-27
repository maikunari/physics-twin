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

/** The scene in metres, world y up, origin at the left end of the table line. */
export interface WorldScene {
  readonly ramp: { readonly top: Vec2; readonly bottom: Vec2 };
  readonly table: { readonly left: Vec2; readonly right: Vec2 };
  readonly blocks: readonly {
    readonly id: string;
    readonly label: string;
    readonly center: Vec2;
    readonly halfExtents: Vec2;
  }[];
  readonly ball: { readonly center: Vec2; readonly radius: number };
  readonly pixelsPerMetre: number;
}

/** Default distance between the two tape marks (filming guide: 50 cm). */
export const DEFAULT_MARKER_DISTANCE_M = 0.5;

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

/** The ball's bounding box in source pixels, used as SAM's frame-0 box prompt. */
export function ballPixelBox(scene: GroundedScene, size: ImageSize): PixelBox {
  const c = gridToPixel(scene.ball.center, size);
  const r = (scene.ball.radius * size.width) / GRID_MAX;
  return toPixelBox(c.x - r, c.y - r, c.x + r, c.y + r, size);
}

/**
 * Converts a grounded scene to metres using the two tape marks for scale.
 * Assumes a side-on camera with the table roughly level in frame; correcting
 * camera roll from the table line is a later calibration step.
 */
export function toWorldScene(
  scene: GroundedScene,
  size: ImageSize,
  markerDistanceM: number = DEFAULT_MARKER_DISTANCE_M,
): WorldScene {
  const [m0, m1] = scene.scaleMarkers;
  if (!m0 || !m1) throw new Error('scene needs two scale markers');
  const a = gridToPixel(m0, size);
  const b = gridToPixel(m1, size);
  const markerPx = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(markerPx > 0) || !(markerDistanceM > 0)) throw new Error('scale markers do not give a usable scale');
  const ppm = markerPx / markerDistanceM;

  const origin = gridToPixel(scene.table.left, size);
  const world = (p: GridPoint): Vec2 => {
    const px = gridToPixel(p, size);
    return { x: (px.x - origin.x) / ppm, y: (origin.y - px.y) / ppm };
  };

  return {
    ramp: { top: world(scene.ramp.top), bottom: world(scene.ramp.bottom) },
    table: { left: world(scene.table.left), right: world(scene.table.right) },
    blocks: scene.blocks.map((block) => {
      const tl = world({ x: block.box.x_min, y: block.box.y_min });
      const br = world({ x: block.box.x_max, y: block.box.y_max });
      return {
        id: block.id,
        label: block.label,
        center: { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 },
        halfExtents: { x: Math.abs(br.x - tl.x) / 2, y: Math.abs(tl.y - br.y) / 2 },
      };
    }),
    ball: {
      center: world(scene.ball.center),
      radius: (scene.ball.radius * size.width) / GRID_MAX / ppm,
    },
    pixelsPerMetre: ppm,
  };
}
