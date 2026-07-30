/** The heartbeat-only grace period after ordinary attempt authority expires. */
export const HEARTBEAT_GRACE_MS = 5_000;

export interface AuthorityWindow {
  expiresAtMs: number;
  nowMs: number;
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
