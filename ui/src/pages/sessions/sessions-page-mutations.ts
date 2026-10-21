import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewaySessionRow } from "../../api/types.ts";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { requestCloudWorkerStop } from "../../components/cloud-worker-stop.runtime.ts";
import { resolveCloudWorkerStopAction } from "../../components/cloud-worker-stop.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import {
  formatBatchSessionRemovalError,
  withSessionWorkspaceRecovery,
} from "../../components/session-workspace-recovery.runtime.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { SessionMethodAccessRequest } from "../../lib/session-method-access.ts";
import { resolveSessionRenamePatch, resolveSessionRenameValue } from "../../lib/session-rename.ts";
import { fetchPagedSessionRows } from "../../lib/sessions/paged-session-rows.ts";
import type { SessionPatch, SessionPatchResult } from "../../lib/sessions/patch.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import {
  isPinnableUiSessionRow,
  isSubagentSessionKey,
  resolveUiSessionRowAgentId,
} from "../../lib/sessions/session-key.ts";
import { formatPreservedWorktreesNotice } from "../../lib/sessions/worktree-preservation.ts";
import { createSessionsArchive } from "./archive-actions.ts";
import { rememberSessionCustomGroup, sessionCategoryNames } from "./custom-groups.ts";
import { resolveSessionDeleteOutcome } from "./delete-outcome.ts";
import type { createSessionsDialog } from "./page-dialog.ts";
import type { SessionsPageRequestScope } from "./request-scope.ts";
import { settleSelectedSession, type SessionDeleteRow } from "./selection.ts";
import type { createSessionsPageList } from "./sessions-page-list.ts";
import type { SessionsPageState } from "./sessions-page-state.types.ts";

type SessionsPageMutationResult = "completed" | "failed" | "stale";

type SessionsPageMutationsHost = {
  application: ApplicationContext;
  state: Pick<
    SessionsPageState,
    "result" | "error" | "loading" | "selectedSessions" | "expandedSessionKey"
  >;
  list: Pick<
    ReturnType<typeof createSessionsPageList>,
    "deepLinkSessionKey" | "sessionListOptions" | "refreshSessionList" | "applyCurrentSnapshot"
  >;
  inputDialog: ReturnType<typeof createSessionsDialog>;
  mutationSignal: () => AbortSignal;
  captureRequestScope: () => SessionsPageRequestScope | null;
  isRequestScopeCurrent: (scope: SessionsPageRequestScope) => boolean;
  publishRequestError: (scope: SessionsPageRequestScope, error: unknown) => "failed" | "stale";
  requireMutationAccess: (
    scope: SessionsPageRequestScope,
    request: SessionMethodAccessRequest,
  ) => boolean;
  sessionAgentId: (key: string, context?: ApplicationContext) => string | undefined;
  sessionPathAgentId: (key: string, context: ApplicationContext) => string;
};

export function createSessionsPageMutations(host: SessionsPageMutationsHost) {
  const {
    application,
    state,
    list,
    inputDialog,
    captureRequestScope,
    isRequestScopeCurrent,
    publishRequestError,
    requireMutationAccess,
    sessionAgentId,
    sessionPathAgentId,
  } = host;
  const refreshSessionList = list.refreshSessionList;
  let sessionMutationPending = false;
  const archiveActions = createSessionsArchive({
    captureScope: captureRequestScope,
    isCurrent: isRequestScopeCurrent,
    publishError: publishRequestError,
    refresh: refreshSessionList,
    agentId: sessionAgentId,
    patch: patchSession,
  });

  async function deleteSelected() {
    const rows = [...state.selectedSessions.values()];
    if (rows.length === 0 || state.loading || sessionMutationPending) {
      return;
    }
    const scope = captureRequestScope();
    if (!scope) {
      return;
    }
    const message = t(
      rows.length === 1
        ? "sessionsView.deleteSelectedConfirmOne"
        : "sessionsView.deleteSelectedConfirm",
      { count: String(rows.length) },
    );
    if (!(await confirmMutation(message)) || !isRequestScopeCurrent(scope)) {
      return;
    }
    await deleteSessions(rows.filter((row) => state.selectedSessions.get(row.key) === row));
  }

  function confirmMutation(
    message: string,
    options: { confirmLabel?: string; signal?: AbortSignal } = {},
  ) {
    return showConfirmDialog({
      message,
      confirmLabel: t("common.delete"),
      danger: true,
      signal: host.mutationSignal(),
      ...options,
    });
  }

  async function deleteSessions(
    rows: SessionDeleteRow[],
    options: { deleteTranscript?: boolean } = {},
  ) {
    if (rows.length === 0 || state.loading || sessionMutationPending) {
      return;
    }
    const scope = captureRequestScope();
    if (!scope) {
      return;
    }
    const requests = rows.map((row) => ({
      key: row.key,
      agentId: sessionAgentId(row.key, scope.context),
      ...options,
      ...(row.sessionId ? { expectedSessionId: row.sessionId } : {}),
      ...(row.archived === true ? { archivedOnly: true } : {}),
    }));
    for (const params of requests) {
      if (!requireMutationAccess(scope, { method: "sessions.delete", params })) {
        return;
      }
    }
    await runSessionMutation(scope, async () => {
      const request = async () => {
        const result = await scope.sessions.deleteMany(requests);
        if (rows.length === 1 && result.errors.length > 0) {
          throw result.errors[0]!.error;
        }
        return result;
      };
      const row = rows[0]!;
      const result =
        rows.length === 1
          ? await withSessionWorkspaceRecovery({
              action: "delete",
              session: {
                ...row,
                label: row.label || row.displayName || row.key,
                agentId: requests[0]!.agentId,
              },
              scope,
              isCurrent: () => isRequestScopeCurrent(scope),
              request,
            })
          : await request();
      if (!isRequestScopeCurrent(scope) || !result) {
        return undefined;
      }
      if (result.preservedWorktrees.length > 0) {
        window.alert(formatPreservedWorktreesNotice(result.preservedWorktrees));
      }
      if (result.deleted.length > 0) {
        const outcome = resolveSessionDeleteOutcome(scope.context, requests, result.deleted, {
          selectedSessions: state.selectedSessions,
          expandedSessionKey: state.expandedSessionKey,
          deepLinkSessionKey: list.deepLinkSessionKey,
        });
        state.selectedSessions = outcome.selectedSessions;
        state.expandedSessionKey = outcome.expandedSessionKey;
        list.deepLinkSessionKey = outcome.deepLinkSessionKey;
        if (outcome.selection) {
          selectApplicationSession({
            selection: scope.context.agentSelection,
            gateway: scope.gateway,
            ...outcome.selection,
          });
        }
      }
      await refreshSessionList(scope);
      return result.errors.length > 0
        ? result.errors.map(({ error }) => formatBatchSessionRemovalError(error)).join("; ")
        : undefined;
    });
  }

  async function deleteAllArchived() {
    const scope = captureRequestScope();
    if (!scope || state.loading || sessionMutationPending) {
      return;
    }
    // The rendered list is bounded by the page's limit filter; re-enumerate the
    // full archived set so "all archived" means all of them. Any abnormal page
    // (failure, non-advancing offset) aborts: deleting a partial enumeration
    // would silently violate the "all archived" contract.
    let rows: GatewaySessionRow[];
    try {
      // One options snapshot for every page: filter edits made while pages load
      // must not mix populations; a deep link never narrows "all archived".
      const {
        search: _deepLinkSearch,
        agentId: _linkedAgentId,
        ...filters
      } = list.sessionListOptions(scope.context);
      const agentId = scope.context.agentSelection.state.scopeId?.trim();
      const listOptions = { ...filters, ...(agentId ? { agentId } : {}) };
      const listed = await fetchPagedSessionRows({
        list: (offset) => scope.sessions.list({ ...listOptions, limit: 1000, offset }),
        isCurrent: () => isRequestScopeCurrent(scope),
        missingResultError:
          scope.sessions.state.error ?? "archived session enumeration returned no result",
        stalledPaginationError: "archived session enumeration did not advance",
        incompletePaginationError: "archived session enumeration was incomplete",
      });
      if (!listed) {
        return;
      }
      rows = listed;
    } catch (error) {
      publishRequestError(scope, error);
      return;
    }
    const archivedRows = rows.filter((row) => row.archived === true);
    if (archivedRows.length === 0) {
      return;
    }
    if (
      !(await confirmMutation(
        t("sessionsView.deleteAllArchivedConfirm", {
          count: String(archivedRows.length),
        }),
        { signal: scope.signal },
      )) ||
      !isRequestScopeCurrent(scope)
    ) {
      return;
    }
    await deleteSessions(archivedRows, { deleteTranscript: true });
  }

  async function deleteSessionFromMenu(row: GatewaySessionRow) {
    const label = normalizeOptionalString(row.label) ?? row.key;
    const scope = captureRequestScope();
    if (
      !scope ||
      !(await confirmMutation(t("sessionsView.deleteSessionConfirm", { session: label }))) ||
      !isRequestScopeCurrent(scope)
    ) {
      return;
    }
    await deleteSessions([row]);
  }

  async function stopCloudWorker(row: GatewaySessionRow) {
    const label = normalizeOptionalString(row.label) ?? row.key;
    const stopAction = resolveCloudWorkerStopAction(row.placement);
    if (!stopAction || (stopAction.blocksActiveRun && row.hasActiveRun === true)) {
      return;
    }
    const scope = captureRequestScope();
    if (
      !scope ||
      !(await confirmMutation(t("sessionsView.stopCloudWorkerConfirm", { session: label }), {
        confirmLabel: t("sessionsView.stopCloudWorkerConfirmAction"),
      })) ||
      !isRequestScopeCurrent(scope) ||
      !requireMutationAccess(scope, stopAction)
    ) {
      return;
    }
    await runSessionMutation(scope, async () => {
      const agentId = resolveUiSessionRowAgentId(row, sessionPathAgentId(row.key, scope.context));
      await requestCloudWorkerStop(
        scope.client,
        {
          key: row.key,
          ...(agentId ? { agentId } : {}),
        },
        scope.context.placementStartup,
      );
      if (isRequestScopeCurrent(scope)) {
        await refreshSessionList(scope);
      }
    });
  }

  async function runSessionMutation(
    scope: SessionsPageRequestScope,
    mutate: () => Promise<string | void>,
  ) {
    sessionMutationPending = true;
    let mutationError: string | void = undefined;
    try {
      mutationError = await mutate();
    } catch (error) {
      if (isRequestScopeCurrent(scope)) {
        mutationError = formatUiError(error);
      }
    } finally {
      if (isRequestScopeCurrent(scope)) {
        sessionMutationPending = false;
        list.applyCurrentSnapshot();
        if (mutationError) {
          state.error = mutationError;
        }
      }
    }
  }

  function knownCategories(): string[] {
    return sessionCategoryNames(state.result, application.sessions.state.groups ?? []);
  }

  async function rememberCustomGroup(
    name: string,
    scope: SessionsPageRequestScope | null = captureRequestScope(),
  ): Promise<SessionsPageMutationResult> {
    if (!scope) {
      return "stale";
    }
    if (
      !requireMutationAccess(scope, {
        method: "sessions.groups.put",
        requiredScope: "operator.write",
      })
    ) {
      return "failed";
    }
    return rememberSessionCustomGroup({
      name,
      knownCategories: knownCategories(),
      sessions: scope.sessions,
      isCurrent: () => isRequestScopeCurrent(scope),
      onError: (message) => {
        state.error = message;
      },
    });
  }

  function assignCategory(key: string, category: string | null) {
    // Only patch keys that exist in the current result; sessions.patch would
    // otherwise create a store entry for arbitrary dropped text.
    const session = state.result?.sessions.find((row) => row.key === key);
    if (!session) {
      return;
    }
    // Dropping a row onto its own section is a no-op; skip the patch round-trip.
    const current = session.category?.trim() || null;
    const promote = !isSubagentSessionKey(session.key) && !isPinnableUiSessionRow(session);
    if (current === category && !promote) {
      return;
    }
    if (category) {
      void rememberCustomGroup(category);
    }
    void patchSession(
      key,
      { category, ...(promote ? { sidebarRoot: true } : {}) },
      undefined,
      session.sessionId,
    );
  }

  async function requestNewCategory(sessionKey?: string) {
    // Capture before loading the dialog: its key may belong to a replacement
    // by the time the operator submits or the catalog write completes.
    const session = state.result?.sessions.find((row) => row.key === sessionKey);
    if (sessionKey && !session?.sessionId) {
      state.error = t("common.refresh");
      return;
    }
    await inputDialog.open(() => ({
      title: t("sessionsView.newGroupTitle"),
      label: t("sessionsView.newGroupPrompt"),
      submitLabel: t("sessionsView.newGroupCreate"),
      requireValue: true,
      submit: (name) => writeNewCategory(name, session),
    }));
  }

  /**
   * One captured scope covers both writes: the catalog entry lands before the
   * row moves, and a catalog write that outlived its connection must not be
   * followed by an assignment issued on the replacement one.
   */
  async function writeNewCategory(
    name: string,
    session?: GatewaySessionRow,
  ): Promise<string | null> {
    state.error = null;
    const scope = captureRequestScope();
    if (!scope) {
      return t("sessionsView.newGroupFailed");
    }
    const remembered = await rememberCustomGroup(name, scope);
    if (remembered !== "completed") {
      return remembered === "failed"
        ? (state.error ?? t("sessionsView.newGroupFailed"))
        : t("sessionsView.newGroupStale");
    }
    if (!session) {
      return null;
    }
    const assigned = await patchSession(
      session.key,
      {
        category: name,
        ...(!isSubagentSessionKey(session.key) && !isPinnableUiSessionRow(session)
          ? { sidebarRoot: true }
          : {}),
      },
      scope,
      session.sessionId,
    );
    if (assigned === "failed") {
      return state.error ?? t("sessionsView.newGroupFailed");
    }
    return assigned === "stale" ? t("sessionsView.newGroupStale") : null;
  }

  async function renameSession(row: GatewaySessionRow) {
    const scope = captureRequestScope();
    if (!scope) {
      state.error = t("sessionsView.actionRequiresConnection");
      return;
    }
    const initialValue = resolveSessionRenameValue(row);
    const value = await inputDialog.open(() => ({
      signal: scope.signal,
      title: t("sessionsView.renameSessionPrompt"),
      defaultValue: initialValue,
    }));
    if (value === null || !isRequestScopeCurrent(scope)) {
      return;
    }
    const patch = resolveSessionRenamePatch(value, initialValue, row.label);
    if (patch) {
      await patchSession(row.key, patch, scope, row.sessionId, { sessionScope: true });
    }
  }

  async function patchSession(
    key: string,
    patch: SessionPatch,
    scope: SessionsPageRequestScope | null = captureRequestScope(),
    expectedSessionId?: string,
    options: { onConfirmed?: (result: SessionPatchResult) => void; sessionScope?: boolean } = {},
  ): Promise<SessionsPageMutationResult> {
    if (!scope) {
      // Nothing was attempted (e.g. rename dialog submitted after the gateway
      // dropped); say so instead of silently swallowing the edit.
      state.error = t("sessionsView.actionRequiresConnection");
      return "failed";
    }
    if (typeof patch.archived === "boolean" && !expectedSessionId?.trim()) {
      state.error = "Session lifecycle action requires a durable session identity.";
      return "failed";
    }
    const agentId = sessionAgentId(key, scope.context);
    const row = state.result?.sessions.find((entry) => entry.key === key);
    if (
      !requireMutationAccess(scope, {
        method: "sessions.patch",
        sessionScope: options.sessionScope,
        session: row,
        params: {
          key,
          ...patch,
          ...(agentId ? { agentId } : {}),
        },
      })
    ) {
      return "failed";
    }
    try {
      const request = () =>
        scope.sessions.patch(key, patch, {
          agentId,
          ...(expectedSessionId ? { expectedSessionId } : {}),
        });
      const patched =
        patch.archived === true
          ? await withSessionWorkspaceRecovery({
              action: "archive",
              session: {
                key,
                sessionId: expectedSessionId,
                label: row?.label || row?.displayName || key,
                agentId,
              },
              scope,
              isCurrent: () => isRequestScopeCurrent(scope),
              request,
            })
          : await request();
      if (patched && !("queued" in patched)) {
        options.onConfirmed?.(patched);
      }
      if (!isRequestScopeCurrent(scope)) {
        return "stale";
      }
      if (!patched || "queued" in patched) {
        state.error = patched ? null : scope.sessions.state.error;
        return patched ? "completed" : "failed";
      }
      await refreshSessionList(scope);
      if (!isRequestScopeCurrent(scope)) {
        return "stale";
      }
      const selected = state.selectedSessions;
      state.selectedSessions = settleSelectedSession(selected, key, patched.entry.sessionId);
      return "completed";
    } catch (error) {
      return publishRequestError(scope, error);
    }
  }

  async function forkSession(key: string, fromLastCompleted = false) {
    const scope = captureRequestScope();
    if (!scope) {
      return;
    }
    const agentId = sessionAgentId(key, scope.context);
    const createParams = {
      parentSessionKey: key,
      fork: true,
      ...(fromLastCompleted ? { forkFrom: "last-completed" as const } : {}),
      ...(agentId ? { agentId } : {}),
    };
    if (!requireMutationAccess(scope, { method: "sessions.create", params: createParams })) {
      return;
    }
    try {
      const forkedKey = await scope.sessions.create(createParams, { signal: scope.signal });
      if (!isRequestScopeCurrent(scope)) {
        return;
      }
      if (forkedKey) {
        scope.context.navigate("chat", {
          ...sessionNavigationTarget({
            context: scope.context,
            face: "chat",
            sessionKey: forkedKey,
            agentId: agentId ?? sessionPathAgentId(forkedKey, scope.context),
          }).options,
          hash: "",
        });
      } else if (scope.sessions.state.error) {
        state.error = scope.sessions.state.error;
      }
    } catch (error) {
      publishRequestError(scope, error);
    }
  }

  return {
    deleteSelected,
    deleteAllArchived,
    deleteSessionFromMenu,
    stopCloudWorker,
    rememberCustomGroup,
    requestNewCategory,
    patchSession,
    forkSession,
    archive: archiveActions.archive,
    knownCategories,
    assignCategory,
    renameSession,
    runSessionMutation,
    resetPending() {
      sessionMutationPending = false;
    },
  };
}
