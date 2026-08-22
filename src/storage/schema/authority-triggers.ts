/** Integrity triggers for authority lineage and approval provenance.
 * Kept separate from leases, audit, evidence, and idempotency governance.
 */
export const AUTHORITY_TRIGGERS_SQL = `
  CREATE TRIGGER IF NOT EXISTS trg_fs_authority_resource_scope
    BEFORE INSERT ON fs_authority
    WHEN NOT (
      (NEW.resource_kind = 'board' AND NEW.resource_id = NEW.board_id)
      OR (NEW.resource_kind = 'task' AND EXISTS (
        SELECT 1 FROM fs_tasks WHERE board_id = NEW.board_id AND id = NEW.resource_id
      ))
    ) BEGIN SELECT RAISE(ABORT, 'authority resource is not in board scope'); END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_authority_parent_lineage
    BEFORE INSERT ON fs_authority
    WHEN NEW.lineage_kind = 'delegated' AND NOT EXISTS (
      SELECT 1 FROM fs_authority AS parent
       WHERE parent.authority_id = NEW.parent_authority_id
          AND (
            (parent.resource_kind = NEW.resource_kind AND parent.resource_id = NEW.resource_id AND parent.board_id = NEW.board_id)
            OR (parent.resource_kind = 'board' AND parent.resource_id = NEW.board_id
              AND NEW.resource_kind = 'task' AND parent.board_id = NEW.board_id)
          )
         AND parent.operation = NEW.operation
         AND parent.status = 'active'
         AND parent.expires_at >= NEW.granted_at
    ) BEGIN SELECT RAISE(ABORT, 'invalid authority parent lineage'); END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_authority_grantor_guard
    BEFORE INSERT ON fs_authority
    WHEN NEW.lineage_kind = 'delegated' AND NEW.granted_by_actor <> (
      SELECT grantee_actor FROM fs_authority WHERE authority_id = NEW.parent_authority_id
    ) BEGIN SELECT RAISE(ABORT, 'delegated authority must be granted by parent grantee'); END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_authority_delegation_revoked
    BEFORE INSERT ON fs_authority
    WHEN NEW.lineage_kind = 'delegated' AND EXISTS (
      SELECT 1 FROM fs_authority_revocations WHERE authority_id = NEW.parent_authority_id
    ) BEGIN SELECT RAISE(ABORT, 'parent authority has been revoked'); END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_authority_expiry_bound
    BEFORE INSERT ON fs_authority
    WHEN NEW.lineage_kind = 'delegated' AND EXISTS (
      WITH RECURSIVE chain(authority_id, parent_authority_id, expires_at) AS (
        SELECT authority_id, parent_authority_id, expires_at FROM fs_authority WHERE authority_id = NEW.parent_authority_id
        UNION ALL SELECT p.authority_id, p.parent_authority_id, p.expires_at
          FROM fs_authority p JOIN chain ON p.authority_id = chain.parent_authority_id
      ) SELECT 1 FROM chain WHERE expires_at < NEW.expires_at
    ) BEGIN SELECT RAISE(ABORT, 'child authority expiry cannot exceed parent'); END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_authority_chain_active
    BEFORE INSERT ON fs_authority
    WHEN NEW.lineage_kind = 'delegated' AND EXISTS (
      WITH RECURSIVE chain(authority_id, parent_authority_id, status) AS (
        SELECT authority_id, parent_authority_id, status FROM fs_authority WHERE authority_id = NEW.parent_authority_id
        UNION ALL SELECT p.authority_id, p.parent_authority_id, p.status
          FROM fs_authority p JOIN chain ON p.authority_id = chain.parent_authority_id
      ) SELECT 1 FROM chain WHERE status <> 'active'
    ) BEGIN SELECT RAISE(ABORT, 'parent authority in chain is not active'); END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_authority_chain_not_revoked
    BEFORE INSERT ON fs_authority
    WHEN NEW.lineage_kind = 'delegated' AND EXISTS (
      WITH RECURSIVE chain(authority_id, parent_authority_id) AS (
        SELECT authority_id, parent_authority_id FROM fs_authority WHERE authority_id = NEW.parent_authority_id
        UNION ALL SELECT p.authority_id, p.parent_authority_id
          FROM fs_authority p JOIN chain ON p.authority_id = chain.parent_authority_id
      ) SELECT 1 FROM chain JOIN fs_authority_revocations r ON r.authority_id = chain.authority_id
    ) BEGIN SELECT RAISE(ABORT, 'parent authority has been revoked'); END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_authority_revoke_descendants
    AFTER INSERT ON fs_authority_revocations BEGIN
      INSERT INTO fs_authority_revocations (revocation_id, authority_id, actor, reason, revoked_at)
      WITH RECURSIVE descendants(authority_id) AS (
        SELECT authority_id FROM fs_authority WHERE parent_authority_id = NEW.authority_id
        UNION ALL SELECT a.authority_id FROM fs_authority a JOIN descendants d ON a.parent_authority_id = d.authority_id
      ) SELECT 'propagated:' || authority_id, authority_id, NEW.actor, 'ancestor revoked: ' || NEW.reason, NEW.revoked_at
        FROM descendants WHERE true ON CONFLICT(authority_id) DO NOTHING;
    END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_authority_immutable_update BEFORE UPDATE ON fs_authority
    BEGIN SELECT RAISE(ABORT, 'authority grants are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_fs_authority_immutable_delete BEFORE DELETE ON fs_authority
    BEGIN SELECT RAISE(ABORT, 'authority grants are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_fs_authority_revocation_immutable_update BEFORE UPDATE ON fs_authority_revocations
    BEGIN SELECT RAISE(ABORT, 'authority revocations are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_fs_authority_revocation_immutable_delete BEFORE DELETE ON fs_authority_revocations
    BEGIN SELECT RAISE(ABORT, 'authority revocations are immutable'); END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_approvals_scope_guard
    BEFORE INSERT ON fs_approvals
    WHEN trim(NEW.actor) = '' OR trim(NEW.provenance_asserted_actor) = '' OR NOT EXISTS (
      SELECT 1 FROM fs_attempts a JOIN fs_tasks t ON t.board_id = a.board_id AND t.id = a.task_id
       JOIN fs_gates g ON g.board_id = a.board_id AND g.id = NEW.gate_id
       WHERE a.id = NEW.attempt_id AND a.board_id = NEW.board_id AND t.id = NEW.task_id
           AND a.state = 'active' AND a.expires_at >= unixepoch()
          AND json_type(g.allowed_actors_json) = 'array'
          AND g.allowed_actors_json = fs_normalize_actor_set(g.allowed_actors_json)
          AND EXISTS (SELECT 1 FROM json_each(g.allowed_actors_json) WHERE lower(trim(value)) = lower(trim(NEW.actor)))
    ) BEGIN SELECT RAISE(ABORT, 'approval actor, task, gate, and attempt must align'); END;
  CREATE TRIGGER IF NOT EXISTS trg_fs_approvals_immutable_update BEFORE UPDATE ON fs_approvals
    BEGIN SELECT RAISE(ABORT, 'approvals are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_fs_approvals_immutable_delete BEFORE DELETE ON fs_approvals
    BEGIN SELECT RAISE(ABORT, 'approvals are immutable'); END;
`;
