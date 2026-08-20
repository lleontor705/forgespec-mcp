import type Database from "better-sqlite3";
import { generateId } from "../utils/id.js";
import { AuditService } from "./audit-service.js";

export function sanitizePath(raw: string): string {
  const normalized = raw.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const segments = normalized.split("/");
  for (const seg of segments) {
    if (seg === "..") {
      throw new Error(`Path traversal disallowed: "${raw}"`);
    }
  }
  return normalized.replace(/^\.\//, "").trim();
}

export interface FileLease {
  id: string;
  project: string;
  path_pattern: string;
  holder: string;
  task_id: string | null;
  expires_at: number;
  created_at: number;
}

export class FileLeaseServiceV2 {
  private audit: AuditService;

  constructor(private db: Database.Database) {
    this.audit = new AuditService(db);
  }

  reserve(project: string, paths: string[], holder: string, taskId?: string, leaseSeconds = 300): { ok: true; leases: FileLease[]; expires_at: number } {
    const now = Date.now();
    const expiresAt = now + Math.min(Math.max(leaseSeconds, 15), 3600) * 1000;

    const sanitizedPaths = paths.map(sanitizePath);

    // Purge expired leases
    this.db.prepare("DELETE FROM v2_file_leases WHERE expires_at <= ?").run(now);

    // Check conflicts
    for (const pattern of sanitizedPaths) {
      const conflict = this.db.prepare(
        "SELECT * FROM v2_file_leases WHERE project = ? AND path_pattern = ? AND holder != ? AND expires_at > ?"
      ).get(project, pattern, holder, now) as FileLease | undefined;

      if (conflict) {
        throw new Error(`File lease conflict on "${pattern}": held by "${conflict.holder}" until ${new Date(conflict.expires_at).toISOString()}`);
      }
    }

    const leases: FileLease[] = [];
    const tx = this.db.transaction(() => {
      for (const pattern of sanitizedPaths) {
        const id = generateId("lease");
        this.db.prepare(
          `INSERT INTO v2_file_leases (id, project, path_pattern, holder, task_id, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(id, project, pattern, holder, taskId ?? null, expiresAt, now);

        leases.push({
          id,
          project,
          path_pattern: pattern,
          holder,
          task_id: taskId ?? null,
          expires_at: expiresAt,
          created_at: now,
        });
      }
    });
    tx();

    this.audit.record("file_lease", holder, "leases_acquired", holder, { project, paths: sanitizedPaths, count: leases.length });
    return { ok: true, leases, expires_at: expiresAt };
  }

  release(project: string, paths: string[], holder: string): { ok: true; released_count: number } {
    const sanitizedPaths = paths.map(sanitizePath);
    let count = 0;
    const tx = this.db.transaction(() => {
      for (const pattern of sanitizedPaths) {
        const res = this.db.prepare(
          "DELETE FROM v2_file_leases WHERE project = ? AND path_pattern = ? AND holder = ?"
        ).run(project, pattern, holder);
        count += res.changes;
      }
    });
    tx();

    this.audit.record("file_lease", holder, "leases_released", holder, { project, paths: sanitizedPaths, released_count: count });
    return { ok: true, released_count: count };
  }

  releaseByTaskId(taskId: string): number {
    const res = this.db.prepare("DELETE FROM v2_file_leases WHERE task_id = ?").run(taskId);
    return res.changes;
  }

  listActive(project?: string): FileLease[] {
    const now = Date.now();
    let sql = "SELECT * FROM v2_file_leases WHERE expires_at > ?";
    const params: unknown[] = [now];
    if (project) {
      sql += " AND project = ?";
      params.push(project);
    }
    return this.db.prepare(sql).all(...params) as FileLease[];
  }
}
