export interface NelderMeadOptions {
  /** Initial simplex edge per dimension: vertex i is the start with `steps[i]` added to coordinate i. */
  readonly steps: readonly number[];
  /** Stop after this many objective evaluations. */
  readonly maxEvaluations?: number;
  /** Stop once the simplex's values differ by at most this much. */
  readonly fTolerance?: number;
  /** Stop once every vertex is within this of the best one in every coordinate. */
  readonly xTolerance?: number;
}

export interface NelderMeadResult {
  readonly x: readonly number[];
  readonly value: number;
  readonly evaluations: number;
  readonly iterations: number;
  readonly converged: boolean;
}

interface Vertex {
  readonly x: number[];
  readonly value: number;
}

function vertexAt(simplex: readonly Vertex[], i: number): Vertex {
  const v = simplex[i];
  if (!v) throw new Error('simplex vertex out of range');
  return v;
}

/** A non-finite value is treated as the worst possible, so a failed simulation never wins. */
const finite = (v: number) => (Number.isFinite(v) ? v : Number.POSITIVE_INFINITY);

/**
 * Nelder–Mead downhill simplex with the standard coefficients (reflection 1,
 * expansion 2, contraction ½, shrink ½). Deterministic: the same objective
 * and start give the same evaluations in the same order. Unconstrained; a
 * bounded problem clamps inside its objective.
 */
export function nelderMead(
  f: (x: readonly number[]) => number,
  start: readonly number[],
  options: NelderMeadOptions,
): NelderMeadResult {
  const n = start.length;
  if (options.steps.length !== n) throw new Error('one initial step per dimension');
  const maxEvaluations = options.maxEvaluations ?? 200 * n;
  const fTolerance = options.fTolerance ?? 1e-8;
  const xTolerance = options.xTolerance ?? 1e-6;

  let evaluations = 0;
  const evaluate = (x: number[]): Vertex => {
    evaluations++;
    return { x, value: finite(f(x)) };
  };

  let simplex: Vertex[] = [evaluate([...start])];
  for (let i = 0; i < n; i++) {
    const x = [...start];
    x[i] = (x[i] ?? 0) + (options.steps[i] ?? 0);
    simplex.push(evaluate(x));
  }

  const along = (from: readonly number[], to: readonly number[], t: number) =>
    from.map((a, i) => a + t * ((to[i] ?? 0) - a));

  let iterations = 0;
  let converged = false;
  while (evaluations < maxEvaluations) {
    simplex.sort((a, b) => a.value - b.value);
    const best = vertexAt(simplex, 0);
    const worst = vertexAt(simplex, n);
    const spread = worst.value - best.value;
    const size = Math.max(...simplex.slice(1).flatMap((v) => v.x.map((c, i) => Math.abs(c - (best.x[i] ?? 0)))));
    if (spread <= fTolerance && size <= xTolerance) {
      converged = true;
      break;
    }
    iterations++;

    const centroid = Array.from({ length: n }, (_, i) => simplex.slice(0, n).reduce((s, v) => s + (v.x[i] ?? 0), 0) / n);
    const secondWorst = vertexAt(simplex, n - 1);
    const reflected = evaluate(along(centroid, worst.x, -1));

    if (reflected.value < best.value) {
      const expanded = evaluate(along(centroid, worst.x, -2));
      simplex[n] = expanded.value < reflected.value ? expanded : reflected;
      continue;
    }
    if (reflected.value < secondWorst.value) {
      simplex[n] = reflected;
      continue;
    }
    // Contract towards the better of the worst and the reflection.
    const outside = reflected.value < worst.value;
    const contracted = evaluate(along(centroid, outside ? reflected.x : worst.x, 0.5));
    if (contracted.value < (outside ? reflected.value : worst.value)) {
      simplex[n] = contracted;
      continue;
    }
    simplex = [best, ...simplex.slice(1).map((v) => evaluate(along(best.x, v.x, 0.5)))];
  }

  simplex.sort((a, b) => a.value - b.value);
  const best = vertexAt(simplex, 0);
  return { x: best.x, value: best.value, evaluations, iterations, converged };
}
