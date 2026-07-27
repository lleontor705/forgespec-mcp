import type Database from "better-sqlite3";

export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class FakeClock implements Clock {
  constructor(private current: number) {}

  now(): number {
    return this.current;
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }

  set(milliseconds: number): void {
    this.current = milliseconds;
  }
}

export function observeServerTime(database: Database.Database, clock: Clock): number {
  const wallTime = clock.now();
  const row = database.prepare("SELECT last_observed_ms FROM server_clock_state WHERE singleton = 1").get() as
    | { last_observed_ms: number }
    | undefined;
  const effectiveTime = Math.max(wallTime, row?.last_observed_ms ?? wallTime);
  database.prepare(
    `INSERT INTO server_clock_state (singleton, last_observed_ms) VALUES (1, ?)
     ON CONFLICT(singleton) DO UPDATE SET last_observed_ms = MAX(last_observed_ms, excluded.last_observed_ms)`
  ).run(effectiveTime);
  return effectiveTime;
}
