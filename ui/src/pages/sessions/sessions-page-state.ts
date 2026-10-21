import { onSettled } from "solid-js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createSessionDetails } from "../../components/session-details.ts";
import { registerSessionOrganizationEnglish } from "../../i18n/locales/en-session-organization.ts";
import { watchAgentScope } from "../../lib/agents/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { observeState } from "../../lib/reactive/observe-state.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccessRequest,
} from "../../lib/session-method-access.ts";
import {
  SESSIONS_PAGE_DEFAULT_LIMIT,
  scopedAgentParamsForSession,
  type SessionArchivedFilter,
} from "../../lib/sessions/index.ts";
import type { SessionPatch } from "../../lib/sessions/patch.ts";
import {
  resolveSessionPreferredFaceForKey,
  resolveSessionNavigationAgentId,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { resolveUiConfiguredMainKey } from "../../lib/sessions/session-key.ts";
import { sessionAgentIdentityById } from "./agent-scope.ts";
import { createSessionsDialog } from "./page-dialog.ts";
import { loadStoredGroupBy, saveStoredGroupBy } from "./page-state.ts";
import type { SessionsPageRequestScope } from "./request-scope.ts";
import type { SessionsRouteData } from "./route.ts";
import { updateSelectedSessions, type SessionDeleteRow } from "./selection.ts";
import { createSessionsPageList } from "./sessions-page-list.ts";
import { createSessionsPageMenu } from "./sessions-page-menu.ts";
import { createSessionsPageMutations } from "./sessions-page-mutations.ts";
import type { SessionsPageState } from "./sessions-page-state.types.ts";

registerSessionOrganizationEnglish();

export type SessionsPageOwner = ReturnType<typeof createSessionsPage>;

export function createSessionsPage(
  application: ApplicationContext,
  initialRouteData?: SessionsRouteData,
) {
  let routeData = initialRouteData;
  let active = true;
  function setRouteData(next?: SessionsRouteData) {
    if (routeData === next) {
      return;
    }
    routeData = next;
    applyRouteData();
    synchronize();
    publish();
  }

  // Query and mutation decisions read these facts synchronously; the projection only observes.
  const observation = observeState<SessionsPageState>({
    sortColumn: "updated",
    sortDir: "desc",
    groupBy: loadStoredGroupBy(),
    page: 0,
    pageSize: 25,
    result: null,
    loading: false,
    refreshing: false,
    error: null,
    activeMinutes: "",
    limit: String(SESSIONS_PAGE_DEFAULT_LIMIT),
    includeGlobal: true,
    includeUnknown: false,
    statusFilter: "active",
    searchQuery: "",
    transcriptSearchQuery: "",
    selectedSessions: new Map<string, SessionDeleteRow>(),
    sessionMenu: null,
    sessionMenuWork: null,
    expandedSessionKey: null,
    transcriptSearch: { status: "idle" },
  });
  const state = observation.state;
  const publish = observation.invalidate;
  // Async completions belong to one context/capability/connection/scope epoch. Bump
  // before releasing locks so stale finally blocks cannot clear newer work.
  let pageEpoch = 0;
  let pluginActionLifetime = new AbortController();
  const details = createSessionDetails({
    captureScope: captureRequestScope,
    isCurrent: isRequestScopeCurrent,
    row: () => state.result?.sessions.find((row) => row.key === state.expandedSessionKey),
    agentId: (row, scope) => row.agentId ?? sessionPathAgentId(row.key, scope.context),
  });
  const inputDialog = createSessionsDialog((message) => {
    state.error = message;
  });
  const observeAgentScope = watchAgentScope(() => {
    // Keep same-connection list serialization.
    retirePageOperations();
    list.resetTranscriptSearchState(state.transcriptSearchQuery);
    if (!list.deepLinkSessionKey) {
      state.page = 0;
      state.selectedSessions = new Map();
      list.clearSearchTimer();
      list.bindSessionList();
    }
    synchronize();
    publish();
  });

  const gatewayLifecycle = new GatewayPageBinding(
    () => {
      if (active) {
        synchronize();
        publish();
      }
    },
    {
      getGateway: () => application.gateway,
      onIdentityChange: () => {
        list.resetProviderState();
      },
      invalidateRequests: () => {
        if (active) {
          invalidatePageWork();
        }
      },
    },
  );

  const list = createSessionsPageList({
    application,
    state,
    isActive: () => active,
    captureRequestScope,
    isRequestScopeCurrent,
    synchronize,
    synchronizeDetails: details.synchronize,
    sessionAgentId,
  });
  const mutations = createSessionsPageMutations({
    application,
    state,
    list,
    inputDialog,
    mutationSignal: () => pluginActionLifetime.signal,
    captureRequestScope,
    isRequestScopeCurrent,
    publishRequestError,
    requireMutationAccess,
    sessionAgentId,
    sessionPathAgentId,
  });
  const menu = createSessionsPageMenu({
    application,
    state,
    mutations,
    isActive: () => active,
    mutationSignal: () => pluginActionLifetime.signal,
    captureRequestScope,
    isRequestScopeCurrent,
    publishRequestError,
    requireMutationAccess,
    refreshSessionList: list.refreshSessionList,
    sessionAgentId,
    sessionPathAgentId,
  });

  function synchronize() {
    list.bindSessionList();
    details.synchronize();
  }

  function retirePageOperations() {
    details.reset();
    pluginActionLifetime.abort();
    pluginActionLifetime = new AbortController();
    pageEpoch += 1;
    mutations.resetPending();
    menu.closeSessionMenu();
  }

  function invalidatePageWork() {
    retirePageOperations();
    list.invalidate();
  }

  function captureRequestScope(): SessionsPageRequestScope | null {
    if (!active) {
      return null;
    }
    const gateway = application.gateway;
    const client = gatewayLifecycle.gateway === gateway ? gatewayLifecycle.client : null;
    if (!gatewayLifecycle.connected || !client) {
      return null;
    }
    return {
      epoch: pageEpoch,
      signal: pluginActionLifetime.signal,
      context: application,
      gateway,
      sessions: application.sessions,
      client,
    };
  }

  function isRequestScopeCurrent(scope: SessionsPageRequestScope): boolean {
    const gateway = application.gateway;
    return (
      active &&
      pageEpoch === scope.epoch &&
      application === scope.context &&
      gateway === scope.gateway &&
      application.sessions === scope.sessions &&
      gateway.snapshot.phase === "connected" &&
      gateway.snapshot.client === scope.client
    );
  }

  function publishRequestError(
    scope: SessionsPageRequestScope,
    error: unknown,
  ): "failed" | "stale" {
    if (!isRequestScopeCurrent(scope)) {
      return "stale";
    }
    state.error = formatUiError(error);
    return "failed";
  }

  function mutationDisabledReason(request: SessionMethodAccessRequest): string | undefined {
    const access = readSessionMethodAccess(application.gateway.snapshot, request);
    return access.allowed ? undefined : access.reason;
  }

  function requireMutationAccess(
    scope: SessionsPageRequestScope,
    request: SessionMethodAccessRequest,
  ): boolean {
    const access = readSessionMethodAccess(scope.gateway.snapshot, request);
    if (access.allowed) {
      return true;
    }
    state.error = access.reason;
    return false;
  }

  function selectedDeleteDisabledReason(): string | undefined {
    for (const row of state.selectedSessions.values()) {
      const reason = mutationDisabledReason({
        method: "sessions.delete",
        params: {
          key: row.key,
          ...(row.archived === true ? { archivedOnly: true } : {}),
        },
      });
      if (reason) {
        return reason;
      }
    }
    return undefined;
  }

  function applyRouteData() {
    const data = routeData;
    if (!data) {
      return;
    }
    state.statusFilter = data.statusFilter;
    state.activeMinutes = "";
    state.limit = String(SESSIONS_PAGE_DEFAULT_LIMIT);
    state.includeGlobal = true;
    state.includeUnknown = Boolean(data.expandedSessionKey);
    if (data.expandedSessionKey) {
      state.searchQuery = "";
      state.page = 0;
      state.selectedSessions = new Map();
    }
    state.expandedSessionKey = data.expandedSessionKey;
    // Only route-driven expansion narrows the list query; interactive drawer
    // opens must keep loading the full roster (see sessionListOptions).
    list.deepLinkSessionKey = data.expandedSessionKey;
  }

  function sessionAgentId(key: string, context = application): string | undefined {
    const { agentId } = scopedAgentParamsForSession(
      {
        assistantAgentId: context.agentSelection.state.selectedId,
        hello: context.gateway.snapshot.hello,
      },
      key,
    );
    return agentId;
  }

  function sessionPathAgentId(key: string, context: ApplicationContext): string {
    return sessionAgentId(key, context) ?? resolveSessionNavigationAgentId(context);
  }

  function updateSelection(keys: string[], mode: "select" | "toggle" | "deselect") {
    state.selectedSessions = updateSelectedSessions(
      state.selectedSessions,
      state.result?.sessions ?? [],
      keys,
      mode,
    );
  }

  function viewProps() {
    const { selectedSessions, sessionMenuWork: _sessionMenuWork, ...viewState } = state;
    const personGroupingAvailable = (state.result?.owners?.length ?? 0) > 1;
    return {
      ...viewState,
      loading: state.loading || details.loading(),
      refreshDisabled: application.gateway.snapshot.phase !== "connected",
      error: details.error() ?? state.error,
      basePath: application.basePath,
      agentId: resolveSessionNavigationAgentId(application),
      allAgentsScope: application.agentSelection.state.scopeId === null,
      mainKey: resolveUiConfiguredMainKey({
        agentsList: application.agents.state.agentsList,
        hello: application.gateway.snapshot.hello,
      }),
      transcriptSearchAvailable: application.gateway.snapshot.phase === "connected",
      agentIdentityById: sessionAgentIdentityById(
        state.result,
        (agentId) => application.agentIdentity.get(agentId) ?? undefined,
      ),
      personGroupingAvailable,
      // Keep the stored Person preference while the owner roster is unavailable.
      groupBy:
        personGroupingAvailable || state.groupBy !== "person" ? state.groupBy : ("none" as const),
      knownCategories: mutations.knownCategories(),
      selectedKeys: new Set(selectedSessions.keys()),
      labelDisabledReason: (row: GatewaySessionRow) =>
        mutationDisabledReason({
          method: "sessions.patch",
          params: { key: row.key, label: null },
          sessionScope: true,
          session: row,
        }),
      patchAdminDisabledReason: mutationDisabledReason({
        method: "sessions.patch",
        params: { key: "", thinkingLevel: null },
      }),
      groupWriteDisabledReason: mutationDisabledReason({
        method: "sessions.groups.put",
        requiredScope: "operator.write",
      }),
      deleteArchivedDisabledReason: mutationDisabledReason({
        method: "sessions.delete",
        params: { key: "", archivedOnly: true, deleteTranscript: true },
      }),
      deleteSelectedDisabledReason: selectedDeleteDisabledReason(),
      onFiltersChange: (next: Parameters<typeof list.updateFilters>[0]) => list.updateFilters(next),
      onClearFilters: () => {
        state.searchQuery = "";
        list.updateFilters({
          activeMinutes: "",
          limit: String(SESSIONS_PAGE_DEFAULT_LIMIT),
          includeGlobal: true,
          includeUnknown: false,
        });
      },
      onSearchChange: (query: string) => list.updateSearchQuery(query),
      onTranscriptSearchChange: actions.updateTranscriptSearchQuery,
      onTranscriptSearch: (): void => void actions.runTranscriptSearch(),
      onClearTranscriptSearch: () => list.resetTranscriptSearchState(""),
      onSortChange: (
        column: SessionsPageState["sortColumn"],
        direction: SessionsPageState["sortDir"],
      ) => {
        state.sortColumn = column;
        state.sortDir = direction;
        state.page = 0;
      },
      onGroupByChange: (mode: SessionsPageState["groupBy"]) => {
        state.groupBy = mode;
        state.page = 0;
        saveStoredGroupBy(mode);
      },
      onAssignCategory: mutations.assignCategory,
      onRequestNewCategory: (sessionKey?: string): void =>
        void actions.requestNewCategory(sessionKey),
      onLoadMore: () => list.loadMore(),
      onPageChange: (page: number) => {
        state.page = page;
      },
      onPageSizeChange: (pageSize: number) => {
        state.pageSize = pageSize;
        state.page = 0;
      },
      onRefresh: (): void => void list.refreshSessionList(),
      onStatusFilterChange: (statusFilter: SessionArchivedFilter) =>
        list.updateStatusFilter(statusFilter),
      onDeleteAllArchived: (): void => void actions.deleteAllArchived(),
      onPatch: (key: string, patch: SessionPatch, options?: { sessionScope?: boolean }): void =>
        void actions.patchSession(key, patch, undefined, undefined, options),
      onToggleSelect: (key: string) => updateSelection([key], "toggle"),
      onSelectPage: (keys: string[]) => updateSelection(keys, "select"),
      onDeselectPage: (keys: string[]) => updateSelection(keys, "deselect"),
      onDeselectAll: () => {
        state.selectedSessions = new Map();
      },
      onDeleteSelected: (): void => void actions.deleteSelected(),
      onNavigateToChat: (sessionKey: string) => {
        const face = resolveSessionPreferredFaceForKey(application, sessionKey);
        const target = sessionNavigationTarget({
          context: application,
          face,
          sessionKey,
          agentId: sessionPathAgentId(sessionKey, application),
          preferenceDerivedFace: true,
        });
        application.navigate(face, target.options);
      },
      onOpenSessionMenu: actions.openSessionMenu,
      onToggleDetails: (key: string) => {
        state.expandedSessionKey = state.expandedSessionKey === key ? null : key;
        details.synchronize();
        if (list.deepLinkSessionKey !== null) {
          list.deepLinkSessionKey = null;
          void list.refreshSessionList();
        }
      },
    };
  }

  const actions = {
    deleteSelected: mutations.deleteSelected,
    deleteAllArchived: mutations.deleteAllArchived,
    deleteSessionFromMenu: mutations.deleteSessionFromMenu,
    stopCloudWorker: mutations.stopCloudWorker,
    rememberCustomGroup: mutations.rememberCustomGroup,
    requestNewCategory: mutations.requestNewCategory,
    patchSession: mutations.patchSession,
    forkSession: mutations.forkSession,
    runPluginAction: menu.runPluginAction,
    updateTranscriptSearchQuery: list.updateTranscriptSearchQuery,
    runTranscriptSearch: list.runTranscriptSearch,
    openSessionMenu: menu.openSessionMenu,
    archive: mutations.archive,
  };

  const presentationSources = [
    application.agentIdentity,
    application.navigation,
    application.runtimeConfig,
    application.plugins,
  ].map((owner) => projectOwner(owner, (source) => source));
  const revision = () =>
    presentationSources.reduce((sum, source) => sum + source.revision(), observation.revision());
  onSettled(() => {
    const stopScope = observeAgentScope(application.agentSelection);
    applyRouteData();
    gatewayLifecycle.connect();
    return () => {
      active = false;
      observation.dispose();
      stopScope();
      list.unsubscribe();
      pluginActionLifetime.abort();
      list.abortTranscriptSearch();
      list.clearSearchTimer();
      inputDialog.abort();
      menu.unwatch();
      gatewayLifecycle.dispose();
    };
  });
  return {
    actions,
    setRouteData,
    revision,
    menu: () => {
      revision();
      return menu.sessionMenuProps();
    },
    view: () => {
      revision();
      return viewProps();
    },
  };
}
