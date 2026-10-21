import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  SESSIONS_PAGE_DEFAULT_LIMIT,
  filterSessionRows,
  type SessionArchivedFilter,
  type SessionListSnapshot,
} from "../../lib/sessions/index.ts";
import { searchVisibleSessionTranscripts } from "../../lib/sessions/transcript-search.ts";
import { ensureSessionAgentIdentities } from "./agent-scope.ts";
import { buildSessionsListQuery } from "./list-query.ts";
import type { SessionsPageRequestScope } from "./request-scope.ts";
import { reconcileSelectedSessions } from "./selection.ts";
import type { SessionsAdvancedFiltersProps } from "./sessions-filters.tsx";
import type { SessionsPageState } from "./sessions-page-state.types.ts";

const SESSION_SEARCH_DEBOUNCE_MS = 200;

type SessionsPageListBinding = {
  sessions: ApplicationContext["sessions"];
  query: ReturnType<typeof buildSessionsListQuery>;
  key: string;
  transcriptKey: string;
};

type SessionsPageListHost = {
  application: ApplicationContext;
  state: Pick<
    SessionsPageState,
    | "result"
    | "error"
    | "loading"
    | "refreshing"
    | "selectedSessions"
    | "expandedSessionKey"
    | "page"
    | "activeMinutes"
    | "limit"
    | "includeGlobal"
    | "includeUnknown"
    | "statusFilter"
    | "searchQuery"
    | "transcriptSearchQuery"
    | "transcriptSearch"
  >;
  isActive: () => boolean;
  captureRequestScope: () => SessionsPageRequestScope | null;
  isRequestScopeCurrent: (scope: SessionsPageRequestScope) => boolean;
  synchronize: () => void;
  synchronizeDetails: () => void;
  sessionAgentId: (key: string) => string | undefined;
};

export function createSessionsPageList(host: SessionsPageListHost) {
  const {
    application,
    state,
    captureRequestScope,
    isRequestScopeCurrent,
    synchronize,
    sessionAgentId,
  } = host;
  // Route deep-link target (?session=...); unlike expandedSessionKey it also
  // narrows sessionListOptions so the linked session is guaranteed to load.
  let deepLinkSessionKey: string | null = null;
  let listBinding: SessionsPageListBinding | undefined;
  let unsubscribeList: (() => void) | undefined;
  let listRequest: Promise<void> | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let appliedListResult: SessionsListResult | null | undefined;
  let transcriptSearchAbort: AbortController | undefined;
  async function searchTranscripts(query: string) {
    transcriptSearchAbort?.abort();
    const lifetime = new AbortController();
    transcriptSearchAbort = lifetime;
    const scope = captureRequestScope();
    if (!scope) {
      state.transcriptSearch = { status: "idle" };
      return;
    }
    state.transcriptSearch = { status: "loading" };
    try {
      const {
        sessions,
        results,
        indexing = false,
        truncated = false,
        archivedTranscriptsExcluded = 0,
      } = await searchVisibleSessionTranscripts({
        client: scope.client,
        query,
        listOptions: sessionListOptions(scope.context, ""),
        isCurrent: () => !lifetime.signal.aborted && isRequestScopeCurrent(scope),
      });
      if (!lifetime.signal.aborted && isRequestScopeCurrent(scope)) {
        state.transcriptSearch = {
          status: "results",
          sessions,
          results,
          indexing,
          truncated,
          archivedTranscriptsExcluded,
        };
      }
    } catch (error) {
      if (!lifetime.signal.aborted && isRequestScopeCurrent(scope)) {
        state.transcriptSearch = { status: "error", message: formatUiError(error) };
      }
    }
  }

  function resetProviderState() {
    const retiredResult = listBinding?.sessions.listSnapshot(listBinding.query).result;
    state.result = null;
    state.error = null;
    state.loading = false;
    state.refreshing = false;
    resetTranscriptSearchState("");
    state.selectedSessions = new Map();
    state.expandedSessionKey = null;
    deepLinkSessionKey = null;
    appliedListResult = retiredResult;
  }

  function sessionListOptions(context: ApplicationContext, search = state.searchQuery) {
    return buildSessionsListQuery(context, {
      activeMinutes: parseStrictPositiveInteger(state.activeMinutes),
      // The Limit box is an explicit page size, so an unparseable entry falls
      // back to the page default rather than to the shared roster page size.
      limit: parseStrictPositiveInteger(state.limit) ?? SESSIONS_PAGE_DEFAULT_LIMIT,
      includeGlobal: state.includeGlobal,
      includeUnknown: state.includeUnknown,
      statusFilter: state.statusFilter,
      deepLinkSessionKey,
      search,
    });
  }

  function bindSessionList(refreshMissing = true): SessionsPageListBinding | undefined {
    if (!host.isActive()) {
      return undefined;
    }
    const sessions = application.sessions;
    const query = sessionListOptions(application);
    const key = JSON.stringify(query);
    const current = listBinding;
    const transcriptKey = JSON.stringify(sessionListOptions(application, ""));
    if (current?.sessions !== sessions || current.key !== key) {
      // An event refresh can already own the old query's request.
      if (current?.sessions === sessions && sessions.listSnapshot(current.query).loading) {
        void loadSessionList(current);
      }
      unsubscribeList?.();
      unsubscribeList = undefined;
      if (current?.sessions !== sessions || current.transcriptKey !== transcriptKey) {
        resetTranscriptSearchState(state.transcriptSearchQuery);
      }
      // Retired rows cannot be selected under replacement text, even during debounce.
      state.result = null;
      host.synchronizeDetails();
      state.error = null;
      state.selectedSessions = new Map();
      state.page = 0;
      listBinding = { sessions, query, key, transcriptKey };
      appliedListResult = undefined;
    }
    const binding = listBinding!;
    if (unsubscribeList) {
      return binding;
    }
    state.loading = application.gateway.snapshot.phase === "connected";
    if (!captureRequestScope() || searchTimer !== undefined || listRequest) {
      return binding;
    }
    const apply = (snapshot: SessionListSnapshot) => {
      applyListSnapshot(binding, snapshot);
    };
    unsubscribeList = sessions.subscribeList(query, apply);
    const snapshot = sessions.listSnapshot(query);
    apply(snapshot);
    if (refreshMissing && (!snapshot.result || snapshot.loading)) {
      void loadSessionList(binding);
    }
    return binding;
  }

  function applyListSnapshot(binding: SessionsPageListBinding, snapshot: SessionListSnapshot) {
    if (listBinding !== binding || application.sessions !== binding.sessions) {
      return;
    }
    state.loading = snapshot.loading;
    state.error = snapshot.error;
    const result = snapshot.result;
    if (!result) {
      return;
    }
    if (result !== appliedListResult) {
      appliedListResult = result;
      state.result = filterSessionRows(result, { archivedFilter: state.statusFilter });
      ensureSessionAgentIdentities(application.agentIdentity, state.result);
    }
    if (!snapshot.loading && !snapshot.error && state.result && state.selectedSessions.size > 0) {
      state.selectedSessions = reconcileSelectedSessions(
        state.selectedSessions,
        state.result.sessions,
        (row) =>
          binding.sessions.deletionState(row.key, sessionAgentId(row.key), row.sessionId) ===
            "pending" || binding.sessions.archiveVisibility(row.key) === "pending",
      );
    }
    host.synchronizeDetails();
  }

  async function refreshSessionList(scope = captureRequestScope()) {
    if (!scope) {
      return;
    }
    clearSearchTimer();
    const binding = bindSessionList(false);
    if (!binding || binding.sessions !== scope.sessions || !isRequestScopeCurrent(scope)) {
      return;
    }
    await loadSessionList(binding, { force: true });
    if (isRequestScopeCurrent(scope) && listBinding === binding) {
      applyListSnapshot(binding, binding.sessions.listSnapshot(binding.query));
    }
  }

  function loadSessionList(
    binding: SessionsPageListBinding,
    options: { force?: boolean; offset?: number; append?: boolean } = {},
  ): Promise<void> {
    if (listRequest) {
      // Only the bound query may queue mutation invalidation in its managed owner.
      if (options.force && unsubscribeList) {
        void binding.sessions.refreshList({ ...binding.query, ...options });
      }
      return listRequest;
    }
    if (!captureRequestScope()) {
      return Promise.resolve();
    }
    // Claim before refreshList publishes. Only this connection's completion may
    // release the slot; the next query is read from page state, never queued here.
    const completion = createDeferredCore();
    const pending = completion.promise.finally(() => {
      if (listRequest !== pending) {
        return;
      }
      listRequest = undefined;
      state.refreshing = false;
      bindSessionList();
    });
    listRequest = pending;
    state.refreshing = true;
    completion.resolve(binding.sessions.refreshList({ ...binding.query, ...options }));
    return pending;
  }

  function clearSearchTimer() {
    clearTimeout(searchTimer);
    searchTimer = undefined;
  }

  function resetTranscriptSearchState(query: string) {
    state.transcriptSearchQuery = query;
    transcriptSearchAbort?.abort();
    state.transcriptSearch = { status: "idle" };
  }

  function updateTranscriptSearchQuery(query: string) {
    if (query === state.transcriptSearchQuery) {
      return;
    }
    // Editing invalidates the visible results and the in-flight query so a
    // late response cannot appear under different search text.
    resetTranscriptSearchState(query);
  }

  async function runTranscriptSearch() {
    const query = state.transcriptSearchQuery.trim();
    if (!query) {
      resetTranscriptSearchState("");
      return;
    }
    const scope = captureRequestScope();
    if (!scope) {
      return;
    }
    state.transcriptSearchQuery = query;
    await searchTranscripts(query);
  }

  function updateFilters(next: Parameters<SessionsAdvancedFiltersProps["onFiltersChange"]>[0]) {
    state.activeMinutes = next.activeMinutes;
    state.limit = next.limit;
    state.includeGlobal = next.includeGlobal;
    state.includeUnknown = next.includeUnknown;
    state.page = 0;
    state.selectedSessions = new Map();
    // Explicit filter edits leave deep-link mode; load the full roster.
    deepLinkSessionKey = null;
    void refreshSessionList();
  }

  function updateStatusFilter(statusFilter: SessionArchivedFilter) {
    if (statusFilter === state.statusFilter) {
      return;
    }
    state.statusFilter = statusFilter;
    clearSearchTimer();
    state.page = 0;
    state.selectedSessions = new Map();
    deepLinkSessionKey = null;
    // Route navigation changes the managed query; mask the old view's rows
    // until its current list subscription publishes.
    state.loading = true;
    state.error = null;
    application.navigate(
      "sessions",
      statusFilter === "active" ? undefined : { search: `?status=${statusFilter}` },
    );
    synchronize();
  }

  function updateSearchQuery(query: string) {
    deepLinkSessionKey = null;
    state.searchQuery = query;
    state.page = 0;
    state.selectedSessions = new Map();
    clearSearchTimer();
    if (captureRequestScope()) {
      searchTimer = setTimeout(() => {
        searchTimer = undefined;
        bindSessionList();
      }, SESSION_SEARCH_DEBOUNCE_MS);
    }
    bindSessionList();
  }

  function loadMore() {
    const binding = listBinding;
    const offset = state.result?.nextOffset;
    if (binding && state.result?.hasMore && offset != null && !state.loading) {
      void loadSessionList(binding, { offset, append: true });
    }
  }

  return {
    get deepLinkSessionKey() {
      return deepLinkSessionKey;
    },
    set deepLinkSessionKey(key: string | null) {
      deepLinkSessionKey = key;
    },
    sessionListOptions,
    bindSessionList,
    refreshSessionList,
    resetProviderState,
    clearSearchTimer,
    resetTranscriptSearchState,
    updateTranscriptSearchQuery,
    runTranscriptSearch,
    updateFilters,
    updateStatusFilter,
    updateSearchQuery,
    loadMore,
    applyCurrentSnapshot() {
      const binding = listBinding;
      if (binding) {
        applyListSnapshot(binding, binding.sessions.listSnapshot(binding.query));
      }
    },
    invalidate() {
      clearSearchTimer();
      listRequest = undefined;
      resetTranscriptSearchState(state.transcriptSearchQuery);
      state.loading = false;
      state.refreshing = false;
    },
    unsubscribe() {
      unsubscribeList?.();
    },
    abortTranscriptSearch() {
      transcriptSearchAbort?.abort();
    },
  };
}
