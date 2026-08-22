import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFreshStore } from "../src/storage/bootstrap.js";
import { createBoard } from "../src/domain/boards.js";
import { defineTask } from "../src/domain/tasks.js";
import { claimAttempt } from "../src/domain/attempts.js";
import { reserveLease, LeaseDomainError } from "../src/domain/leases/service.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forgespec-concurrency-"));
const dbPath = path.join(tmpDir, "concurrency.db");

let db: Database.Database;

beforeAll(() => {
  db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  createFreshStore(db);

  createBoard(db, {
    id: "board-concurrent",
    project: "concurrency-project",
    name: "Concurrency Board",
    actor: "owner",
    idempotencyKey: "init-board",
  });

  defineTask(db, {
    boardId: "board-concurrent",
    id: "task-concurrent",
    title: "Task Concurrent",
    priority: "p1",
    actor: "owner",
    idempotencyKey: "init-task",
    expectedBoardRevision: 1,
  });
});

afterAll(() => {
  db?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("multi-agent concurrency and lease contention", () => {
  it("allows only one active attempt on a task and rejects conflicting claims", () => {
    const claim1 = claimAttempt(db, {
      boardId: "board-concurrent",
      taskId: "task-concurrent",
      actor: "owner",
      idempotencyKey: "claim-agent-1",
      expectedTaskRevision: 1,
      leaseSeconds: 60,
    });
    expect(claim1.attemptId).toBeTruthy();

    expect(() =>
      claimAttempt(db, {
        boardId: "board-concurrent",
        taskId: "task-concurrent",
        actor: "owner",
        idempotencyKey: "claim-agent-2",
        expectedTaskRevision: 1,
        leaseSeconds: 60,
      })
    ).toThrow();
  });

  it("enforces lease exclusivity on overlapping file scopes under concurrent requests", () => {
    defineTask(db, {
      boardId: "board-concurrent",
      id: "task-lease-1",
      title: "Task Lease 1",
      priority: "p1",
      actor: "owner",
      idempotencyKey: "init-task-lease-1",
      expectedBoardRevision: 2,
    });
    defineTask(db, {
      boardId: "board-concurrent",
      id: "task-lease-2",
      title: "Task Lease 2",
      priority: "p1",
      actor: "owner",
      idempotencyKey: "init-task-lease-2",
      expectedBoardRevision: 3,
    });

    const attempt1 = claimAttempt(db, {
      boardId: "board-concurrent",
      taskId: "task-lease-1",
      actor: "owner",
      idempotencyKey: "claim-lease-1",
      expectedTaskRevision: 1,
      leaseSeconds: 60,
    });

    const attempt2 = claimAttempt(db, {
      boardId: "board-concurrent",
      taskId: "task-lease-2",
      actor: "owner",
      idempotencyKey: "claim-lease-2",
      expectedTaskRevision: 1,
      leaseSeconds: 60,
    });

    const lease1 = reserveLease(db, {
      boardId: "board-concurrent",
      taskId: "task-lease-1",
      attemptId: attempt1.attemptId,
      holder: "owner",
      claimToken: attempt1.claimToken!,
      paths: ["src/core/*"],
      casePolicy: "sensitive",
      idempotencyKey: "lease-res-1",
      leaseSeconds: 30,
    });
    expect(lease1.leaseId).toBeTruthy();

    expect(() =>
      reserveLease(db, {
        boardId: "board-concurrent",
        taskId: "task-lease-2",
        attemptId: attempt2.attemptId,
        holder: "owner",
        claimToken: attempt2.claimToken!,
        paths: ["src/core/tokens.ts"],
        casePolicy: "sensitive",
        idempotencyKey: "lease-res-2",
        leaseSeconds: 30,
      })
    ).toThrow(LeaseDomainError);

    const lease2 = reserveLease(db, {
      boardId: "board-concurrent",
      taskId: "task-lease-2",
      attemptId: attempt2.attemptId,
      holder: "owner",
      claimToken: attempt2.claimToken!,
      paths: ["src/storage/*"],
      casePolicy: "sensitive",
      idempotencyKey: "lease-res-3",
      leaseSeconds: 30,
    });
    expect(lease2.leaseId).toBeTruthy();
  });
});
