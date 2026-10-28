import {
  formats,
  type SegmentationDiagnostic,
  type SegmentationRecord,
} from '@meta-sam/parser';
import type { PixelBox } from '../scene/calibration';

/** An object SAM was prompted with; its `id` is the object id SAM reports back. */
export interface TrackedObject {
  readonly id: string;
  readonly kind: 'ball' | 'block';
  readonly label: string;
}

export interface ParsedSamText {
  readonly records: readonly SegmentationRecord[];
  readonly diagnostics: readonly SegmentationDiagnostic[];
}

/**
 * Parses saved SAM 3.1 video output (the `rawOutput` that `smoke-sam.ts`
 * writes to `sam-raw.txt`) with `@meta-sam/parser`, the same parser the live
 * stream goes through.
 */
export function parseSamText(text: string): ParsedSamText {
  const parser = formats.segmentation.video().createParser();
  parser.push(text);
  const { result } = parser.finish({ status: 'completed' });
  return { records: result.records, diagnostics: result.diagnostics };
}

export interface SamWireRecord {
  readonly objectId: string;
  readonly box: PixelBox;
  readonly confidence?: number;
}

/**
 * A valid 5×5 `one_bit` mask payload (the example in `@meta-sam/parser`'s
 * README). The parser exports no encoder, so synthetic SAM output reuses this
 * raster for every record; the overlay stretches it over each box. Real SAM
 * output carries the object's real mask.
 */
const PLACEHOLDER_MASK = '5,5,!!!!!(QO(0lu8?';

/**
 * Formats one frame of SAM 3.1 video output in the documented wire grammar,
 * for synthetic takes and test fixtures. Boxes are half-open; the wire's
 * `x2`/`y2` are inclusive.
 */
export function formatSamFrameLine(
  frame: number,
  records: readonly SamWireRecord[],
  frameSize: { readonly width: number; readonly height: number },
): string {
  const tokens = records.map(({ objectId, box, confidence }) => {
    const c = confidence === undefined ? '' : `;c=${confidence.toFixed(3)}`;
    return (
      `${objectId}<|box;x1=${box.left};y1=${box.top};x2=${box.right - 1};y2=${box.bottom - 1}` +
      `;w=${frameSize.width};h=${frameSize.height}${c}|><|mask;x=0;y=0${c};data=${PLACEHOLDER_MASK}|>`
    );
  });
  return `<${frame}f>${tokens.join(',')}\n`;
}
