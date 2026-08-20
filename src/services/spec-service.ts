import type Database from "better-sqlite3";
import { generateId } from "../utils/id.js";
import { AuditService } from "./audit-service.js";
import { SddPhase } from "../types/index.js";

export interface SaveSpecInput {
  project: string;
  phase: SddPhase;
  change_name: string;
  status: "success" | "partial" | "failed" | "blocked";
  confidence: number;
  executive_summary: string;
  contract_data?: Record<string, unknown>;
  actor?: string;
}

export class SpecService {
  private audit: AuditService;

  constructor(private db: Database.Database) {
    this.audit = new AuditService(db);
  }

  saveSpec(input: SaveSpecInput): { ok: true; id: string; revision: number; phase: string } {
    const now = Date.now();
    const actor = input.actor || "default-agent";
    const existing = this.db.prepare(
      "SELECT id, revision FROM v2_spec_contracts WHERE project = ? AND phase = ?"
    ).get(input.project, input.phase) as { id: string; revision: number } | undefined;

    let id: string;
    let revision: number;

    const contractJson = JSON.stringify(input.contract_data ?? {});

    if (existing) {
      id = existing.id;
      revision = existing.revision + 1;
      this.db.prepare(
        `UPDATE v2_spec_contracts
            SET change_name = ?, status = ?, confidence = ?, executive_summary = ?,
                revision = ?, contract_json = ?, updated_at = ?
          WHERE id = ?`
      ).run(input.change_name, input.status, input.confidence, input.executive_summary, revision, contractJson, now, id);
    } else {
      id = generateId("spec");
      revision = 1;
      this.db.prepare(
        `INSERT INTO v2_spec_contracts
            (id, project, phase, change_name, status, confidence, executive_summary, revision, contract_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      ).run(id, input.project, input.phase, input.change_name, input.status, input.confidence, input.executive_summary, contractJson, now, now);
    }

    this.audit.record("spec", id, existing ? "spec_updated" : "spec_created", actor, {
      project: input.project,
      phase: input.phase,
      revision,
      status: input.status,
    });

    return { ok: true, id, revision, phase: input.phase };
  }

  getSpec(project: string, phase: string): Record<string, unknown> | null {
    const row = this.db.prepare(
      "SELECT * FROM v2_spec_contracts WHERE project = ? AND phase = ?"
    ).get(project, phase) as any;

    if (!row) return null;
    return {
      id: row.id,
      project: row.project,
      phase: row.phase,
      change_name: row.change_name,
      status: row.status,
      confidence: row.confidence,
      executive_summary: row.executive_summary,
      revision: row.revision,
      data: JSON.parse(row.contract_json || "{}"),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  listSpecs(project: string): Array<Record<string, unknown>> {
    const rows = this.db.prepare(
      "SELECT id, project, phase, change_name, status, confidence, revision, updated_at FROM v2_spec_contracts WHERE project = ? ORDER BY created_at ASC"
    ).all(project) as any[];

    return rows;
  }
}
