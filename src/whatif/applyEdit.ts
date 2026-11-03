import type { Vec2, WorldScene } from '../scene/calibration';
import type { WhatIfEdit } from '../scene/whatIfEdit';

const DEG = Math.PI / 180;

/** The ramp's angle from the table, degrees. */
export function rampAngleDeg(world: WorldScene): number {
  const { top, bottom } = world.ramp;
  return Math.atan2(top.y - bottom.y, Math.abs(bottom.x - top.x)) / DEG;
}

/** Unit vector down the ramp and the unit normal on its upper side. */
function rampAxes(top: Vec2, bottom: Vec2): { u: Vec2; n: Vec2; length: number } {
  const dx = bottom.x - top.x;
  const dy = bottom.y - top.y;
  const length = Math.hypot(dx, dy);
  const u = { x: dx / length, y: dy / length };
  let n = { x: -u.y, y: u.x };
  if (n.y < 0) n = { x: -n.x, y: -n.y };
  return { u, n, length };
}

/**
 * Applies a what-if edit to the frozen scene (spec §1: "what if the ramp
 * were steeper / the block were gone?").
 *
 * A new ramp angle turns the ramp about its low end, keeping its length: the
 * filming guide steepens it by raising the book stack under the high end,
 * with the low end still on its block. The ball keeps its place along the
 * ramp (the same release mark) and its offset from the surface, so the
 * simulation settles it onto the ramp as before. Blocks named in the edit
 * are taken out. Everything else, and every fitted parameter, stays.
 */
export function applyWhatIf(world: WorldScene, edit: WhatIfEdit): WorldScene {
  const known = new Set(world.blocks.map((b) => b.id));
  const unknown = edit.removeBlockIds.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`no block ${unknown.join(', ')} in the scene`);
  const remove = new Set(edit.removeBlockIds);
  const blocks = world.blocks.filter((b) => !remove.has(b.id));
  if (edit.rampAngleDeg === null) return { ...world, blocks };

  const { top, bottom } = world.ramp;
  const before = rampAxes(top, bottom);
  // The high end stays on the same side of the low end.
  const side = Math.sign(top.x - bottom.x) || -1;
  const angle = edit.rampAngleDeg * DEG;
  const newTop = {
    x: bottom.x + side * before.length * Math.cos(angle),
    y: bottom.y + before.length * Math.sin(angle),
  };
  const after = rampAxes(newTop, bottom);
  const c = world.ball.center;
  const along = (c.x - top.x) * before.u.x + (c.y - top.y) * before.u.y;
  const height = (c.x - top.x) * before.n.x + (c.y - top.y) * before.n.y;
  return {
    ...world,
    ramp: { top: newTop, bottom },
    blocks,
    ball: {
      ...world.ball,
      center: {
        x: newTop.x + along * after.u.x + height * after.n.x,
        y: newTop.y + along * after.u.y + height * after.n.y,
      },
    },
  };
}

/** A one-line description of an edit for the page and the results table, e.g. "ramp 32.0°, without blue". */
export function describeEdit(edit: WhatIfEdit, world: WorldScene): string {
  const parts: string[] = [];
  if (edit.rampAngleDeg !== null) parts.push(`ramp ${rampAngleDeg(world).toFixed(1)}° → ${edit.rampAngleDeg.toFixed(1)}°`);
  for (const id of edit.removeBlockIds) parts.push(`without ${world.blocks.find((b) => b.id === id)?.label ?? id}`);
  return parts.join(', ');
}
