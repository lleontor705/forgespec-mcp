/** Runtime integrity triggers. Authority and approval provenance stay separate. */
export const FS_CANONICAL_AUDIT_EVENT_HASH = "fs_canonical_audit_event_hash";
export const FS_NORMALIZE_ACTOR_SET = "fs_normalize_actor_set";
export const RUNTIME_TRIGGERS_SQL = `
  CREATE TRIGGER IF NOT EXISTS trg_fs_leases_active_attempt_guard
    BEFORE INSERT ON fs_leases
    WHEN NEW.state IN ('active', 'renewed') AND NOT EXISTS (
      SELECT 1 FROM fs_attempts a
       WHERE a.id = NEW.attempt_id AND a.state = 'active'
         AND a.actor = NEW.holder AND a.expires_at > unixepoch('now')
         AND NEW.expires_at > unixepoch('now') AND a.expires_at >= NEW.expires_at
    ) BEGIN SELECT RAISE(ABORT, 'active lease requires matching active unexpired attempt holder'); END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_leases_active_attempt_update_guard
    BEFORE UPDATE OF attempt_id, holder, state, expires_at ON fs_leases
    WHEN NEW.state IN ('active', 'renewed') AND NOT EXISTS (
      SELECT 1 FROM fs_attempts a
       WHERE a.id = NEW.attempt_id AND a.state = 'active'
         AND a.actor = NEW.holder AND a.expires_at > unixepoch('now')
         AND NEW.expires_at > unixepoch('now') AND a.expires_at >= NEW.expires_at
    ) BEGIN SELECT RAISE(ABORT, 'active lease requires matching active unexpired attempt holder'); END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_attempts_active_expiry_guard
    BEFORE INSERT ON fs_attempts WHEN NEW.state = 'active' AND NEW.expires_at <= unixepoch('now')
    BEGIN SELECT RAISE(ABORT, 'active attempt expiry must be in the future'); END;
  CREATE TRIGGER IF NOT EXISTS trg_fs_attempts_active_update_expiry_guard
    BEFORE UPDATE OF state, expires_at ON fs_attempts
    WHEN NEW.state = 'active' AND NEW.expires_at <= unixepoch('now')
    BEGIN SELECT RAISE(ABORT, 'active attempt expiry must be in the future'); END;
  CREATE TRIGGER IF NOT EXISTS trg_fs_attempts_active_leases_guard
    BEFORE UPDATE OF state, actor, expires_at ON fs_attempts
    WHEN EXISTS (SELECT 1 FROM fs_leases l WHERE l.attempt_id = OLD.id
      AND l.state IN ('active', 'renewed') AND (NEW.state <> 'active'
      OR NEW.expires_at <= unixepoch('now') OR NEW.expires_at < l.expires_at OR NEW.actor <> l.holder))
    BEGIN SELECT RAISE(ABORT, 'attempt update would invalidate active lease'); END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_audit_events_payload_guard
    BEFORE INSERT ON fs_audit_events
    WHEN EXISTS (SELECT 1 FROM json_tree(NEW.payload_json)
      WHERE key IS NOT NULL AND lower(key) IN ('secret', 'token', 'password', 'api_key'))
    BEGIN SELECT RAISE(ABORT, 'audit payload contains forbidden secret fields'); END;
  CREATE TRIGGER IF NOT EXISTS trg_fs_audit_events_chain_first
    BEFORE INSERT ON fs_audit_events WHEN NEW.event_ordinal = 1 AND
      EXISTS (SELECT 1 FROM fs_audit_events WHERE board_id = NEW.board_id AND resource_type = NEW.resource_type AND resource_id = NEW.resource_id)
    BEGIN SELECT RAISE(ABORT, 'event_ordinal 1 requires no prior resource events'); END;
  CREATE TRIGGER IF NOT EXISTS trg_fs_audit_events_chain_first_prev
    BEFORE INSERT ON fs_audit_events WHEN NEW.event_ordinal = 1 AND NEW.prev_hash IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'first audit event must not define prev_hash'); END;
  CREATE TRIGGER IF NOT EXISTS trg_fs_audit_events_chain_ordinal
    BEFORE INSERT ON fs_audit_events WHEN NEW.event_ordinal <> 1 AND NOT EXISTS
      (SELECT 1 FROM fs_audit_events WHERE board_id = NEW.board_id AND resource_type = NEW.resource_type AND resource_id = NEW.resource_id)
    BEGIN SELECT RAISE(ABORT, 'first audit event must have event_ordinal 1'); END;
  CREATE TRIGGER IF NOT EXISTS trg_fs_audit_events_chain_append
    BEFORE INSERT ON fs_audit_events WHEN EXISTS
      (SELECT 1 FROM fs_audit_events WHERE board_id = NEW.board_id AND resource_type = NEW.resource_type AND resource_id = NEW.resource_id)
      AND (NEW.event_ordinal <> (SELECT MAX(event_ordinal) + 1 FROM fs_audit_events
         WHERE board_id = NEW.board_id AND resource_type = NEW.resource_type AND resource_id = NEW.resource_id)
        OR NEW.prev_hash IS NULL OR NEW.prev_hash <> (SELECT event_hash FROM fs_audit_events
          WHERE board_id = NEW.board_id AND resource_type = NEW.resource_type AND resource_id = NEW.resource_id ORDER BY event_ordinal DESC LIMIT 1))
    BEGIN SELECT RAISE(ABORT, 'audit event must append to the previous resource chain'); END;
  CREATE TRIGGER IF NOT EXISTS trg_fs_audit_events_hash_guard
    BEFORE INSERT ON fs_audit_events WHEN NEW.event_hash <> ${FS_CANONICAL_AUDIT_EVENT_HASH}(
       NEW.board_id, NEW.task_id, NEW.attempt_id, NEW.actor, NEW.tool, NEW.event_type, NEW.resource_type,
      NEW.resource_id, NEW.event_ordinal, NEW.prev_hash, NEW.payload_json)
    BEGIN SELECT RAISE(ABORT, 'event_hash does not match canonical audit payload'); END;
  CREATE TRIGGER IF NOT EXISTS trg_fs_audit_events_resource_scope
    BEFORE INSERT ON fs_audit_events
    WHEN (NEW.resource_type = 'board' AND (NEW.resource_id <> NEW.board_id OR NOT EXISTS (SELECT 1 FROM fs_boards WHERE id = NEW.board_id)))
      OR (NEW.resource_type = 'task' AND NOT EXISTS (SELECT 1 FROM fs_tasks WHERE board_id = NEW.board_id AND id = NEW.resource_id))
      OR (NEW.resource_type = 'attempt' AND NOT EXISTS (SELECT 1 FROM fs_attempts WHERE board_id = NEW.board_id AND id = NEW.resource_id))
      OR (NEW.resource_type = 'contract' AND NOT EXISTS (SELECT 1 FROM fs_contracts WHERE board_id = NEW.board_id AND id = NEW.resource_id))
    BEGIN SELECT RAISE(ABORT, 'audit resource is outside board scope'); END;
  CREATE TRIGGER IF NOT EXISTS trg_fs_audit_events_immutable_update BEFORE UPDATE ON fs_audit_events
    BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_fs_audit_events_immutable_delete BEFORE DELETE ON fs_audit_events
    BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_evidence_immutable_update BEFORE UPDATE ON fs_evidence
    BEGIN SELECT RAISE(ABORT, 'evidence is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_fs_evidence_immutable_delete BEFORE DELETE ON fs_evidence
    BEGIN SELECT RAISE(ABORT, 'evidence is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_fs_idempotency_immutable_update BEFORE UPDATE ON fs_idempotency
    BEGIN SELECT RAISE(ABORT, 'idempotency records are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_fs_idempotency_immutable_delete BEFORE DELETE ON fs_idempotency
    BEGIN SELECT RAISE(ABORT, 'idempotency records are immutable'); END;
`;
