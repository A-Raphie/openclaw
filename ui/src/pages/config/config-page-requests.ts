import type {
  PluginsListResult,
  SessionsCatalogListResult,
  SystemInfoResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context-types.ts";
import { isMissingOperatorReadScopeError } from "../../lib/gateway-errors.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { loadModelCatalog } from "../../lib/model-catalog-store.ts";
import { createPageRequest } from "../../lib/page-request.ts";
import {
  canReadSystemInfo,
  readSystemInfo,
  SYSTEM_INFO_POLL_INTERVAL_MS,
} from "../../lib/system-info.ts";
import type { ConfigPageId } from "./config-sections.ts";

const EMPTY_SESSION_CATALOG_LABELS: ReadonlyMap<string, string> = new Map();

type ConfigPageRequestHost = {
  context: Pick<ApplicationContext, "gateway" | "settingsAgentSelection">;
  connected: () => boolean;
  pageId: () => ConfigPageId;
  hiddenSessionCatalogIds: () => ReadonlySet<string>;
  invalidate: () => void;
};

/** Owns the appearance request generations, results, and system-info polling. */
export function createConfigPageRequests(host: ConfigPageRequestHost) {
  const { context, invalidate } = host;
  let systemInfo: SystemInfoResult | null = null;
  let systemInfoUnavailable = false;
  let sessionObserverModels: ModelCatalogEntry[] = [];
  let sessionObserverModelsUnavailable = false;
  let hiddenSessionCatalogLabels: ReadonlyMap<string, string> = EMPTY_SESSION_CATALOG_LABELS;
  let installedSessionSourcePluginIds: Set<string> | null = null;
  let modelsAgent: string | null = null;
  let requestedPluginsClient: GatewayBrowserClient | null = null;
  let labelsKey = "";
  let poll: ReturnType<typeof setInterval> | undefined;

  function abortRequests() {
    systemInfoTask.cancel();
    modelsTask.cancel();
    pluginsTask.cancel();
    labelsTask.cancel();
    modelsAgent = null;
    requestedPluginsClient = null;
    labelsKey = "";
  }

  function startSystemInfoPolling() {
    clearInterval(poll);
    poll = setInterval(() => {
      void refreshSystemInfo();
    }, SYSTEM_INFO_POLL_INTERVAL_MS);
  }

  function systemInfoRequestClient(): GatewayBrowserClient | null {
    if (
      !host.connected() ||
      document.visibilityState === "hidden" ||
      host.pageId() !== "appearance" ||
      systemInfoUnavailable ||
      !canReadSystemInfo(context.gateway.snapshot)
    ) {
      return null;
    }
    return context.gateway.snapshot.client;
  }

  const systemInfoTask = createPageRequest(invalidate, {
    task: async (client: GatewayBrowserClient, { signal }) => {
      const sample = await readSystemInfo(context.gateway, signal);
      return systemInfoRequestClient() === client ? sample : null;
    },
    onComplete: (sample) => {
      if (sample) {
        systemInfo = sample.value;
        startSystemInfoPolling();
        void refreshSessionObserverModels(true);
      }
    },
    onError: (error) => {
      if (isMissingOperatorReadScopeError(error)) {
        systemInfo = null;
        systemInfoUnavailable = true;
      }
    },
  });
  const modelsTask = createPageRequest(invalidate, {
    task: async (
      { client, agentId }: { client: GatewayBrowserClient; agentId: string },
      { signal },
    ) => {
      const { models } = await loadModelCatalog(client, { agentId, preparedOnly: true, signal });
      return systemInfoRequestClient() === client &&
        context.settingsAgentSelection.state.selectedId === agentId
        ? models
        : null;
    },
    onComplete: (models) => {
      if (models) {
        sessionObserverModels = models;
        sessionObserverModelsUnavailable = false;
      }
    },
    onError: () => {
      sessionObserverModels = [];
      sessionObserverModelsUnavailable = true;
    },
  });
  const pluginsTask = createPageRequest(invalidate, {
    task: (client: GatewayBrowserClient, { signal }) =>
      client.request<PluginsListResult>("plugins.list", {}, { signal }),
    onComplete: (result) => {
      installedSessionSourcePluginIds = new Set(
        result.plugins.filter((plugin) => plugin.installed).map((plugin) => plugin.id),
      );
    },
    onError: () => {},
  });
  const labelsTask = createPageRequest(invalidate, {
    task: (
      { client, agentId }: { client: GatewayBrowserClient; agentId: string | null },
      { signal },
    ) =>
      client.request<SessionsCatalogListResult>(
        "sessions.catalog.list",
        { ...(agentId ? { agentId } : {}), metadataOnly: true },
        { signal },
      ),
    onComplete: (result) => {
      hiddenSessionCatalogLabels = new Map(
        result.catalogs.map((catalog) => [catalog.id, catalog.label]),
      );
    },
    onError: () => {},
  });

  async function refreshSystemInfo() {
    const client = systemInfoRequestClient();
    if (client && !systemInfoTask.pending) {
      await systemInfoTask.run(client);
    }
  }

  async function refreshSessionObserverModels(force = false) {
    const client = systemInfo ? systemInfoRequestClient() : null;
    const agentId = context.settingsAgentSelection.state.selectedId;
    if (!client || !agentId) {
      modelsTask.cancel();
      sessionObserverModels = [];
      sessionObserverModelsUnavailable = !agentId;
      return;
    }
    if (modelsAgent === agentId && (modelsTask.pending || !force)) {
      return;
    }
    const changed = modelsAgent !== agentId;
    modelsAgent = agentId;
    if (changed) {
      sessionObserverModels = [];
      sessionObserverModelsUnavailable = false;
    }
    await modelsTask.run({ client, agentId });
  }

  function syncAppearanceRequests() {
    const snapshot = context.gateway.snapshot;
    const active = host.pageId() === "appearance";
    const pluginsClient =
      active && canCallGatewayMethod(snapshot, "plugins.list", "operator.read")
        ? snapshot.client
        : null;
    if (pluginsClient !== requestedPluginsClient) {
      pluginsTask.cancel();
      requestedPluginsClient = pluginsClient;
      installedSessionSourcePluginIds = null;
      if (pluginsClient) {
        void pluginsTask.run(pluginsClient);
      }
    }
    const agentId = context.settingsAgentSelection.state.selectedId;
    const labelsClient =
      active &&
      host.hiddenSessionCatalogIds().size > 0 &&
      canCallGatewayMethod(snapshot, "sessions.catalog.list", "operator.read")
        ? snapshot.client
        : null;
    const key = labelsClient
      ? `${agentId}\0${[...host.hiddenSessionCatalogIds()].toSorted().join("\0")}`
      : "";
    if (key !== labelsKey) {
      labelsTask.cancel();
      labelsKey = key;
      hiddenSessionCatalogLabels = EMPTY_SESSION_CATALOG_LABELS;
      if (labelsClient) {
        void labelsTask.run({ client: labelsClient, agentId });
      }
    }
  }

  function resetConnection() {
    systemInfo = null;
    systemInfoUnavailable = false;
    sessionObserverModels = [];
    sessionObserverModelsUnavailable = false;
  }

  function synchronizeSystemInfo(connectionChanged: boolean) {
    const client = systemInfoRequestClient();
    if (!client) {
      clearInterval(poll);
      poll = undefined;
      systemInfoTask.cancel();
      modelsTask.cancel();
    } else if (connectionChanged || !systemInfo || !poll) {
      startSystemInfoPolling();
      void refreshSystemInfo();
    } else {
      void refreshSessionObserverModels();
    }
  }

  return {
    get systemInfo() {
      return systemInfo;
    },
    get sessionObserverModels() {
      return sessionObserverModels;
    },
    get sessionObserverModelsUnavailable() {
      return sessionObserverModelsUnavailable;
    },
    get hiddenSessionCatalogLabels() {
      return hiddenSessionCatalogLabels;
    },
    get installedSessionSourcePluginIds() {
      return installedSessionSourcePluginIds;
    },
    get pluginsPending() {
      return pluginsTask.pending;
    },
    abort: abortRequests,
    resetConnection,
    synchronizeSystemInfo,
    synchronizeAppearance: syncAppearanceRequests,
    refreshSystemInfo,
    stopPolling: () => clearInterval(poll),
  };
}
