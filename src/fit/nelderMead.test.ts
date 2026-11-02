import { describe, expect, it } from 'vitest';
import { nelderMead } from './nelderMead';

const rosenbrock = ([x = 0, y = 0]: readonly number[]) => (1 - x) ** 2 + 100 * (y - x * x) ** 2;

describe('Nelder–Mead', () => {
  it('finds the minimum of a shifted quadratic', () => {
    const f = ([x = 0, y = 0, z = 0]: readonly number[]) => (x - 1) ** 2 + 2 * (y + 2) ** 2 + 0.5 * (z - 0.3) ** 2;
    const r = nelderMead(f, [0, 0, 0], { steps: [0.5, 0.5, 0.5], maxEvaluations: 2000 });
    expect(r.converged).toBe(true);
    expect(r.x[0]).toBeCloseTo(1, 4);
    expect(r.x[1]).toBeCloseTo(-2, 4);
    expect(r.x[2]).toBeCloseTo(0.3, 4);
  });

  it('follows the Rosenbrock valley to (1, 1)', () => {
    const r = nelderMead(rosenbrock, [-1.2, 1], { steps: [0.1, 0.1], maxEvaluations: 2000, xTolerance: 1e-8, fTolerance: 1e-12 });
    expect(r.x[0]).toBeCloseTo(1, 3);
    expect(r.x[1]).toBeCloseTo(1, 3);
    expect(r.value).toBeLessThan(1e-6);
  });

  it('is deterministic: the same start gives the same evaluations', () => {
    const seen: number[][] = [];
    const f = (x: readonly number[]) => {
      seen.push([...x]);
      return rosenbrock(x);
    };
    const a = nelderMead(f, [0, 0], { steps: [0.2, 0.2], maxEvaluations: 300 });
    const first = seen.splice(0);
    const b = nelderMead(f, [0, 0], { steps: [0.2, 0.2], maxEvaluations: 300 });
    expect(b).toEqual(a);
    expect(seen).toEqual(first);
  });

  it('stops at the evaluation budget', () => {
    let calls = 0;
    const r = nelderMead(
      (x) => {
        calls++;
        return rosenbrock(x);
      },
      [-1.2, 1],
      { steps: [0.1, 0.1], maxEvaluations: 25 },
    );
    expect(r.converged).toBe(false);
    // One iteration can take a few evaluations past the check (a shrink re-evaluates every vertex).
    expect(calls).toBeLessThanOrEqual(25 + 2);
    expect(r.evaluations).toBe(calls);
  });

  it('treats a non-finite value as the worst, so it walks away from it', () => {
    const f = ([x = 0]: readonly number[]) => (x < 0 ? Number.NaN : (x - 2) ** 2);
    const r = nelderMead(f, [0.5], { steps: [-1] });
    expect(r.x[0]).toBeCloseTo(2, 4);
  });

  it('wants one step per dimension', () => {
    expect(() => nelderMead(rosenbrock, [0, 0], { steps: [0.1] })).toThrow(/one initial step/);
  });
});
