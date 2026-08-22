export const CORE_TRIGGERS_SQL = `
  CREATE TRIGGER IF NOT EXISTS trg_fs_gates_required_for_json_validate
  BEFORE INSERT ON fs_gates
  BEGIN
    SELECT CASE
      WHEN json_type(NEW.required_for_json) != 'array' THEN RAISE(ABORT, 'fs_gates.required_for_json must be an array')
    END;

    SELECT CASE
      WHEN json_array_length(NEW.required_for_json) = 0 THEN RAISE(ABORT, 'fs_gates.required_for_json must not be empty')
    END;

    SELECT CASE
      WHEN EXISTS (
        SELECT 1
        FROM json_each(NEW.required_for_json)
        WHERE typeof(value) != 'text'
          OR lower(value) NOT IN ('ready', 'in_progress', 'in_review', 'done', 'blocked')
      ) THEN RAISE(ABORT, 'fs_gates.required_for_json contains unsupported status')
    END;

    SELECT CASE
      WHEN (
        SELECT COUNT(*) - COUNT(DISTINCT lower(value))
        FROM json_each(NEW.required_for_json)
      ) > 0 THEN RAISE(ABORT, 'fs_gates.required_for_json must not contain duplicates')
    END;

    SELECT CASE
      WHEN json(NEW.required_for_json) != (
        SELECT json_group_array(value)
        FROM (
          SELECT DISTINCT lower(value) AS value
          FROM json_each(NEW.required_for_json)
          ORDER BY CASE lower(value)
            WHEN 'ready' THEN 1
            WHEN 'in_progress' THEN 2
            WHEN 'in_review' THEN 3
            WHEN 'done' THEN 4
            WHEN 'blocked' THEN 5
          END
        )
      ) THEN RAISE(ABORT, 'fs_gates.required_for_json must be normalized')
    END;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_gates_required_for_json_validate_update
  BEFORE UPDATE OF required_for_json ON fs_gates
  BEGIN
    SELECT CASE
      WHEN json_type(NEW.required_for_json) != 'array' THEN RAISE(ABORT, 'fs_gates.required_for_json must be an array')
    END;

    SELECT CASE
      WHEN json_array_length(NEW.required_for_json) = 0 THEN RAISE(ABORT, 'fs_gates.required_for_json must not be empty')
    END;

    SELECT CASE
      WHEN EXISTS (
        SELECT 1
        FROM json_each(NEW.required_for_json)
        WHERE typeof(value) != 'text'
          OR lower(value) NOT IN ('ready', 'in_progress', 'in_review', 'done', 'blocked')
      ) THEN RAISE(ABORT, 'fs_gates.required_for_json contains unsupported status')
    END;

    SELECT CASE
      WHEN (
        SELECT COUNT(*) - COUNT(DISTINCT lower(value))
        FROM json_each(NEW.required_for_json)
      ) > 0 THEN RAISE(ABORT, 'fs_gates.required_for_json must not contain duplicates')
    END;

    SELECT CASE
      WHEN json(NEW.required_for_json) != (
        SELECT json_group_array(value)
        FROM (
          SELECT DISTINCT lower(value) AS value
          FROM json_each(NEW.required_for_json)
          ORDER BY CASE lower(value)
            WHEN 'ready' THEN 1
            WHEN 'in_progress' THEN 2
            WHEN 'in_review' THEN 3
            WHEN 'done' THEN 4
            WHEN 'blocked' THEN 5
          END
        )
      ) THEN RAISE(ABORT, 'fs_gates.required_for_json must be normalized')
    END;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_gate_decisions_immutable_update
  BEFORE UPDATE ON fs_gate_decisions
  BEGIN
    SELECT RAISE(ABORT, 'fs_gate_decisions are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_tasks_status_transition_guard
  BEFORE UPDATE OF status ON fs_tasks
  FOR EACH ROW
  BEGIN
    SELECT CASE
      WHEN NEW.status = OLD.status THEN NULL

      WHEN NEW.status = 'done' AND NOT EXISTS (
        SELECT 1
        FROM fs_attempts
        WHERE board_id = NEW.board_id AND task_id = NEW.id AND state = 'active'
      )
      THEN RAISE(ABORT, 'done transition requires an active attempt')

      WHEN NEW.status IN ('ready', 'in_progress', 'in_review', 'done') AND EXISTS (
        SELECT 1
        FROM fs_task_dependencies AS d
        JOIN fs_tasks AS dependency
          ON dependency.board_id = d.dependency_board_id
         AND dependency.id = d.dependency_task_id
        WHERE d.task_board_id = NEW.board_id
          AND d.task_id = NEW.id
          AND dependency.status <> 'done'
      )
      THEN RAISE(ABORT, 'active transition requires all dependencies done')

      WHEN NEW.status IN ('ready', 'in_progress', 'in_review', 'done') AND EXISTS (
        SELECT 1
        FROM fs_gates AS gate
        JOIN json_each(gate.required_for_json) AS required
          ON lower(required.value) = NEW.status
        WHERE gate.board_id = NEW.board_id
          AND NOT EXISTS (
            SELECT 1
            FROM fs_gate_decisions AS decision
            WHERE decision.board_id = NEW.board_id
              AND decision.task_id = NEW.id
              AND decision.gate_id = gate.id
              AND decision.status = 'allow'
          )
      )
      THEN RAISE(ABORT, 'active transition requires allow decisions for all applicable gates')

      WHEN OLD.status = 'backlog' AND NEW.status NOT IN ('ready', 'blocked')
      THEN RAISE(ABORT, 'invalid backlog transition')

      WHEN OLD.status = 'ready' AND NEW.status NOT IN ('backlog', 'in_progress', 'blocked')
      THEN RAISE(ABORT, 'invalid ready transition')

      WHEN OLD.status = 'in_progress' AND NEW.status NOT IN ('in_review', 'done', 'blocked')
      THEN RAISE(ABORT, 'invalid in_progress transition')

      WHEN OLD.status = 'in_review' AND NEW.status NOT IN ('in_progress', 'done', 'blocked')
      THEN RAISE(ABORT, 'invalid in_review transition')

      WHEN OLD.status = 'blocked' AND NEW.status NOT IN ('backlog', 'ready')
      THEN RAISE(ABORT, 'invalid blocked transition')

      WHEN OLD.status = 'done'
      THEN RAISE(ABORT, 'done is terminal')
    END;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_contracts_parent_phase_guard
  BEFORE INSERT ON fs_contracts
  FOR EACH ROW
  BEGIN
    SELECT CASE
      WHEN NEW.parent_contract_id IS NULL AND (NEW.phase != 'init' OR NEW.revision != 1)
      THEN RAISE(ABORT, 'root contract must be init revision 1')

      WHEN NEW.parent_contract_id IS NULL THEN NULL

      WHEN NOT EXISTS (
        SELECT 1
        FROM fs_contracts
        WHERE id = NEW.parent_contract_id
      )
      THEN RAISE(ABORT, 'parent contract does not exist')

      WHEN COALESCE((SELECT project FROM fs_contracts WHERE id = NEW.parent_contract_id), '') != COALESCE(NEW.project, '')
        OR COALESCE((SELECT change_name FROM fs_contracts WHERE id = NEW.parent_contract_id), '') != COALESCE(NEW.change_name, '')
      THEN RAISE(ABORT, 'child contract project and change_name must match parent')

      WHEN (SELECT board_id FROM fs_contracts WHERE id = NEW.parent_contract_id) != NEW.board_id
      THEN RAISE(ABORT, 'child contract board_id must match parent')

      WHEN COALESCE((SELECT revision FROM fs_contracts WHERE id = NEW.parent_contract_id), 0) + 1 != NEW.revision
      THEN RAISE(ABORT, 'contract revision must be parent revision + 1')

      WHEN NOT (
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'init' AND NEW.phase = 'explore') OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'explore' AND NEW.phase = 'proposal') OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'proposal' AND NEW.phase = 'spec') OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'spec' AND NEW.phase = 'design') OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'design' AND NEW.phase = 'tasks') OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'tasks' AND NEW.phase = 'apply') OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'apply' AND NEW.phase = 'verify')
      )
      THEN RAISE(ABORT, 'invalid contract phase transition')
    END;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_contracts_parent_digest_immutable_update
  BEFORE UPDATE ON fs_contracts
  FOR EACH ROW
  BEGIN
    SELECT CASE
      WHEN NEW.parent_contract_id IS NULL AND (NEW.phase != 'init' OR NEW.revision != 1)
      THEN RAISE(ABORT, 'root contract must be init revision 1')
    END;

    SELECT CASE
      WHEN COALESCE(NEW.parent_contract_id, '') != COALESCE(OLD.parent_contract_id, '')
      THEN RAISE(ABORT, 'parent_contract_id is immutable')

      WHEN NEW.board_id != OLD.board_id
      THEN RAISE(ABORT, 'board_id is immutable')

      WHEN NEW.digest != OLD.digest
      THEN RAISE(ABORT, 'contract digest is immutable')

      WHEN NEW.project != OLD.project OR NEW.change_name != OLD.change_name OR NEW.revision != OLD.revision
      THEN RAISE(ABORT, 'contract lineage is immutable')

      WHEN NEW.parent_contract_id IS NOT NULL AND COALESCE(NEW.project, '') != COALESCE(
        (SELECT project FROM fs_contracts WHERE id = NEW.parent_contract_id), ''
      )
      THEN RAISE(ABORT, 'child contract project must match parent')

      WHEN NEW.parent_contract_id IS NOT NULL AND COALESCE(NEW.change_name, '') != COALESCE(
        (SELECT change_name FROM fs_contracts WHERE id = NEW.parent_contract_id), ''
      )
      THEN RAISE(ABORT, 'child contract change_name must match parent')

      WHEN NEW.parent_contract_id IS NOT NULL AND COALESCE((SELECT revision FROM fs_contracts WHERE id = NEW.parent_contract_id), 0) + 1 != NEW.revision
      THEN RAISE(ABORT, 'contract revision must remain parent revision + 1')

      WHEN NEW.parent_contract_id IS NOT NULL AND NOT (
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'init' AND NEW.phase = 'explore') OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'explore' AND NEW.phase = 'proposal') OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'proposal' AND NEW.phase = 'spec') OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'spec' AND NEW.phase = 'design') OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'design' AND NEW.phase = 'tasks') OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'tasks' AND NEW.phase = 'apply') OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'apply' AND NEW.phase = 'verify')
      )
      THEN RAISE(ABORT, 'invalid contract phase transition')
    END;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_gate_decisions_immutable_delete
  BEFORE DELETE ON fs_gate_decisions
  BEGIN
    SELECT RAISE(ABORT, 'fs_gate_decisions are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_task_dependencies_active_guard
  BEFORE INSERT ON fs_task_dependencies
  WHEN EXISTS (
    SELECT 1
    FROM fs_tasks AS task
    JOIN fs_tasks AS dependency
      ON dependency.board_id = NEW.dependency_board_id
     AND dependency.id = NEW.dependency_task_id
    WHERE task.board_id = NEW.task_board_id
      AND task.id = NEW.task_id
      AND task.status IN ('ready', 'in_progress', 'in_review', 'done')
      AND dependency.status <> 'done'
  )
  BEGIN
    SELECT RAISE(ABORT, 'active task cannot gain an unfinished dependency');
  END;
`;
