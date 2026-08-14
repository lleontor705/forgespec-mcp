/** The heartbeat-only grace period after ordinary attempt authority expires. */
export const HEARTBEAT_GRACE_MS = 5_000;

export interface AuthorityWindow {
  expiresAtMs: number;
  nowMs: number;
}

export type AttemptAuthorityDenyCode =
  | "AUTH_ATTEMPT_MISMATCH"
  | "AUTH_ATTEMPT_INACTIVE"
  | "AUTH_ATTEMPT_EXPIRED";

export interface AttemptAuthorityInput extends AuthorityWindow {
  requestedAttemptId: string;
  activeAttemptId: string | null;
  requestedActor: string;
  attemptActor: string;
  tokenMatches: boolean;
  state: string;
}

export type AttemptAuthorityDecision =
  | { allowed: true; attemptId: string; expiresAtMs: number }
  | { allowed: false; code: AttemptAuthorityDenyCode };

/** Pure ordinary-attempt policy. All comparisons consume the caller's one nowMs. */
export function evaluateAttemptAuthority(input: AttemptAuthorityInput): AttemptAuthorityDecision {
  if (
    input.activeAttemptId !== input.requestedAttemptId
    || input.attemptActor !== input.requestedActor
    || !input.tokenMatches
  ) {
    return { allowed: false, code: "AUTH_ATTEMPT_MISMATCH" };
  }
  if (input.state !== "active") {
    return { allowed: false, code: "AUTH_ATTEMPT_INACTIVE" };
  }
  if (!hasOrdinaryAuthority(input)) {
    return { allowed: false, code: "AUTH_ATTEMPT_EXPIRED" };
  }
  return { allowed: true, attemptId: input.requestedAttemptId, expiresAtMs: input.expiresAtMs };
}

/** Ordinary reads and mutations are valid strictly before expiry. */
export function hasOrdinaryAuthority(window: AuthorityWindow): boolean {
  return window.nowMs < window.expiresAtMs;
}

/** Heartbeats remain valid strictly before the end of the grace period. */
export function hasHeartbeatAuthority(window: AuthorityWindow): boolean {
  return window.nowMs < window.expiresAtMs + HEARTBEAT_GRACE_MS;
}

/** Recovery is valid only once the heartbeat grace period has ended. */
export function mayRecover(window: AuthorityWindow): boolean {
  return window.nowMs >= window.expiresAtMs + HEARTBEAT_GRACE_MS;
}

/**
 * Object-shaped policy for callers that need to evaluate several capabilities
 * against one observed server timestamp.
 */
export const authorityPolicy = {
  ordinary(expiresAtMs: number, nowMs: number): boolean {
    return hasOrdinaryAuthority({ expiresAtMs, nowMs });
  },
  heartbeat(expiresAtMs: number, nowMs: number): boolean {
    return hasHeartbeatAuthority({ expiresAtMs, nowMs });
  },
  recovery(expiresAtMs: number, nowMs: number): boolean {
    return mayRecover({ expiresAtMs, nowMs });
  },
};

export type AuthorityPolicy = typeof authorityPolicy;
