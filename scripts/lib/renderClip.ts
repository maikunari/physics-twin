import { spawn } from 'node:child_process';
import { gridBoxToPixelBox, gridToPixel, type ImageSize, type Vec2 } from '../../src/scene/calibration';
import type { GroundedScene } from '../../src/scene/schema';
import type { SyntheticTake } from '../../src/synthetic/syntheticTake';

type Rgb = readonly [number, number, number];
const BACKDROP: Rgb = [24, 26, 32];
const TABLE: Rgb = [58, 52, 46];
const RAMP: Rgb = [176, 140, 96];
const TAPE: Rgb = [250, 204, 21];
const BLOCK: Rgb = [37, 99, 235];
const BALL: Rgb = [249, 115, 22];

/** A minimal RGB24 rasteriser: enough for flat shapes. */
class Frame {
  readonly data: Buffer;
  constructor(readonly size: ImageSize) {
    this.data = Buffer.alloc(size.width * size.height * 3);
  }

  private set(x: number, y: number, [r, g, b]: Rgb) {
    if (x < 0 || y < 0 || x >= this.size.width || y >= this.size.height) return;
    const i = (y * this.size.width + x) * 3;
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
  }

  fill(colour: Rgb) {
    for (let i = 0; i < this.size.width * this.size.height; i++) this.data.set(colour, i * 3);
  }

  rect(x0: number, y0: number, x1: number, y1: number, colour: Rgb) {
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++) for (let x = Math.floor(x0); x < Math.ceil(x1); x++) this.set(x, y, colour);
  }

  /** Every pixel whose centre is within `half` of the segment a–b. */
  thickLine(a: Vec2, b: Vec2, half: number, colour: Rgb) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    for (let y = Math.floor(Math.min(a.y, b.y) - half); y <= Math.ceil(Math.max(a.y, b.y) + half); y++) {
      for (let x = Math.floor(Math.min(a.x, b.x) - half); x <= Math.ceil(Math.max(a.x, b.x) + half); x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const s = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
        if (Math.hypot(px - (a.x + s * dx), py - (a.y + s * dy)) <= half) this.set(x, y, colour);
      }
    }
  }

  disc(c: Vec2, r: number, colour: Rgb) {
    for (let y = Math.floor(c.y - r); y <= Math.ceil(c.y + r); y++) {
      for (let x = Math.floor(c.x - r); x <= Math.ceil(c.x + r); x++) {
        if (Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y) <= r) this.set(x, y, colour);
      }
    }
  }
}

/**
 * Renders a synthetic take as an H.264 MP4 at the take's frame rate: the
 * scene as flat shapes, the ball moving on its true path. Needs ffmpeg. It is
 * a drawing, not a photo; it exists so the overlay has a clip to line up with.
 */
export async function renderSyntheticClip(scene: GroundedScene, size: ImageSize, take: SyntheticTake, fps: number, outFile: string): Promise<void> {
  // Everything but the ball is the same every frame: draw it once.
  const background = new Frame(size);
  background.fill(BACKDROP);
  const left = gridToPixel(scene.table.left, size);
  const right = gridToPixel(scene.table.right, size);
  background.rect(left.x, Math.min(left.y, right.y), right.x, size.height, TABLE);
  const rampHalf = take.calibration.pixelsPerCm;
  const top = gridToPixel(scene.ramp.top, size);
  const bottom = gridToPixel(scene.ramp.bottom, size);
  // The ramp's running surface is its top edge: draw the slab just under the line.
  background.thickLine({ x: top.x, y: top.y + rampHalf }, { x: bottom.x, y: bottom.y + rampHalf }, rampHalf, RAMP);
  for (const block of scene.blocks) {
    const box = gridBoxToPixelBox(block.box, size);
    background.rect(box.left, box.top, box.right, box.bottom, BLOCK);
  }
  for (const marker of scene.scaleMarkers) {
    const p = gridToPixel(marker, size);
    background.rect(p.x - 3, p.y - 12, p.x + 3, p.y + 12, TAPE);
  }

  const ffmpeg = spawn(
    'ffmpeg',
    ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${size.width}x${size.height}`, '-r', String(fps), '-i', '-',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const finished = new Promise<void>((resolve, reject) => {
    ffmpeg.on('error', (err) => reject(new Error(`could not run ffmpeg (is it installed?): ${err.message}`)));
    ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });

  const frame = new Frame(size);
  for (const p of take.ballPx) {
    background.data.copy(frame.data);
    frame.disc(p, take.ballRadiusPx, BALL);
    if (!ffmpeg.stdin.write(frame.data)) await new Promise((resolve) => ffmpeg.stdin.once('drain', resolve));
  }
  ffmpeg.stdin.end();
  await finished;
}
