import { formats } from '@meta-sam/parser';
import { describe, expect, it } from 'vitest';
import { goNoGo, summariseTracks, type PromptedObject } from './samSummary';

/**
 * Builds SAM 3.1 video output text in the documented wire grammar
 * (dev.meta.ai/docs/sam/reading-segmentation). Masks are placeholders; the
 * summary only reads boxes.
 */
function wireLine(frame: number, objects: { id: number; x: number; y: number; c?: number }[]): string {
  const records = objects.map(({ id, x, y, c }) => {
    const conf = c === undefined ? '' : `;c=${c}`;
    return `${id}<|box;x1=${x};y1=${y};x2=${x + 19};y2=${y + 19};w=1920;h=1080${conf}|><|mask;x=0;y=0${conf};data=1,1,!!!!!!|>`;
  });
  return `<${frame}f>${records.join(',')}\n`;
}

function parse(text: string) {
  const parser = formats.segmentation.video().createParser();
  parser.push(text);
  return parser.finish({ status: 'completed' }).result.records;
}

const objects: PromptedObject[] = [
  { id: '1', kind: 'ball', label: 'ball' },
  { id: '2', kind: 'block', label: 'blue block' },
];

describe('summariseTracks', () => {
  it('summarises boxes per prompted object, tolerating out-of-order frames', () => {
    const text = [2, 0, 1, 4].map((f) => wireLine(f, [{ id: 1, x: 100 + 5 * f, y: 300, c: 0.9 - f * 0.1 }])).join('') +
      wireLine(0, [{ id: 2, x: 1500, y: 600, c: 0.8 }]);
    const [ball, block] = summariseTracks(parse(text), objects);
    expect(ball).toMatchObject({ framesWithBox: 4, firstFrame: 0, lastFrame: 4, longestRun: 3 });
    expect(ball!.path.map((p) => p.frame)).toEqual([0, 1, 2, 4]);
    expect(ball!.meanConfidence).toBeCloseTo((0.9 + 0.8 + 0.7 + 0.5) / 4);
    expect(ball!.minConfidence).toBeCloseTo(0.5);
    expect(ball!.maxStepPx).toBeCloseTo(10);
    expect(block).toMatchObject({ framesWithBox: 1, meanConfidence: 0.8 });
  });

  it('reports null confidence when the API omitted c', () => {
    const [ball] = summariseTracks(parse(wireLine(0, [{ id: 1, x: 10, y: 10 }])), objects);
    expect(ball!.meanConfidence).toBeNull();
  });
});

describe('goNoGo', () => {
  const track = (frames: number, step = 4, c = 0.9) =>
    summariseTracks(
      parse(Array.from({ length: frames }, (_, f) => wireLine(f, [{ id: 1, x: 100 + step * f, y: 300, c }])).join('')),
      objects,
    )[0];

  it('goes on a clean 240-frame track', () => {
    expect(goNoGo(track(240), 240, 20)).toEqual({ go: true, reasons: [] });
  });

  it('stops on too few frames and poor fit-window coverage', () => {
    const verdict = goNoGo(track(20), 240, 20);
    expect(verdict.go).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/need 30/);
    expect(verdict.reasons.join(' ')).toMatch(/first second/);
  });

  it('stops on low confidence and on jumps', () => {
    expect(goNoGo(track(240, 4, 0.3), 240, 20).reasons.join(' ')).toMatch(/confidence/);
    expect(goNoGo(track(240, 40), 240, 20).reasons.join(' ')).toMatch(/jumps/);
  });

  it('stops when the ball is missing', () => {
    expect(goNoGo(undefined, 240, 20).go).toBe(false);
  });
});
