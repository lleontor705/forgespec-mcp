import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openIdentityStore, rememberReplay, cleanupReplay, beginReplay, finalizeReplay } from "../../src/identity/store.js";
import { IDENTITY_TABLE_NAMES } from "../../src/identity/schema.js";

describe("identity sidecar", () => {
  it("creates exactly five strict tables and reopens", () => {
    const db = openIdentityStore(":memory:");
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fsi_%' ORDER BY name").all() as { name: string }[]).map((x) => x.name)).toEqual([...IDENTITY_TABLE_NAMES].sort());
    expect((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    db.close();
  });
  it("rejects partial and foreign inventories without adding tables", () => {
    for (const [name, sql] of [["partial", "CREATE TABLE fsi_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT"], ["foreign", "CREATE TABLE other (x TEXT) STRICT"]]) {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fsi-")), name + ".db"); const seed = new Database(file); seed.exec(sql); seed.close();
      expect(() => openIdentityStore(file)).toThrow(/DATABASE_INCOMPATIBLE/);
      const check = new Database(file); expect((check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get() as { n: number }).n).toBe(1); check.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
  it("enforces replay uniqueness and bounded cleanup", () => {
    const db = openIdentityStore(":memory:");
    expect(rememberReplay(db, "i", "j", "c", 1, 1)).toBe(true); expect(rememberReplay(db, "i", "j", "c2", 1, 1)).toBe(false); expect(cleanupReplay(db, 3)).toBe(1); db.close();
  });
  it("fails closed when the pending replay row was deleted", () => {
    const db = openIdentityStore(":memory:");
    expect(beginReplay(db, { issuer: "i", jti: "j", callId: "c", keyId: "k", root: "r", parent: "p", worker: "w", tool: "t", argsDigest: "d", pendingAt: 1, expiresAt: 2 })).toBe(true);
    db.prepare("DELETE FROM fsi_replay WHERE issuer=? AND jti=?").run("i", "j");
    expect(() => finalizeReplay(db, { issuer: "i", jti: "j", callId: "c" }, { outcome: "success", code: "OK" })).toThrow("IDENTITY_AUDIT_FAILED");
    db.close();
  });
});
