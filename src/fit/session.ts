import { createActor } from 'xstate';
import { fitLoopMachine, type FitLoopOutput } from '../machines/fitLoop';
import type { SimParams } from '../sim/params';
import { DEFAULT_FREE_PARAMS, evaluateParams, fitReleaseShift, polish, type FitEvaluation, type FitProblem, type ParamKey } from './fitter';

/** What a proposer sees before each turn: the best run so far and every scored iteration. */
export interface ProposalContext {
  readonly iteration: number;
  readonly best: FitEvaluation;
  readonly history: readonly FitEvaluation[];
  readonly windowEndSec: number;
  /** Runs the simulation and scores it on the fit window, the agent's `simulate` tool. */
  readonly simulate: (params: SimParams) => FitEvaluation;
  readonly log: (entry: FitLogEntry) => void;
}

export interface Proposal {
  readonly params: SimParams;
  readonly note?: string;
}

/** The Muse Spark fitting agent, or a stand-in for it in tests. Throwing hands the fit to the numeric fallback. */
export type Proposer = (context: ProposalContext) => Promise<Proposal>;

export type FitLogEntry =
  | { readonly kind: 'agent'; readonly text: string }
  | { readonly kind: 'tool'; readonly text: string }
  | { readonly kind: 'numeric'; readonly text: string }
  | { readonly kind: 'score'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string };

export interface FitProgress {
  readonly iteration: number;
  readonly evaluation: FitEvaluation;
  readonly best: FitEvaluation;
}

export interface FitSessionOptions {
  readonly rmsThreshold?: number;
  readonly maxIterations?: number;
  readonly free?: readonly ParamKey[];
  /** Omit to fit with Nelder–Mead alone. */
  readonly agent?: Proposer;
  readonly onLog?: (entry: FitLogEntry) => void;
  readonly onProgress?: (progress: FitProgress) => void;
}

export interface FitSessionResult {
  readonly loop: FitLoopOutput;
  readonly best: FitEvaluation;
  readonly history: readonly FitEvaluation[];
  readonly log: readonly FitLogEntry[];
  readonly simulations: number;
}

/**
 * Converged once the window RMS is this small, cm: about the tracker's own
 * noise. The synthetic take's 0.7 px jitter at 11.5 px/cm leaves 0.086 cm
 * at the true parameters. A first guess for real takes, which may never
 * reach it; the loop then stops at its iteration budget with the best run.
 */
export const DEFAULT_RMS_THRESHOLD_CM = 0.1;
export const DEFAULT_MAX_ITERATIONS = 6;

/**
 * Starting restitutions the numeric fallback cycles through. The whole-window
 * error is not convex in e (a different e decides whether the ball reaches the
 * block before the freeze), so a local search needs several starts.
 */
const NUMERIC_RESTITUTION_STARTS = [0.5, 0.2, 0.8, 0.35, 0.65, 0.1] as const;

const fmt = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(3));

export function describeParams(params: SimParams, keys: readonly ParamKey[]): string {
  return keys.map((k) => `${k} ${fmt(params[k])}`).join(', ');
}

/** A release-time correction for the log, e.g. "+2.1 ms" (the real release was that much later than detected). */
export function describeShift(timeShiftSec: number): string {
  const ms = timeShiftSec * 1000;
  return `${ms >= 0 ? '+' : '−'}${Math.abs(ms).toFixed(1)} ms`;
}

/**
 * Runs one fit through the FitLoop machine (spec §6.2): each iteration a
 * proposer suggests parameters (the agent, or a numeric restart once the agent
 * has failed or when there is none), Nelder–Mead fine-tunes them, then the
 * result is simulated and scored on the fit window. Stops at the RMS
 * threshold or the iteration budget, and returns the best run.
 *
 * Reads only `problem`, which holds nothing after the fit window.
 */
export async function runFitSession(
  problem: FitProblem,
  initial: SimParams,
  options: FitSessionOptions = {},
): Promise<FitSessionResult> {
  const free = options.free ?? DEFAULT_FREE_PARAMS;
  const log: FitLogEntry[] = [];
  const write = (entry: FitLogEntry) => {
    log.push(entry);
    options.onLog?.(entry);
  };
  let simulations = 0;
  const evaluate = (params: SimParams, timeShiftSec: number) => {
    simulations++;
    return evaluateParams(problem, params, timeShiftSec);
  };

  const actor = createActor(fitLoopMachine, {
    input: {
      rmsThreshold: options.rmsThreshold ?? DEFAULT_RMS_THRESHOLD_CM,
      maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    },
  }).start();

  // The release correction comes from the ramp alone and is held for the whole fit (see fitReleaseShift).
  const release = fitReleaseShift(problem, initial);
  simulations += release.simulations;
  const shift = release.timeShiftSec;
  write({
    kind: 'numeric',
    text: `Release time refined on the ramp segment: ${describeShift(shift)} from the detected release.`,
  });

  const history: FitEvaluation[] = [];
  let best = evaluate(initial, shift);
  let pending: FitEvaluation | null = null;
  let restarts = 0;

  const tune = (start: SimParams) => {
    const tuned = polish(problem, start, shift, { free });
    simulations += tuned.simulations;
    return tuned;
  };
  const describeTuned = (tuned: { params: SimParams }) => describeParams(tuned.params, free);

  actor.send({ type: 'START', initial: best.params });
  // Every state below either sends an event or the loop is done; the guard only stops a machine bug looping forever.
  for (let guard = 0; guard < 1000 && actor.getSnapshot().status === 'active'; guard++) {
    const snapshot = actor.getSnapshot();
    const { iteration } = snapshot.context;
    if (snapshot.matches('proposing')) {
      if (!options.agent) {
        write({ kind: 'numeric', text: 'No agent configured: fitting with Nelder–Mead alone.' });
        actor.send({ type: 'AGENT_FAILED', error: 'no agent configured' });
        continue;
      }
      try {
        const proposal = await options.agent({
          iteration,
          best,
          history,
          windowEndSec: problem.windowEndSec,
          simulate: (params) => evaluate(params, shift),
          log: write,
        });
        if (proposal.note) write({ kind: 'agent', text: proposal.note });
        const tuned = tune(proposal.params);
        write({ kind: 'numeric', text: `Nelder–Mead from the agent's proposal: ${describeTuned(tuned)}.` });
        actor.send({ type: 'PROPOSAL', params: tuned.params, ...(proposal.note ? { note: proposal.note } : {}) });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        write({ kind: 'error', text: `Agent failed (${error}); continuing with Nelder–Mead alone.` });
        actor.send({ type: 'AGENT_FAILED', error });
      }
    } else if (snapshot.matches('numericOnly')) {
      const restitution = NUMERIC_RESTITUTION_STARTS[restarts % NUMERIC_RESTITUTION_STARTS.length] ?? 0.5;
      restarts++;
      const tuned = tune({ ...best.params, restitution });
      write({
        kind: 'numeric',
        text: `Nelder–Mead restart ${restarts} from e ${restitution}: ${describeTuned(tuned)}.`,
      });
      actor.send({ type: 'PROPOSAL', params: tuned.params });
    } else if (snapshot.matches('simulating')) {
      const current = snapshot.context.current;
      if (!current) throw new Error('FitLoop is simulating without parameters');
      pending = evaluate(current, shift);
      actor.send({ type: 'SIM_DONE' });
    } else if (snapshot.matches('scoring')) {
      if (!pending) throw new Error('FitLoop is scoring without a simulation');
      const evaluation = pending;
      pending = null;
      history.push(evaluation);
      if (evaluation.rmsCm < best.rmsCm || !Number.isFinite(best.rmsCm)) best = evaluation;
      write({
        kind: 'score',
        text: `Iteration ${iteration + 1}: RMS ${(evaluation.rmsCm * 10).toFixed(2)} mm (best ${(best.rmsCm * 10).toFixed(2)} mm).`,
      });
      options.onProgress?.({ iteration: iteration + 1, evaluation, best });
      actor.send({ type: 'SCORED', rms: evaluation.rmsCm });
    } else {
      throw new Error(`FitLoop stuck in ${JSON.stringify(snapshot.value)}`);
    }
  }

  const output = actor.getSnapshot().output;
  if (!output) throw new Error('FitLoop did not finish');
  return { loop: output, best, history, log, simulations };
}
