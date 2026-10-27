import type { GroundedScene } from './schema';
import type { ImageSize } from './calibration';

/** 1080p landscape frame, the filming guide's capture size. */
export const FIXTURE_IMAGE_SIZE: ImageSize = { width: 1920, height: 1080 };

/**
 * A hand-written ramp scene in grid units for tests and the day-1 canvas page.
 * Roughly: a 30° ramp on the left feeding a table, one block on the right,
 * tape marks 50 cm apart on the table edge. Not taken from any real clip.
 */
export const FIXTURE_SCENE: GroundedScene = {
  ramp: { top: { x: 80, y: 360 }, bottom: { x: 320, y: 600 } },
  table: { left: { x: 40, y: 640 }, right: { x: 960, y: 640 } },
  blocks: [{ id: 'blue', label: 'blue block', box: { x_min: 780, y_min: 560, x_max: 830, y_max: 640 } }],
  ball: { center: { x: 105, y: 364 }, radius: 10 },
  scaleMarkers: [
    { x: 400, y: 660 },
    { x: 700, y: 660 },
  ],
};
