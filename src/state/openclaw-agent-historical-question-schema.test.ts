import { constants, DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { AGENT_V14_BOARD_SCHEMA_SQL } from "./openclaw-agent-board-schema.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { getOpenClawAgentMigrationSchema } from "./openclaw-agent-db-schema-helpers.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import { AGENT_PROGRESS_CARD_SCHEMA_SQL } from "./openclaw-agent-progress-card-schema.js";
import { sessionQuestionsSchemaSql } from "./openclaw-agent-questions-schema.js";
import {
  AGENT_V14_ADDITIVE_SCHEMA_SQL,
  AGENT_V14_CORE_SCHEMA_SQL,
  AGENT_V14_SESSION_SHARING_SCHEMA_SQL,
} from "./openclaw-agent-session-sharing-schema.js";
import {
  captureOpenClawMigrationWitness,
  assertOpenClawMigrationWitnessPreserved,
} from "./openclaw-migration-witness.js";

describe("historical agent question schema boundaries", () => {
  it.each([
    AGENT_V14_CORE_SCHEMA_SQL,
    AGENT_V14_SESSION_SHARING_SCHEMA_SQL,
    AGENT_V14_ADDITIVE_SCHEMA_SQL,
    AGENT_V14_BOARD_SCHEMA_SQL,
    AGENT_PROGRESS_CARD_SCHEMA_SQL,
  ])("does not admit durable custody through a historical schema group", (schema) => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(schema);
      expect(
        db.prepare("SELECT name FROM sqlite_schema WHERE name = 'session_questions'").get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });
  it.each([24, 25, 26, 27, 28, 29, 30, 31, 32])(
    "retains the distinct FIFO and question contracts at schema %s",
    (version) => {
      using db = new DatabaseSync(":memory:");
      db.exec(getOpenClawAgentMigrationSchema(version));
      const question = db
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'session_questions'")
        .get();
      expect(Boolean(question)).toBe(version >= 32);
      const columns = db.prepare("PRAGMA table_info(context_engine_turn_outbox)").all();
      expect(columns.some((column) => column.name === "enqueue_sequence")).toBe(version >= 27);
    },
  );
});

it.each([
  { version: 25, rollback: false },
  { version: 26, rollback: false },
  { version: 25, rollback: true },
  { version: 26, rollback: true },
  { version: 31, rollback: false },
  { version: 31, rollback: true },
])(
  "migrates schema $version questions atomically (rollback=$rollback)",
  async ({ version, rollback }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.path(`questions-v${version}.sqlite`);
      using db = new DatabaseSync(pathname);
      db.exec(getOpenClawAgentMigrationSchema(version));
      db.exec(`PRAGMA user_version = ${version};
      INSERT INTO schema_meta(meta_key, role, schema_version, agent_id, created_at, updated_at)
      VALUES ('primary', 'agent', ${version}, 'main', 1, 1);
      UPDATE session_key_contract SET canonical_ready = 'retained';
      INSERT INTO session_canonical_validation_pending(session_key) VALUES ('agent:main:pending');`);
      const before = captureOpenClawMigrationWitness(db, { role: "agent", agentId: "main" });
      if (rollback) {
        db.setAuthorizer((action, name, value) =>
          action === constants.SQLITE_PRAGMA && name === "user_version" && value === "32"
            ? constants.SQLITE_DENY
            : constants.SQLITE_OK,
        );
      }
      await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
        const migrate = () =>
          ensureOpenClawAgentDatabaseSchema(db, {
            agentId: "main",
            env: state.env,
            path: pathname,
          });
        if (rollback) {
          expect(migrate).toThrow(/authoriz/u);
        } else {
          migrate();
        }
      });
      db.setAuthorizer(null);
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(rollback ? version : 32);
      expect(db.prepare("SELECT schema_version FROM schema_meta").get()?.schema_version).toBe(
        rollback ? version : 32,
      );
      expect(
        Boolean(
          db.prepare("SELECT name FROM sqlite_schema WHERE name = 'session_questions'").get(),
        ),
      ).toBe(!rollback);
      expect(
        assertOpenClawMigrationWitnessPreserved(
          before,
          captureOpenClawMigrationWitness(db, { role: "agent", agentId: "main" }),
        ),
      ).toEqual({ warnings: [] });
    });
  },
);
it("refuses the unpublished question schema28 prototype as a different main write-layout lineage", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const pathname = state.path("question-prototype-v28.sqlite");
    using db = new DatabaseSync(pathname);
    db.exec(getOpenClawAgentMigrationSchema(27));
    db.exec(sessionQuestionsSchemaSql(getOpenClawAgentMigrationSchema(32)));
    db.exec(`PRAGMA user_version = 28;
      INSERT INTO schema_meta(meta_key, role, schema_version, agent_id, created_at, updated_at)
      VALUES ('primary', 'agent', 28, 'main', 1, 1)`);
    const schema = () =>
      db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all();
    const before = schema();
    await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
      expect(() =>
        ensureOpenClawAgentDatabaseSchema(db, {
          agentId: "main",
          env: state.env,
          path: pathname,
          register: false,
        }),
      ).toThrow(/schema|enqueue_sequence/u);
    });
    expect(schema()).toEqual(before);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(28);
    expect(db.prepare("SELECT schema_version FROM schema_meta").get()?.schema_version).toBe(28);
  });
});
