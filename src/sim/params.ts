/**
 * The physical parameters the fitter tunes (spec §5), in the world frame's
 * centimetre units. Rapier has no rolling resistance, so rolling loss is
 * modelled as angular damping on the ball.
 */
export interface SimParams {
  /** Friction coefficient between ball and ramp. */
  readonly muRamp: number;
  /** Friction coefficient between ball and table (and the blocks on it). */
  readonly muTable: number;
  /** Coefficient of restitution (bounce), 0–1, for every contact the ball makes. */
  readonly restitution: number;
  /** Angular damping standing in for rolling loss, 1/s. */
  readonly rollingDamping: number;
  /** Initial speed along the ramp, down-slope, cm/s. */
  readonly v0: number;
  /** Initial angular velocity, rad/s (negative rolls the ball to the right). */
  readonly omega0: number;
}

export const DEFAULT_SIM_PARAMS: SimParams = {
  muRamp: 0.3,
  muTable: 0.3,
  restitution: 0.5,
  rollingDamping: 0.2,
  v0: 0,
  omega0: 0,
};

/**
 * The ball's moment of inertia as a multiple of m·r². Rapier 2D treats a ball
 * collider as a disc (1/2), which rolls about 7% slower down a slope than a
 * real solid ball, so the sim sets the inertia itself.
 */
export const BALL_INERTIA_FACTOR = {
  /** Solid sphere: a marble or a golf ball. */
  solid: 2 / 5,
  /** Thin spherical shell: a ping-pong ball. */
  hollow: 2 / 3,
} as const;

export type BallKind = keyof typeof BALL_INERTIA_FACTOR;
