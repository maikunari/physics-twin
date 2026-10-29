import { useEffect, useRef } from 'react';
import type { Vec2, WorldScene } from '../scene/calibration';
import type { Trajectory } from '../sim/sceneWorld';

interface Props {
  readonly scene: WorldScene;
  readonly trajectory: Trajectory;
  readonly width: number;
  readonly height: number;
}

const PAD_PX = 24;

/** Fits the scene's extent into the canvas and returns a world-to-canvas mapping (y flipped). */
function makeView(scene: WorldScene, width: number, height: number) {
  const pts: Vec2[] = [scene.ramp.top, scene.ramp.bottom, scene.table.left, scene.table.right, scene.ball.center];
  for (const b of scene.blocks) {
    pts.push({ x: b.center.x - b.halfExtents.x, y: b.center.y + b.halfExtents.y });
    pts.push({ x: b.center.x + b.halfExtents.x, y: b.center.y - b.halfExtents.y });
  }
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const scale = Math.min((width - 2 * PAD_PX) / (maxX - minX || 1), (height - 2 * PAD_PX) / (maxY - minY || 1));
  return {
    scale,
    x: (wx: number) => PAD_PX + (wx - minX) * scale,
    y: (wy: number) => height - PAD_PX - (wy - minY) * scale,
  };
}

/** Plays the simulated trajectory over the scene geometry on a loop, at real-time speed. */
export function SimCanvas({ scene, trajectory, width, height }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx || trajectory.samples.length === 0) return;
    const view = makeView(scene, width, height);
    const duration = trajectory.samples.length * trajectory.dt;
    let frame = 0;
    let start: number | null = null;

    const line = (a: Vec2, b: Vec2) => {
      ctx.beginPath();
      ctx.moveTo(view.x(a.x), view.y(a.y));
      ctx.lineTo(view.x(b.x), view.y(b.y));
      ctx.stroke();
    };

    const draw = (now: number) => {
      start ??= now;
      const t = ((now - start) / 1000) % (duration + 0.5);
      const index = Math.min(trajectory.samples.length - 1, Math.floor(t / trajectory.dt));

      ctx.clearRect(0, 0, width, height);
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#8a8f98';
      line(scene.ramp.top, scene.ramp.bottom);
      line(scene.table.left, scene.table.right);

      ctx.fillStyle = '#3b82f6';
      for (const b of scene.blocks) {
        ctx.fillRect(
          view.x(b.center.x - b.halfExtents.x),
          view.y(b.center.y + b.halfExtents.y),
          2 * b.halfExtents.x * view.scale,
          2 * b.halfExtents.y * view.scale,
        );
      }

      ctx.strokeStyle = 'rgba(245, 158, 11, 0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      trajectory.samples.slice(0, index + 1).forEach((s, i) => {
        if (i === 0) ctx.moveTo(view.x(s.x), view.y(s.y));
        else ctx.lineTo(view.x(s.x), view.y(s.y));
      });
      ctx.stroke();

      const s = trajectory.samples[index];
      if (s) {
        const r = scene.ball.radius * view.scale;
        ctx.fillStyle = '#f59e0b';
        ctx.beginPath();
        ctx.arc(view.x(s.x), view.y(s.y), r, 0, Math.PI * 2);
        ctx.fill();
        // A spoke so rolling is visible.
        ctx.strokeStyle = '#1f2937';
        ctx.beginPath();
        ctx.moveTo(view.x(s.x), view.y(s.y));
        ctx.lineTo(view.x(s.x) + r * Math.cos(-s.angle), view.y(s.y) + r * Math.sin(-s.angle));
        ctx.stroke();
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [scene, trajectory, width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      aria-label="Simulated ball on ramp"
      style={{ maxWidth: '100%' }}
    />
  );
}
