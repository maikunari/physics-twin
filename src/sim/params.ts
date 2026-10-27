/**
 * The physical parameters the fitter tunes (spec §5). Rapier has no rolling
 * resistance, so rolling loss is modelled as angular damping on the ball.
 */
export interface SimParams {
  /** Friction coefficient between ball and ramp. */
  readonly muRamp: number;
  /** Friction coefficient between ball and table. */
  readonly muTable: number;
  /** Coefficient of restitution (bounce), 0–1. */
  readonly restitution: number;
  /** Angular damping standing in for rolling loss, 1/s. */
  readonly rollingDamping: number;
  /** Initial speed along the ramp, down-slope, m/s. */
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
