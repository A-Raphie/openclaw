import { isMainThread } from "node:worker_threads";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  retireSqliteDatabaseWriteScopes,
  sqliteSessionIdWriteScope,
  withoutSqliteDatabaseWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import { communicationEntryBinding } from "../../sessions/communication-admission.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSessionActivitySummary } from "./activity-summary.js";
import type { ConversationRouteContext } from "./conversation-route-context.js";
import { prepareLegacyAcpMigrationSourcesForEntryWrite } from "./session-accessor.sqlite-acp-provenance.js";
import { conversationPublication } from "./session-accessor.sqlite-conversation-publication.js";
import {
  linkSessionConversation,
  prepareConversationIdentities,
  prepareSessionConversationForWrite,
  upsertConversationIdentities,
} from "./session-accessor.sqlite-conversation.js";
import { commitSqliteSessionDeletion } from "./session-accessor.sqlite-deletion.js";
import { projectSessionEntryCacheUpdate } from "./session-accessor.sqlite-entry-cache-projection.js";
import {
  publishSessionEntryCacheInvalidation,
  trackSessionEntryCacheWrite,
} from "./session-accessor.sqlite-entry-cache.js";
import { sessionSharingEntriesEqual } from "./session-accessor.sqlite-entry-cache.types.js";
import { deleteSessionEntryRows } from "./session-accessor.sqlite-entry-deletion.js";
import type { SqliteLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-equality.js";
import {
  readExactSessionEntryRow,
  type ResolvedSessionEntryRow,
} from "./session-accessor.sqlite-entry-read.js";
import { captureSessionEntrySnapshot } from "./session-accessor.sqlite-entry-snapshot.js";
import { getSessionEntryWriteQueries } from "./session-accessor.sqlite-entry-write-queries.js";
import { advanceSessionEntryMaintenanceAgeFact } from "./session-accessor.sqlite-maintenance-age.js";
import {
  clearSessionCollaborationForKey,
  copySessionNodeArtifactsForRepair,
} from "./session-accessor.sqlite-node-artifacts.js";
import { prepareSessionEntryWindowRow } from "./session-accessor.sqlite-provenance.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { bindSessionNode, bindSessionRoot } from "./session-accessor.sqlite-session-row.js";
import { hasValidSessionEntryIdentity } from "./session-accessor.sqlite-status.js";
import { readSessionTranscriptWatermarkInDatabase } from "./session-accessor.sqlite-transcript-watermark.js";
import {
  readSessionActorTransactionState,
  replaceSessionActorStoredEntry,
} from "./session-actor-transaction.js";
import {
  assertCanonicalSessionEntryLineageWrite,
  assertCanonicalSessionKeyWrite,
  canonicalSessionKeyMigrationRequiredError,
  markCanonicalSessionValidationPending,
} from "./session-canonical-key.js";
import { validateCanonicalSessionRow } from "./session-canonical-row.js";
import { normalizeSessionEntryTimestamp } from "./session-entry-json.js";
import {
  splitSessionEntrySnapshots,
  writeSessionEntrySnapshots,
} from "./session-entry-snapshots.js";
import type { SessionEntryWindowFacts } from "./session-entry-window.types.js";
import { applySessionEntryWritePolicy } from "./session-entry-write-policy.js";
import {
  createSessionEntryWriteRow,
  type SessionEntryWritePostimage,
  type SessionEntryWritePostimages,
} from "./session-entry-write-postimage.js";
import { resolveSessionPublicShare } from "./session-public-share.js";
import {
  assertQuestionAliasRelocation,
  assertQuestionLifecycleWorker,
} from "./session-question-recovery-owner.js";
import { retireSessionQuestionsInDatabase } from "./session-questions-retirement.worker.js";
import {
  readStagedSessionTranscriptUpdatedAt,
  readStagedSessionTranscriptAuthority,
} from "./session-transcript-authority.js";
import {
  projectCanonicalSessionEntryShape,
  stripRuntimeOnlySessionSkillsFields,
} from "./store-entry-shape.js";
import { resolveDeliveryProvenCanonicalSessionKey } from "./store-entry.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";
export {
  parseReadableSqliteSessionEntryRow,
  readExactSessionEntryRow,
  readExactSessionEntryRowValidated,
  readSessionEntryRow,
  type ResolvedSessionEntryRow,
} from "./session-accessor.sqlite-entry-read.js";
export {
  readSessionEntryCount,
  readSessionEntryStore,
} from "./session-accessor.sqlite-entry-inventory.js";
export {
  normalizeLifecycleTarget,
  readLifecycleTargetSnapshot,
  readSessionIdentitySnapshot,
  readSessionEntrySelectionSnapshot,
  resolveLifecyclePrimaryEntry,
} from "./session-accessor.sqlite-entry-snapshot.js";

export { deleteSessionEntryRows } from "./session-accessor.sqlite-entry-deletion.js";

export function deleteLifecycleTargetRows(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  snapshot: SqliteLifecycleTargetSnapshot,
): boolean {
  let transcriptInventoryUnchanged = true;
  for (const sessionKey of uniqueStrings([target.canonicalKey, ...target.storeKeys])) {
    const trimmed = sessionKey.trim();
    if (trimmed) {
      const unchanged = deleteSessionEntryRows(database, trimmed, {
        validatedEntry: snapshot.find((row) => row.sessionKey === trimmed)?.entry,
      });
      transcriptInventoryUnchanged &&= unchanged;
    }
  }
  return transcriptInventoryUnchanged;
}

export function deleteLegacySessionEntryRows(
  database: OpenClawAgentDatabase,
  legacyKeys: string[],
  sessionKey: string,
  options: {
    rehomeMembers?: boolean;
    validatedEntries?: ReadonlyMap<string, SessionEntry>;
    postimages?: SessionEntryWritePostimages;
  } = {},
): void {
  if (legacyKeys.length === 0) {
    return;
  }
  const removals = legacyKeys
    .filter((key) => key !== sessionKey)
    .map((legacyKey) => ({
      legacyKey,
      previousEntry:
        options.validatedEntries?.get(legacyKey) ??
        readExactSessionEntryRow(database, legacyKey)?.entry,
    }));
  for (const { previousEntry } of removals) {
    assertQuestionAliasRelocation(previousEntry);
  }
  const db = getSessionKysely(database.db);
  for (const { legacyKey, previousEntry } of removals) {
    if (previousEntry) {
      commitSqliteSessionDeletion(legacyKey, previousEntry);
    }
    rehomeSessionWindows(database, sessionKey, [legacyKey], options.postimages);
    copySessionNodeArtifactsForRepair(database, database, [legacyKey], sessionKey, {
      includeMembers: options.rehomeMembers,
      postimages: options.postimages,
    });
    withSqliteDatabaseWriteScope(database.db, [legacyKey], () =>
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("session_nodes").where("session_key", "=", legacyKey),
      ),
    );
    retireSqliteDatabaseWriteScopes(database.db, [legacyKey]);
    conversationPublication.stageRows(database, { removedNodes: [legacyKey] });
    options.postimages?.delete(legacyKey);
    const canonicalPostimage = options.postimages?.get(sessionKey);
    if (canonicalPostimage) {
      canonicalPostimage.changed = true;
    }
    publishSessionEntryCacheInvalidation(database, { sessionKey: legacyKey });
  }
  publishSessionEntryCacheInvalidation(database, { sessionKey });
}

/** Move retained generations to the canonical node before removing key aliases. */
export function rehomeSessionWindows(
  database: OpenClawAgentDatabase,
  canonicalKey: string,
  previousKeys: Iterable<string>,
  postimages?: SessionEntryWritePostimages,
): void {
  const legacyKeys = uniqueStrings([...previousKeys].map((key) => key.trim())).filter(
    (key) => key && key !== canonicalKey,
  );
  if (legacyKeys.length === 0) {
    return;
  }
  const db = getSessionKysely(database.db);
  // Offline repair can move shared windows whose other logical readers are not in this key set.
  withoutSqliteDatabaseWriteScope(database.db, () =>
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_windows")
        .set({ session_key: canonicalKey })
        .where("session_key", "in", legacyKeys),
    ),
  );
  conversationPublication.stageRows(database, {
    rehomes: [{ kind: "rehome", sessionKey: canonicalKey, previousKeys: legacyKeys }],
  });
  for (const postimage of postimages?.values() ?? []) {
    if (legacyKeys.includes(postimage.window.session_key)) {
      postimage.window = { ...postimage.window, session_key: canonicalKey };
    }
  }
}

export function writeSessionEntry(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  entry: SessionEntry,
  options: {
    allowStoredAliases?: boolean;
    /** Only the personal involvement owner may replace this logical-node state. */
    profileInvolvement?: SessionEntry["profileInvolvement"];
    /** Only the provider review owner may replace a generation-bound pause. */
    providerReviewMutation?: boolean;
    /** Only durable custody owns the native restart exclusion marker. */
    questionOwnerMutation?: boolean;
    /** Canonical row revalidated in this write transaction; null proves absence. */
    canonicalPreviousEntry?: SessionEntry | null;
    /** Raw canonical columns from the same transaction, for exact no-op comparison. */
    canonicalPreviousRow?: ResolvedSessionEntryRow["row"];
    canonicalPreviousWindow?: SessionEntryWindowFacts;
    canonicalPreviousSideTables?: SessionEntryWritePostimage["sideTables"];
    postimages?: SessionEntryWritePostimages;
    consumePendingReset?: boolean;
    /** A rehome can bind historical windows to an otherwise unchanged target. */
    publishConversationBinding?: boolean;
    preserveNodeSuggestions?: boolean;
    previousEntry?: SessionEntry | null;
    observeConversation?: boolean;
    routeContext?: ConversationRouteContext | null;
  } = {},
): SessionEntry {
  const actor = readSessionActorTransactionState(database, { sessionKey });
  if (actor && sessionKey !== actor.hot.target.sessionKey) {
    throw new Error("Session actor cannot write a lookup sibling");
  }
  if (!options.allowStoredAliases) {
    assertCanonicalSessionKeyWrite(sessionKey);
    assertCanonicalSessionEntryLineageWrite(entry);
    if (resolveDeliveryProvenCanonicalSessionKey(sessionKey, entry) !== sessionKey) {
      throw canonicalSessionKeyMigrationRequiredError(
        `refusing non-canonical session key write ${sessionKey}`,
      );
    }
  }
  let normalizedEntry: SessionEntry = normalizeSessionEntryTimestamp(entry);
  if (!hasValidSessionEntryIdentity(normalizedEntry)) {
    throw new Error("Refusing invalid SQLite session entry identity");
  }
  // Doctor validated the raw rejected row before entering the transaction and passes its
  // hydrated snapshot explicitly; re-reading it through the runtime parser must stay fail-closed.
  // The commit owner can supply its revalidated canonical row instead of decoding it again.
  const canonicalRead =
    options.canonicalPreviousEntry !== undefined ||
    (options.allowStoredAliases && options.previousEntry !== undefined)
      ? undefined
      : readExactSessionEntryRow(
          database,
          sessionKey,
          "full",
          undefined,
          options.postimages ? true : undefined,
        );
  const canonicalPreviousEntry =
    options.canonicalPreviousEntry !== undefined
      ? (options.canonicalPreviousEntry ?? undefined)
      : options.allowStoredAliases && options.previousEntry !== undefined
        ? (options.previousEntry ?? undefined)
        : canonicalRead?.entry;
  const lifecycleChanged =
    canonicalPreviousEntry !== undefined &&
    (canonicalPreviousEntry.sessionId !== normalizedEntry.sessionId ||
      canonicalPreviousEntry.lifecycleRevision !== normalizedEntry.lifecycleRevision);
  if (lifecycleChanged) {
    assertQuestionLifecycleWorker(canonicalPreviousEntry);
  }
  if (!options.questionOwnerMutation && !options.allowStoredAliases) {
    normalizedEntry = {
      ...normalizedEntry,
      durableQuestionOwners: !lifecycleChanged
        ? canonicalPreviousEntry?.durableQuestionOwners
        : undefined,
    };
  }
  const canonicalPreviousRow =
    options.canonicalPreviousRow ?? actor?.entryRows.get(sessionKey)?.row ?? canonicalRead?.row;
  const canonicalFacts = canonicalRead && captureSessionEntrySnapshot(canonicalRead);
  const canonicalPreviousSideTables =
    options.canonicalPreviousSideTables ??
    canonicalFacts?.sideTables ??
    (actor
      ? {
          memberIdsJson: JSON.stringify(actor.hot.members.map((member) => member.identityId)),
          hasBoard: actor.hasBoard,
        }
      : canonicalPreviousEntry === undefined
        ? { memberIdsJson: "[]", hasBoard: false }
        : undefined);
  if (options.postimages && !canonicalPreviousSideTables) {
    throw new Error("Session entry postimage requires prepared side-table facts");
  }
  const normalized = applySessionEntryWritePolicy(
    database.agentId,
    sessionKey,
    entry,
    normalizedEntry,
    canonicalPreviousEntry,
    options,
  );
  normalizedEntry = normalized.entry;
  // Public/plugin projections omit this server-owned field. Same-session replacements
  // retain publication; only an explicit field clear or a new session id revokes it.
  if (
    !Object.hasOwn(normalizedEntry, "publicShare") &&
    canonicalPreviousEntry?.sessionId === normalizedEntry.sessionId
  ) {
    normalizedEntry.publicShare = resolveSessionPublicShare(canonicalPreviousEntry);
  }
  // A copied or reset entry must never publish its replacement generation.
  // Checking the embedded binding also covers forks into previously absent nodes.
  if (
    normalizedEntry.incognito === true ||
    normalizedEntry.publicShare?.sessionId !== normalizedEntry.sessionId
  ) {
    delete normalizedEntry.publicShare;
  }
  const previousEntry = normalized.previousEntry;
  const updatedAt = normalizedEntry.updatedAt;
  const canonicalEntry = stripRuntimeOnlySessionSkillsFields(
    projectCanonicalSessionEntryShape({ ...normalizedEntry }),
  );
  const persisted = splitSessionEntrySnapshots(canonicalEntry, {
    previousEntry: canonicalPreviousEntry,
  });
  const legacySources = prepareLegacyAcpMigrationSourcesForEntryWrite(
    database,
    sessionKey,
    normalizedEntry,
    canonicalPreviousEntry,
    canonicalPreviousRow,
  );
  const sessionNode = {
    ...bindSessionNode({
      entry: canonicalEntry,
      entryJson: persisted.entryJson,
      sessionKey,
      updatedAt,
    }),
    ...legacySources,
  };
  const previousColumns = new Map(Object.entries(canonicalPreviousRow ?? {}));
  const nodeChanged =
    options.allowStoredAliases === true ||
    canonicalPreviousRow === undefined ||
    Object.entries(sessionNode).some(([key, value]) => previousColumns.get(key) !== value);
  if (!options.allowStoredAliases) {
    // SQLite binds TEXT as UTF-8. Validate that exact projection before any write,
    // including serialization hooks and replacement of unpaired UTF-16 surrogates.
    validateCanonicalSessionRow({
      ...sessionNode,
      session_key: sessionNode.session_key.toWellFormed(),
      current_session_id: sessionNode.current_session_id.toWellFormed(),
      entry_json: sessionNode.entry_json.toWellFormed(),
      parent_session_key: sessionNode.parent_session_key?.toWellFormed() ?? null,
      spawned_by: sessionNode.spawned_by?.toWellFormed() ?? null,
      fork_source_session_key: sessionNode.fork_source_session_key?.toWellFormed() ?? null,
      retained_window_id: null,
    });
  } else {
    // Offline import/repair can stage aliases; readiness must validate them before use.
    markCanonicalSessionValidationPending(database, [sessionKey]);
  }
  const written = withSqliteDatabaseWriteScope(
    database.db,
    [sessionKey, sqliteSessionIdWriteScope(normalizedEntry.sessionId)],
    () => {
      // Collaboration rows belong to the exact canonical node being overwritten,
      // which can differ from the selected alias during canonicalization.
      if (
        canonicalPreviousEntry &&
        canonicalPreviousEntry.sessionId !== normalizedEntry.sessionId
      ) {
        // Doctor merges duplicate logical nodes; suggestions are owned by session_key,
        // not by the transcript generation being replaced. Membership remains winner-only.
        clearSessionCollaborationForKey(database, sessionKey, {
          clearSuggestions: options.preserveNodeSuggestions !== true,
        });
      }
      const boundSessionRoot = bindSessionRoot({ entry: normalizedEntry, sessionKey, updatedAt });
      const preparedWindow = options.canonicalPreviousWindow ?? canonicalFacts?.window;
      const { conversation, primaryConversationId } = prepareSessionConversationForWrite({
        database,
        entry: normalizedEntry,
        previousEntry,
        canonicalPreviousEntry,
        previousWindow: actor?.window ?? preparedWindow?.row,
        observeConversation: options.observeConversation || options.allowStoredAliases,
        ...(options.routeContext !== undefined ? { routeContext: options.routeContext } : {}),
        sessionScope: boundSessionRoot.session_scope,
      });
      const retainWindowOwner = canonicalPreviousEntry?.sessionId === normalizedEntry.sessionId;
      const window = prepareSessionEntryWindowRow({
        boundSessionRow: { ...boundSessionRoot, primary_conversation_id: primaryConversationId },
        database,
        entry: normalizedEntry,
        previousEntry,
        retainOwner: retainWindowOwner,
        prepared: preparedWindow,
        stagedTranscriptUpdatedAt: actor
          ? undefined
          : readStagedSessionTranscriptUpdatedAt(database, normalizedEntry.sessionId),
      });
      const queries = getSessionEntryWriteQueries(database.db);
      const changed =
        nodeChanged || persisted.snapshotsChanged || window.changed || conversation !== null;
      const writeGeneration = changed
        ? trackSessionEntryCacheWrite(database, () => {
            if (conversation) {
              upsertConversationIdentities(
                database,
                prepareConversationIdentities([conversation.identity]),
                updatedAt,
              );
            }
            if (nodeChanged) {
              const writeNode =
                "legacy_acp_migration_json" in legacySources
                  ? queries.nodeWithLegacySources
                  : queries.node;
              writeNode(sessionNode);
            }
            if (lifecycleChanged && canonicalPreviousEntry && !isMainThread) {
              retireSessionQuestionsInDatabase(
                database,
                {
                  sessionKey,
                  sessionId: canonicalPreviousEntry.sessionId,
                  lifecycleRevision: canonicalPreviousEntry.lifecycleRevision,
                },
                `retired:${canonicalPreviousEntry.sessionId}`,
              );
            }
            if (persisted.snapshotsChanged) {
              writeSessionEntrySnapshots(database, sessionKey, persisted.snapshots, persisted);
            }
            if (window.changed) {
              const writeWindow = retainWindowOwner ? queries.retainWindow : queries.claimWindow;
              writeWindow(window.row);
            }
            if (conversation) {
              linkSessionConversation({
                database,
                ...(previousEntry?.sessionId ? { previousSessionId: previousEntry.sessionId } : {}),
                sessionId: window.row.session_id,
                conversation,
                updatedAt,
              });
            }
          })
        : undefined;
      if (changed || options.publishConversationBinding) {
        conversationPublication.stageRows(database, {
          nodes: [
            {
              session_key: sessionNode.session_key,
              current_session_id: sessionNode.current_session_id,
              entry_valid: sessionNode.entry_valid,
              updated_at: sessionNode.updated_at,
              entry_session_id: canonicalEntry.sessionId,
            },
          ],
          windows: [
            {
              session_id: window.row.session_id,
              session_key: window.row.session_key,
              primary_conversation_id: window.row.primary_conversation_id,
            },
          ],
        });
      }
      if (nodeChanged) {
        advanceSessionEntryMaintenanceAgeFact(database.db, {
          sessionKey,
          entry: normalizedEntry,
          previousEntry: canonicalPreviousEntry,
        });
      }
      return { writeGeneration, window, changed };
    },
  );
  const changed = written.changed;
  const sideMetadata =
    changed || actor || options.postimages
      ? structuredClone({
          owner: canonicalPreviousEntry?.owner,
          participants: canonicalPreviousEntry?.participants,
          participantCount: canonicalPreviousEntry?.participantCount,
        })
      : {};
  const snapshots = persisted.snapshotsChanged ? persisted.snapshots : undefined;
  let publishedEntry: SessionEntry | undefined;
  if (changed) {
    publishedEntry = publishSessionEntryCacheInvalidation(
      database,
      {
        sessionKey,
        entry: normalizedEntry,
        sharingUnchanged:
          !options.allowStoredAliases &&
          sessionSharingEntriesEqual(canonicalPreviousEntry, {
            ...normalizedEntry,
            owner: canonicalPreviousEntry?.owner,
          }),
        entryJson: persisted.entryJson,
        snapshotEntry: canonicalEntry,
        snapshots,
        sideMetadata,
        previousEntry: canonicalPreviousEntry,
        ...(!options.allowStoredAliases
          ? {
              facts: {
                kind: "entry" as const,
                previousSessionId: canonicalPreviousEntry?.sessionId,
                sessionId: normalizedEntry.sessionId,
                category: normalizedEntry.category?.trim() || null,
                communicationBinding: communicationEntryBinding(normalizedEntry),
                clearMembers:
                  canonicalPreviousEntry !== undefined &&
                  canonicalPreviousEntry.sessionId !== normalizedEntry.sessionId,
                lifecycleChanged:
                  canonicalPreviousEntry?.sessionId !== normalizedEntry.sessionId ||
                  canonicalPreviousEntry?.lifecycleRevision !== normalizedEntry.lifecycleRevision,
              },
            }
          : {}),
      },
      written.writeGeneration,
    );
  }
  const persistedEntry =
    !changed && (actor || options.postimages)
      ? projectSessionEntryCacheUpdate(persisted.entryJson, sideMetadata, canonicalEntry, snapshots)
      : (actor || options.postimages) && publishedEntry;
  const row = persistedEntry
    ? createSessionEntryWriteRow({
        previous: canonicalPreviousRow,
        node: sessionNode,
        snapshots: persisted.snapshots,
        snapshotsChanged: persisted.snapshotsChanged,
        window: written.window.postimage,
      })
    : undefined;
  if (actor && persistedEntry && row) {
    replaceSessionActorStoredEntry(actor, sessionKey, {
      entry: persistedEntry,
      row,
      window: written.window.postimage,
    });
  }
  if (options.postimages && persistedEntry && row && canonicalPreviousSideTables) {
    const stagedTranscript = readStagedSessionTranscriptAuthority(database)
      ?.flatMap((receipt) => Array.from(receipt.facts.values()))
      .find(
        (fact) => fact.kind === "postimage" && fact.value.sessionId === persistedEntry.sessionId,
      );
    const preparedWatermark = canonicalPreviousRow?.transcriptWatermark;
    const transcriptWatermark = !readSessionActivitySummary(persistedEntry)
      ? undefined
      : stagedTranscript?.kind === "postimage"
        ? { generation: stagedTranscript.value.generation, maxSeq: stagedTranscript.value.rawSeq }
        : preparedWatermark?.sessionId === persistedEntry.sessionId
          ? { generation: preparedWatermark.generation, maxSeq: preparedWatermark.maxSeq }
          : readSessionTranscriptWatermarkInDatabase(database, persistedEntry.sessionId);
    options.postimages.set(sessionKey, {
      changed,
      entry: persistedEntry,
      row,
      window: written.window.postimage,
      transcriptWatermark,
      sideTables: {
        ...canonicalPreviousSideTables,
        ...(canonicalPreviousEntry && canonicalPreviousEntry.sessionId !== normalizedEntry.sessionId
          ? { memberIdsJson: "[]" }
          : {}),
      },
    });
  }
  return persistedEntry ? structuredClone(persistedEntry) : normalizedEntry;
}
