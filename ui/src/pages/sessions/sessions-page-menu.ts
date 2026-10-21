import type { GatewaySessionRow } from "../../api/types.ts";
import { togglePinnedSession } from "../../app/bootstrap-navigation-preferences.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasSessionArchiveDescendants } from "../../components/session-menu-descendants.ts";
import { fetchSessionMenuWork } from "../../components/session-menu-work.ts";
import "../../components/session-menu-solid.tsx";
import { moveSessionFromMenu } from "../../components/session-placement-action.ts";
import { t } from "../../i18n/index.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import type { SessionMethodAccessRequest } from "../../lib/session-method-access.ts";
import {
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  sessionPullRequestsForGateway,
} from "../../lib/session-pull-requests.ts";
import { scopedSessionArtifactKey } from "../../lib/sessions/session-key.ts";
import { requestSessionInvolvement } from "../../lib/sessions/session-requests.ts";
import { runControlUiPluginAction } from "../../plugins/control-ui-actions.ts";
import type { SessionsPageRequestScope } from "./request-scope.ts";
import {
  handleSessionManagementNavigationAction,
  type SessionsPageMenuProps,
} from "./session-menu.tsx";
import type { createSessionsPageMutations } from "./sessions-page-mutations.ts";
import type { SessionsPageState } from "./sessions-page-state.types.ts";

type SessionsPageMenuHost = {
  application: ApplicationContext;
  state: Pick<
    SessionsPageState,
    "result" | "error" | "loading" | "sessionMenu" | "sessionMenuWork"
  >;
  mutations: Pick<
    ReturnType<typeof createSessionsPageMutations>,
    | "patchSession"
    | "forkSession"
    | "requestNewCategory"
    | "archive"
    | "stopCloudWorker"
    | "deleteSessionFromMenu"
    | "knownCategories"
    | "assignCategory"
    | "renameSession"
    | "runSessionMutation"
  >;
  isActive: () => boolean;
  mutationSignal: () => AbortSignal;
  captureRequestScope: () => SessionsPageRequestScope | null;
  isRequestScopeCurrent: (scope: SessionsPageRequestScope) => boolean;
  publishRequestError: (scope: SessionsPageRequestScope, error: unknown) => "failed" | "stale";
  requireMutationAccess: (
    scope: SessionsPageRequestScope,
    request: SessionMethodAccessRequest,
  ) => boolean;
  refreshSessionList: (scope: SessionsPageRequestScope) => Promise<void>;
  sessionAgentId: (key: string, context?: ApplicationContext) => string | undefined;
  sessionPathAgentId: (key: string, context: ApplicationContext) => string;
};

export function createSessionsPageMenu(host: SessionsPageMenuHost) {
  const {
    application,
    state,
    mutations,
    captureRequestScope,
    isRequestScopeCurrent,
    publishRequestError,
    requireMutationAccess,
    refreshSessionList,
    sessionAgentId,
    sessionPathAgentId,
  } = host;
  const { knownCategories, assignCategory, renameSession, runSessionMutation } = mutations;
  const menuOwner = {};
  let sessionMenuTrigger: HTMLElement | null = null;
  function openSessionMenu(
    row: GatewaySessionRow,
    position: { x: number; y: number },
    trigger: HTMLElement | null,
  ) {
    if (
      state.sessionMenu?.key === row.key &&
      state.sessionMenu.sessionId === row.sessionId &&
      trigger
    ) {
      closeSessionMenu();
      return;
    }
    state.sessionMenu = { key: row.key, sessionId: row.sessionId, ...position };
    sessionMenuTrigger = trigger;
    loadSessionMenuWork(row);
  }

  function closeSessionMenu() {
    sessionPullRequestsForGateway(application.gateway).unwatch(menuOwner);
    state.sessionMenu = null;
    sessionMenuTrigger = null;
    state.sessionMenuWork = null;
  }

  function loadSessionMenuWork(row: GatewaySessionRow) {
    // Every opening has its own identity, including reopening the same row.
    const menu = state.sessionMenu;
    if (!row.worktree) {
      state.sessionMenuWork = null;
      return;
    }
    state.sessionMenuWork = { loading: true, pullRequestUrl: null, worktreePath: null };
    const scope = captureRequestScope();
    if (!scope) {
      state.sessionMenuWork = { loading: false, pullRequestUrl: null, worktreePath: null };
      return;
    }
    const store = sessionPullRequestsForGateway(scope.context.gateway);
    const pullRequestKey = scopedSessionArtifactKey(
      row.key,
      sessionAgentId(row.key, scope.context),
    );
    void fetchSessionMenuWork({
      client: scope.client,
      loadPullRequests: canCallGatewayMethod(
        scope.context.gateway.snapshot,
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        "operator.read",
      )
        ? () => store.load(menuOwner, pullRequestKey)
        : undefined,
      worktreeId: row.worktree.id,
      execNode: row.execNode,
    }).then((work) => {
      if (state.sessionMenu === menu) {
        state.sessionMenuWork = { loading: false, ...work };
      }
    });
  }

  function sessionMenuProps(): SessionsPageMenuProps | null {
    const menu = state.sessionMenu;
    const row = menu
      ? state.result?.sessions.find(
          (session) => session.key === menu.key && session.sessionId === menu.sessionId,
        )
      : null;
    if (!menu || !row) {
      return null;
    }
    return {
      context: application,
      row,
      menu,
      trigger: sessionMenuTrigger,
      disabled: state.loading,
      groups: knownCategories(),
      work: state.sessionMenuWork,
      onClose: () => closeSessionMenu(),
      onAction: (requestedAction) => {
        const action = handleSessionManagementNavigationAction(requestedAction, {
          context: application,
          row,
          isCurrent: () => host.isActive(),
        });
        if (!action) {
          return;
        }
        switch (action.kind) {
          case "toggle-pin":
            togglePinnedSession(application.navigation, row.key);
            break;
          case "toggle-involving-me": {
            const scope = captureRequestScope();
            if (!scope || !row.sessionId) {
              state.error = t("sessionsView.actionRequiresConnection");
              break;
            }
            void requestSessionInvolvement(scope.client, {
              key: row.key,
              expectedSessionId: row.sessionId,
              agentId: row.agentId ?? sessionAgentId(row.key, scope.context),
              hidden: !row.hiddenFromInvolvingMe,
            })
              .then(async () => {
                if (isRequestScopeCurrent(scope)) {
                  await refreshSessionList(scope);
                }
              })
              .catch((error: unknown) => publishRequestError(scope, error));
            break;
          }
          case "toggle-unread":
            void mutations.patchSession(
              row.key,
              { unread: row.unread !== true },
              undefined,
              row.sessionId,
              {
                sessionScope: true,
              },
            );
            break;
          case "rename":
            void renameSession(row);
            break;
          case "set-color":
            void mutations.patchSession(row.key, { color: action.color });
            break;
          case "set-icon":
            void mutations.patchSession(row.key, { icon: action.icon });
            break;
          case "set-communication":
            void mutations.patchSession(
              row.key,
              { communication: action.communication },
              undefined,
              row.sessionId,
            );
            break;
          case "reset-appearance":
            void mutations.patchSession(row.key, { icon: null, color: null });
            break;
          case "move-session": {
            const scope = captureRequestScope();
            if (!scope) {
              state.error = t("sessionsView.actionRequiresConnection");
              break;
            }
            void moveSessionFromMenu({
              context: scope.context,
              row,
              fallbackAgentId: sessionPathAgentId(row.key, scope.context),
              isCurrent: () => isRequestScopeCurrent(scope),
              currentRow: () =>
                state.result?.sessions.find(
                  (candidate) => candidate.key === row.key && candidate.sessionId === row.sessionId,
                ),
              publishError: (error) => {
                publishRequestError(scope, error);
              },
            });
            break;
          }
          case "fork":
            void mutations.forkSession(row.key, row.hasActiveRun === true);
            break;
          case "plugin":
            void runPluginAction(action.id, menu);
            break;
          case "move-to-top-level":
            void mutations.patchSession(row.key, { sidebarRoot: true }, undefined, row.sessionId, {
              sessionScope: true,
            });
            break;
          case "move-to-group":
            assignCategory(row.key, action.category);
            break;
          case "new-group":
            void mutations.requestNewCategory(row.key);
            break;
          case "toggle-archived":
            if (row.archived === true) {
              void mutations.patchSession(row.key, { archived: false }, undefined, row.sessionId, {
                sessionScope: true,
              });
            } else {
              const rows = state.result?.sessions ?? [];
              void mutations.archive(row, hasSessionArchiveDescendants(row, rows));
            }
            break;
          case "assign-owner": {
            const scope = captureRequestScope();
            if (!scope) {
              state.error = t("sessionsView.actionRequiresConnection");
              break;
            }
            if (
              !requireMutationAccess(scope, {
                method: "sessions.assignOwner",
                params: { key: row.key, owner: action.owner },
                requiredScope: "operator.write",
              })
            ) {
              break;
            }
            void runSessionMutation(scope, async () => {
              const assigned = await scope.sessions.assignOwner(row.key, action.owner);
              return assigned || !isRequestScopeCurrent(scope)
                ? undefined
                : (scope.sessions.state.error ?? undefined);
            });
            break;
          }
          case "stop-cloud-worker":
            void mutations.stopCloudWorker(row);
            break;
          case "delete":
            void mutations.deleteSessionFromMenu(row);
            break;
        }
      },
    };
  }

  async function runPluginAction(id: string, target: Pick<GatewaySessionRow, "key" | "sessionId">) {
    const scope = captureRequestScope();
    if (!scope) {
      return;
    }
    try {
      await runControlUiPluginAction({
        runtime: scope.context.plugins,
        id,
        placement: "session",
        sessionKey: target.key,
        session: state.result?.sessions.find(
          (row) => row.key === target.key && row.sessionId === target.sessionId,
        ),
        signal: host.mutationSignal(),
      });
    } catch (error) {
      publishRequestError(scope, error);
    }
  }

  return {
    openSessionMenu,
    closeSessionMenu,
    sessionMenuProps,
    runPluginAction,
    unwatch() {
      sessionPullRequestsForGateway(application.gateway).unwatch(menuOwner);
    },
  };
}
