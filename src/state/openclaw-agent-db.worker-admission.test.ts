import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { runWithAgentCreationClaim } from "./agent-creation-claim.js";
import {
  beginAgentDeletionJournal,
  completeAgentDeletionJournalInDatabase,
} from "./agent-deletion-journal.js";
import { assertNoOpenClawAgentDatabaseLeases } from "./openclaw-agent-db-lease.js";
import { closeCachedOpenClawAgentDatabase } from "./openclaw-agent-db-lifecycle.js";
import {
  hasOpenClawAgentCanonicalValidation,
  markOpenClawAgentCanonicalValidation,
} from "./openclaw-agent-db-validation-cache.js";
import { withOpenClawAgentDatabaseWrite } from "./openclaw-agent-db-write.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { clearOpenClawAgentIntegrityVerification } from "./openclaw-quarantine-store.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function observeCallerSchemaInspections(...pathnames: string[]) {
  const inspections: string[] = [];
  const prepare = DatabaseSync.prototype.prepare;
  const observer = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (sql) {
    const location = this.location();
    if (
      (location === null || pathnames.includes(location)) &&
      /sqlite_(?:schema|master)|PRAGMA\s+(?:index_|table_|quick_check|integrity_check|foreign_key_check)/i.test(
        sql,
      )
    ) {
      inspections.push(sql);
    }
    return prepare.call(this, sql);
  });
  return { inspections, restore: () => observer.mockRestore() };
}

it("keeps a worker recreation private until its host creation claim joins native close", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-admit-creation-") };
  const options = { agentId: "recreated", env };
  const pathname = resolveOpenClawAgentSqlitePath(options);
  const deletion = beginAgentDeletionJournal(
    {
      operationId: "recreation",
      deleteFiles: true,
      agentId: options.agentId,
      agentDir: path.dirname(pathname),
      workspaceDir: path.join(env.OPENCLAW_STATE_DIR, "workspace"),
      sessionsDir: path.join(env.OPENCLAW_STATE_DIR, "sessions"),
    },
    { env },
  );
  runOpenClawStateWriteTransaction(
    (database) =>
      completeAgentDeletionJournalInDatabase(database, deletion.agentId, deletion.operationId),
    { env },
  );
  const outside = AsyncLocalStorage.snapshot();
  let opened: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
  await runWithAgentCreationClaim(options, async () => {
    const opening = withOpenClawAgentDatabaseWrite(options, (database) => {
      database.db.exec("INSERT INTO auth_profile_state VALUES ('created', '{}', 1)");
      return database;
    });
    await expect(
      outside(() => withOpenClawAgentDatabaseWrite(options, () => undefined)),
    ).rejects.toThrow(/active agent creation claim/);
    opened = await opening;
    expect(opened.db.isOpen).toBe(true);
    const alias = path.join(env.OPENCLAW_STATE_DIR, "alias.sqlite");
    fs.symlinkSync(pathname, alias);
    expect(() => outside(() => openOpenClawAgentDatabase({ ...options, path: alias }))).toThrow(
      /active agent creation claim/,
    );
  });
  expect(opened?.db.isOpen).toBe(false);
  expect(() => assertNoOpenClawAgentDatabaseLeases(options.agentId, { env })).not.toThrow();
  const reader = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    expect(
      reader.prepare("SELECT state_json FROM auth_profile_state WHERE state_key='created'").get(),
    ).toEqual({ state_json: "{}" });
  } finally {
    reader.close();
  }
});

it("admits cold storage in its worker and lends facts to every later native handle", async () => {
  const options = { agentId: "main", env: { OPENCLAW_STATE_DIR: tempDirs.make("agent-admit-") } };
  openOpenClawStateDatabase({ env: options.env });
  const pathname = resolveOpenClawAgentSqlitePath(options);
  const { inspections } = observeCallerSchemaInspections(pathname);
  const read = () =>
    withOpenClawAgentDatabaseWrite(options, (database) => {
      expect(getAdmittedSqliteSchemaFacts(database.db)?.tables.has("session_nodes")).toBe(true);
      return database.db.prepare("SELECT COUNT(*) AS count FROM session_nodes").get()?.count;
    });
  expect(await Promise.all([read(), read()])).toEqual([0, 0]);
  expect(inspections).toEqual([]);

  // The next synchronous caller and an idle-reopened handle consume the same worker admission.
  expect(openOpenClawAgentDatabase(options).db.isOpen).toBe(true);
  await closeOpenClawAgentDatabaseByPathAsync(pathname);
  expect(openOpenClawAgentDatabase(options).db.isOpen).toBe(true);
  expect(inspections).toEqual([]);
});

it.each(["eviction", "additive-table", "missing-index", "alias", "contract-convergence"] as const)(
  "readmits an evicted host handle with its retained worker after %s",
  async (change) => {
    const options = {
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("agent-retained-readmission-") },
    };
    openOpenClawStateDatabase({ env: options.env });
    const retainedExecution = captureOpenClawAgentDatabaseExecution(options);
    try {
      const database = await withOpenClawAgentDatabaseWrite(options, (opened) => {
        if (change === "additive-table") {
          opened.db.exec("CREATE TABLE coldadmit_fixture(value TEXT)");
        } else if (change === "missing-index") {
          opened.db.exec("DROP INDEX idx_agent_cache_expiry");
        } else if (change === "contract-convergence") {
          opened.db.exec(`INSERT INTO session_nodes
            (session_key, current_session_id, entry_json, updated_at)
            VALUES ('agent:main:existing', 'existing', '{"sessionId":"existing","updatedAt":1}', 1);
            UPDATE session_nodes SET entry_valid = 1;
            DELETE FROM session_canonical_validation_pending;`);
          expect(markOpenClawAgentCanonicalValidation(opened)).toBe(true);
          expect(hasOpenClawAgentCanonicalValidation(opened)).toBe(true);
          opened.db.exec("DROP TABLE session_key_contract");
        }
        return opened;
      });
      const nativeClaim = retainedExecution.captureGenerationClaim();
      const acquisitionPath =
        change === "alias"
          ? path.join(options.env.OPENCLAW_STATE_DIR, "alias.sqlite")
          : database.path;
      if (change === "alias") {
        fs.symlinkSync(database.path, acquisitionPath);
      }
      closeCachedOpenClawAgentDatabase(database, { eviction: true });
      expect(database.db.isOpen).toBe(false);
      nativeClaim.assertCurrent();
      const observed = observeCallerSchemaInspections(database.path, acquisitionPath);
      try {
        const count = await withOpenClawAgentDatabaseWrite(
          { ...options, path: acquisitionPath },
          (reopened) => {
            const facts = getAdmittedSqliteSchemaFacts(reopened.db);
            expect(facts?.tables.has("coldadmit_fixture")).toBe(change === "additive-table");
            expect(facts?.tables.has("session_nodes")).toBe(true);
            expect(facts?.tables.has("session_key_contract")).toBe(true);
            if (change === "contract-convergence") {
              expect(hasOpenClawAgentCanonicalValidation(reopened)).toBe(false);
            }
            return reopened.db.prepare("SELECT COUNT(*) AS count FROM session_nodes").get()?.count;
          },
        );
        expect(count).toBe(change === "contract-convergence" ? 1 : 0);
        nativeClaim.assertCurrent();
        expect(observed.inspections).toEqual([]);
      } finally {
        observed.restore();
      }
      if (change === "missing-index") {
        const inspector = openNodeSqliteDatabase(database.path, { readOnly: true });
        try {
          expect(
            inspector
              .prepare("SELECT sql FROM sqlite_schema WHERE name='idx_agent_cache_expiry'")
              .get()?.sql,
          ).toMatch(
            /^CREATE INDEX idx_agent_cache_expiry\s+ON cache_entries\(scope, expires_at, key\)\s+WHERE expires_at IS NOT NULL$/,
          );
        } finally {
          inspector.close();
        }
      }
    } finally {
      await retainedExecution.release();
    }
  },
);

it.each([
  { change: "schema", retainWorker: false },
  { change: "owner", retainWorker: false },
  { change: "replacement", retainWorker: false },
  { change: "damage", retainWorker: false },
  { change: "schema", retainWorker: true },
  { change: "owner", retainWorker: true },
  { change: "metadata-version", retainWorker: true },
  { change: "metadata-missing", retainWorker: true },
] as const)(
  "refuses $change drift after worker admission with retained worker=$retainWorker",
  async ({ change, retainWorker }) => {
    const options = {
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("agent-admit-drift-") },
    };
    const retainedExecution = retainWorker
      ? captureOpenClawAgentDatabaseExecution(options)
      : undefined;
    try {
      const database = await withOpenClawAgentDatabaseWrite(options, (opened) => opened);
      const pathname = database.path;
      if (retainedExecution) {
        closeCachedOpenClawAgentDatabase(database, { eviction: true });
      } else {
        await closeOpenClawAgentDatabasesAsync();
      }
      if (change === "replacement") {
        fs.copyFileSync(pathname, `${pathname}.replacement`);
        fs.renameSync(`${pathname}.replacement`, pathname);
      }
      if (change === "damage") {
        clearOpenClawAgentIntegrityVerification(pathname, options.env);
        fs.writeFileSync(pathname, "damaged SQLite fixture");
      } else {
        const editor = openNodeSqliteDatabase(pathname);
        try {
          const metadataChange = change === "owner" || change.startsWith("metadata-");
          const schemaBefore = metadataChange
            ? editor.prepare("PRAGMA schema_version").get()
            : undefined;
          editor.exec(
            change === "owner"
              ? "UPDATE schema_meta SET agent_id='another' WHERE meta_key='primary'"
              : change === "metadata-version"
                ? "UPDATE schema_meta SET schema_version=schema_version-1 WHERE meta_key='primary'"
                : change === "metadata-missing"
                  ? "DELETE FROM schema_meta WHERE meta_key='primary'"
                  : "ALTER TABLE auth_profile_state RENAME COLUMN state_json TO drifted_state_json",
          );
          if (metadataChange) {
            expect(editor.prepare("PRAGMA schema_version").get()).toEqual(schemaBefore);
          }
        } finally {
          editor.close();
        }
      }
      const operation = vi.fn();
      const observed = retainWorker ? observeCallerSchemaInspections(pathname) : undefined;
      try {
        await expect(withOpenClawAgentDatabaseWrite(options, operation)).rejects.toThrow(
          change === "owner" ? /belongs to agent another/ : /schema|malformed|not a database/i,
        );
        expect(operation).not.toHaveBeenCalled();
        if (observed) {
          expect(observed.inspections).toEqual([]);
        }
      } finally {
        observed?.restore();
      }
    } finally {
      await retainedExecution?.release();
    }
  },
);
