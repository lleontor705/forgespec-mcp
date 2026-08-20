import type Database from "better-sqlite3";

export interface AuditEvent {
  id: number;
  entity_type: string;
  entity_id: string;
  event_type: string;
  actor: string;
  payload: Record<string, unknown>;
  created_at: number;
}

export class AuditService {
  constructor(private db: Database.Database) {}

  record(entityType: string, entityId: string, eventType: string, actor: string, payload: Record<string, unknown> = {}): void {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO v2_audit_events (entity_type, entity_id, event_type, actor, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(entityType, entityId, eventType, actor, JSON.stringify(payload), now);
  }

  query(options: { entityType?: string; entityId?: string; limit?: number } = {}): AuditEvent[] {
    const limit = Math.min(options.limit ?? 50, 200);
    let sql = "SELECT * FROM v2_audit_events";
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (options.entityType) {
      conditions.push("entity_type = ?");
      params.push(options.entityType);
    }
    if (options.entityId) {
      conditions.push("entity_id = ?");
      params.push(options.entityId);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY id DESC LIMIT ?";
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => ({
      id: r.id,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      event_type: r.event_type,
      actor: r.actor,
      payload: JSON.parse(r.payload_json || "{}"),
      created_at: r.created_at,
    }));
  }
}
