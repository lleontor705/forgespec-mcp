import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { close, get, open, withDeferred, withImmediate } from "../../src/storage/database.js";

const tables = (db: Database.Database) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();

afterEach(() => close());

describe("storage database seam", () => {
  it("opens a fresh store with exactly 16 tables", () => {
    const db = open(":memory:");
    expect(tables(db)).toHaveLength(16);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("reuses the connection and restarts cleanly", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgespec-db-"));
    const file = path.join(directory, "restart.db");
    const db = open(file);
    expect(get()).toBe(db);
    close();
    const restarted = open(file);
    expect(tables(restarted)).toHaveLength(16);
    close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("rejects an incompatible database without mutation", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgespec-db-"));
    const file = path.join(directory, "foreign.db");
    const db = new Database(file);
    db.exec("CREATE TABLE foreign_inventory (value TEXT)");
    db.close();
    expect(() => open(file)).toThrow(/DATABASE_INCOMPATIBLE/);
    const unchanged = new Database(file);
    expect(tables(unchanged)).toEqual([{ name: "foreign_inventory" }]);
    unchanged.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("commits and rolls back immediate and deferred transactions", () => {
    const db = open(":memory:");
    db.exec("CREATE TABLE probe (value INTEGER) ");
    withImmediate(db, () => db.prepare("INSERT INTO probe VALUES (1)").run());
    expect(() => withDeferred(db, () => { db.prepare("INSERT INTO probe VALUES (2)").run(); throw new Error("rollback"); })).toThrow("rollback");
    expect(db.prepare("SELECT value FROM probe").all()).toEqual([{ value: 1 }]);
  });

  it("closes and permits a fresh lifecycle", () => {
    const db = open(":memory:");
    close();
    expect(() => db.prepare("SELECT 1").get()).toThrow();
    expect(() => close()).not.toThrow();
  });
});
