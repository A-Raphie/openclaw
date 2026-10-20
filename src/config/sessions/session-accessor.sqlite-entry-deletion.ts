import { isMainThread } from "node:worker_threads";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  retireSqliteDatabaseWriteScopes,
  sqliteSessionIdWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import { conversationPublication } from "./session-accessor.sqlite-conversation-publication.js";
import { commitSqliteSessionDeletion } from "./session-accessor.sqlite-deletion.js";
import { publishSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import { clearSqliteSessionEntryPreservingWindows } from "./session-accessor.sqlite-entry-clear.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import {
  deleteSessionDeliveryArtifacts,
  deleteSessionNodeArtifacts,
} from "./session-accessor.sqlite-node-artifacts.js";
import { collectSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson as parseSessionEntryRow } from "./session-accessor.sqlite-status.js";
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";
import { assertQuestionLifecycleWorker } from "./session-question-recovery-owner.js";
import { retireSessionQuestionsInDatabase } from "./session-questions-retirement.worker.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export function deleteSessionEntryRows(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  options: {
    deleteOwnedWindows?: boolean;
    deliveryCleanupKeys?: readonly string[];
    validatedEntry?: SessionEntry;
    postimages?: SessionEntryWritePostimages;
  } = {},
): boolean {
  // Lifecycle deletion reuses its transaction snapshot; Doctor also supplies validated legacy rows.
  const previousEntry =
    options.validatedEntry ?? readExactSessionEntryRow(database, sessionKey)?.entry;
  assertQuestionLifecycleWorker(previousEntry);
  if (previousEntry) {
    commitSqliteSessionDeletion(sessionKey, previousEntry);
  }
  const db = getSessionKysely(database.db);
  const windows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_windows").select("session_id").where("session_key", "=", sessionKey),
  ).rows;
  // Skip the survivor scan when maintenance reclaimed every window. Otherwise, project
  // reference metadata before acquiring rows to avoid loading unrelated saved prompts.
  const survivingNodes =
    windows.length > 0
      ? executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("session_nodes")
            .select([
              "current_session_id",
              "entry_json",
              "session_key",
              "entry_valid",
              "updated_at",
            ])
            .where("session_key", "!=", sessionKey)
            .orderBy("session_key", "asc"),
        ).rows
      : [];
  const ownedSessionIds: string[] = [];
  let transcriptInventoryUnchanged = options.deleteOwnedWindows !== true;
  for (const window of windows) {
    const survivingNode = survivingNodes.find((node) => {
      if (node.current_session_id === window.session_id) {
        return true;
      }
      const entry = parseSessionEntryRow(node);
      return entry ? collectSessionStateIdsForEntry(entry).includes(window.session_id) : false;
    });
    if (survivingNode) {
      transcriptInventoryUnchanged &&=
        resolveAgentIdFromSessionKey(sessionKey, database.agentId) ===
          resolveAgentIdFromSessionKey(survivingNode.session_key, database.agentId) &&
        isInternalSessionEffectsKey(sessionKey) ===
          isInternalSessionEffectsKey(survivingNode.session_key);
      withSqliteDatabaseWriteScope(
        database.db,
        [sessionKey, survivingNode.session_key, sqliteSessionIdWriteScope(window.session_id)],
        () =>
          executeSqliteQuerySync(
            database.db,
            db
              .updateTable("session_windows")
              .set({ session_key: survivingNode.session_key })
              .where("session_id", "=", window.session_id),
          ),
      );
      conversationPublication.stageRows(database, {
        nodes: [
          {
            ...survivingNode,
            entry_session_id: parseSessionEntryRow(survivingNode)?.sessionId ?? null,
          },
        ],
        rehomes: [
          { kind: "rehome", sessionId: window.session_id, sessionKey: survivingNode.session_key },
        ],
      });
      for (const postimage of options.postimages?.values() ?? []) {
        if (postimage.window.session_id === window.session_id) {
          postimage.window = { ...postimage.window, session_key: survivingNode.session_key };
        }
      }
    } else {
      ownedSessionIds.push(window.session_id);
    }
  }
  const remainingWindow = options.deleteOwnedWindows
    ? undefined
    : executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("session_windows")
          .select(["session_id", "updated_at"])
          .where("session_key", "=", sessionKey)
          .orderBy("updated_at", "desc")
          .orderBy("session_id", "asc")
          .limit(1),
      );
  withSqliteDatabaseWriteScope(
    database.db,
    [sessionKey, ...windows.map((window) => sqliteSessionIdWriteScope(window.session_id))],
    () => {
      if (options.deleteOwnedWindows) {
        deleteSessionDeliveryArtifacts(database, sessionKey, options.deliveryCleanupKeys);
      }
      if (options.deleteOwnedWindows || remainingWindow) {
        deleteSessionNodeArtifacts(database, sessionKey);
      }
      if (remainingWindow) {
        if (!isMainThread && previousEntry) {
          retireSessionQuestionsInDatabase(
            database,
            {
              sessionKey,
              sessionId: previousEntry.sessionId,
              lifecycleRevision: previousEntry.lifecycleRevision,
            },
            `retired:${previousEntry.sessionId}`,
          );
        }
        clearSqliteSessionEntryPreservingWindows(database, {
          sessionId: remainingWindow.session_id,
          sessionKey,
          updatedAt: remainingWindow.updated_at,
        });
      } else {
        executeSqliteQuerySync(
          database.db,
          db.deleteFrom("session_nodes").where("session_key", "=", sessionKey),
        );
        conversationPublication.stageRows(database, {
          removedNodes: [sessionKey],
          removedWindows: ownedSessionIds,
        });
        if (!isMainThread && previousEntry) {
          retireSessionQuestionsInDatabase(
            database,
            {
              sessionKey,
              sessionId: previousEntry.sessionId,
              lifecycleRevision: previousEntry.lifecycleRevision,
            },
            `retired:${previousEntry.sessionId}`,
          );
        }
        retireSqliteDatabaseWriteScopes(database.db, [
          sessionKey,
          ...ownedSessionIds.map(sqliteSessionIdWriteScope),
        ]);
      }
    },
  );
  options.postimages?.delete(sessionKey);
  publishSessionEntryCacheInvalidation(database, { sessionKey, facts: { kind: "removed" } });
  return transcriptInventoryUnchanged;
}
