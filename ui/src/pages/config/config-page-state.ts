import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { createEffect, createMemo, createSignal, createStore, onSettled } from "solid-js";
import type * as Push from "../../../../packages/gateway-protocol/src/schema/push.js";
import { createChangeListeners } from "../../../../src/shared/listeners.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { titleForRoute } from "../../app-navigation.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context-types.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import {
  normalizeCatalogOpenTarget,
  normalizeTextScale,
  normalizeChatSendShortcut,
  UI_APPEARANCE_DEFAULTS,
  type UiSettings,
} from "../../app/settings.ts";
import type { ThemeMode, ThemeName } from "../../app/theme.ts";
import type { TypefaceId } from "../../app/typography.ts";
import {
  loadStoredHiddenSessionCatalogIds,
  SIDEBAR_HIDDEN_SESSION_CATALOGS_CHANGED_EVENT,
  setStoredSessionCatalogHidden,
} from "../../components/app-sidebar-session-types.ts";
import { getLobsterdex, subscribeLobsterdex } from "../../components/lobster-dex.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import { i18n, isSupportedLocale, type Locale } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveAgentAvatarUrl } from "../../lib/avatar.ts";
import { resolveControlUiServerQueueMode } from "../../lib/chat/follow-up-mode.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { modelSettingPrimary, readModelSetting } from "../../lib/model-setting.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { projectOwner, projectSource } from "../../lib/reactive/projection.ts";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import { createConfigPageMedia } from "./config-page-media.ts";
import { createConfigPagePreferences } from "./config-page-preferences.ts";
import { createConfigPageRequests } from "./config-page-requests.ts";
import {
  configSectionKeysForPage,
  configSelectionFromSearch,
  defaultConfigSelection,
  normalizeConfigSelection,
  type ConfigSelection,
  ADVANCED_EXCLUDED_SECTIONS,
  type ConfigPageId,
} from "./config-sections.ts";
import { admitMemoryRoute } from "./memory-route-admission.ts";
import {
  configTargetIdFromHash,
  type ConfigRouteData,
  type ConfigRouteSource,
} from "./route-data.ts";
import {
  buildSessionObserverTogglePatch,
  buildSessionObserverUtilityModelPatch,
  type SessionObserverModelSelection,
} from "./session-observer-settings.ts";
import { createConfigViewState } from "./view-state.ts";
import type * as View from "./view-state.ts";

registerEnglishCatalog(registerSettingsEnglish);

/** Coordinates page-local drafts and requests; config and preference writes stay with their owners. */
export function createConfigPage(
  context: ApplicationContext,
  route: () => { pageId: ConfigPageId; routeData: ConfigRouteData | null },
  host: () => HTMLElement,
) {
  const applicationConfig = projectOwner(context.config, (owner) => owner.current);
  const agents = projectOwner(context.agents, (owner) => owner.state);
  const identities = projectOwner(context.agentIdentity, (owner) => owner);
  const lobsterdex = projectSource(subscribeLobsterdex, {
    read: getLobsterdex,
    subscribe: (subscribe, notify) => subscribe(notify),
    equality: "revision",
  });
  const webPush = projectOwner(context.webPush, (owner) => owner.snapshot);
  const notifications = context.nativeNotifications
    ? projectOwner(context.nativeNotifications, (owner) => owner.snapshot)
    : null;
  // Imperative owner notifications can arrive while a descendant is rendering.
  const [revision, publish] = createSignal(0, { ownedWrite: true });
  const invalidate = () => {
    publish((value) => value + 1);
    onSettled(afterCommit);
  };
  const [presentation, setPresentation] = createStore<{
    formModes: Partial<Record<ConfigPageId, View.ConfigFormMode>>;
    selections: Partial<Record<ConfigPageId, ConfigSelection>>;
  }>({ formModes: {}, selections: {} });
  let pageId: ConfigPageId = "advanced";
  let routeData: ConfigRouteData | null = null;
  const routeListeners = createChangeListeners();
  const admittedRoute: ConfigRouteSource = {
    read: () => routeData,
    subscribe: routeListeners.subscribe,
  };
  let connected = false;
  const preferences = createConfigPagePreferences(context, invalidate);
  const {
    importOwner: customThemeImportOwner,
    applySettings,
    currentSyncedPref,
    setFont,
    resetSyncedPref,
  } = preferences;
  let hiddenSessionCatalogIds = loadStoredHiddenSessionCatalogIds();
  let configViewState: View.ConfigViewState = createConfigViewState();
  let runtimeConfigSource: ApplicationContext["runtimeConfig"] | null = null;
  let updateStatusClient: GatewayBrowserClient | null = null;
  const media = createConfigPageMedia({ invalidate, applySettings });
  const mediaDevices = media.devices;
  let previousGateway: ApplicationContext["gateway"] | null = null;
  let previousClient: GatewayBrowserClient | null = null;
  let previousHello: unknown;
  let previousPhase: string | null = null;
  let countdown: ReturnType<typeof setInterval> | undefined;
  let routeInitialized = false;
  let normalizedMemoryLocation = "";
  let targetBlockId: string | null = null;
  let scrollFrame: number | null = null;
  const requests = createConfigPageRequests({
    context,
    connected: () => connected,
    pageId: () => pageId,
    hiddenSessionCatalogIds: () => hiddenSessionCatalogIds,
    invalidate,
  });

  function nowMs() {
    revision();
    return Date.now();
  }

  function readConfigObject() {
    revision();
    const state = context.runtimeConfig.state;
    return asConfigRecord(state.configForm ?? state.configSnapshot?.config) ?? {};
  }

  function mutationDisabled() {
    revision();
    return isCuratedConfigMutationDisabled();
  }
  function updateBusy() {
    revision();
    return isUpdateBusy();
  }

  function updateRoute(nextPageId: ConfigPageId, nextRouteData: ConfigRouteData | null) {
    if (routeInitialized && nextPageId === pageId && nextRouteData === routeData) {
      return;
    }
    routeInitialized = true;
    if (pageId === "appearance" && nextPageId !== "appearance") {
      customThemeImportOwner.retireImport();
      media.retirePermissionRequests();
    }
    requests.abort();
    pageId = nextPageId;
    routeData = nextRouteData;
    admitMemoryRoute(context, pageId, routeData, normalizedMemoryLocation, (location) => {
      normalizedMemoryLocation = location;
    });
    const selection = routeData
      ? normalizeConfigSelection(pageId, routeData.section, null)
      : configSelectionFromSearch(pageId, globalThis.location?.search ?? "");
    setPresentation((draft) => {
      draft.selections[pageId] = selection;
    });
    if (scrollFrame !== null) {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = null;
    }
    targetBlockId =
      routeData?.targetBlockId ?? configTargetIdFromHash(globalThis.location?.hash ?? "");
    synchronize();
    invalidate();
    routeListeners.publish();
  }

  const hiddenSessionCatalogsChanged = () => {
    hiddenSessionCatalogIds = loadStoredHiddenSessionCatalogIds();
    synchronize();
    invalidate();
  };
  /** Reads current owners after each publication, never copies their state into a store. */
  function synchronize() {
    if (!connected) {
      return;
    }
    const gateway = context.gateway;
    const snapshot = gateway.snapshot;
    const connectionChanged =
      gateway !== previousGateway ||
      snapshot.client !== previousClient ||
      snapshot.hello !== previousHello ||
      snapshot.phase !== previousPhase;
    if (connectionChanged) {
      requests.abort();
      requests.resetConnection();
      resetConfigViewState();
      updateStatusClient = null;
      previousGateway = gateway;
      previousClient = snapshot.client;
      previousHello = snapshot.hello;
      previousPhase = snapshot.phase;
      customThemeImportOwner.synchronizeScope(gateway.connection.gatewayUrl);
    }
    synchronizeRuntimeConfig(context.runtimeConfig);
    preferences.synchronize();
    requests.synchronizeSystemInfo(connectionChanged);
    requests.synchronizeAppearance();
    const updateClient =
      pageId === "updates" && canCallGatewayMethod(snapshot, "update.status", "operator.admin")
        ? snapshot.client
        : null;
    if (updateClient !== updateStatusClient) {
      updateStatusClient = updateClient;
      if (updateClient) {
        void context.overlays.refreshUpdateStatus();
      }
    }
    const campaign = context.overlays.snapshot.updateSchedule?.campaign;
    const ticking =
      pageId === "updates" &&
      (campaign?.state === "countdown" || campaign?.state === "waiting-for-idle");
    if (ticking && !countdown) {
      countdown = setInterval(invalidate, 1_000);
    }
    if (!ticking) {
      clearInterval(countdown);
      countdown = undefined;
    }
    if (pageId === "appearance") {
      media.ensureLoaded();
      if (snapshot.phase === "connected") {
        void context.agentIdentity.ensure([context.agentSelection.state.selectedId]);
      }
    }
  }

  function afterCommit() {
    if (!connected || !targetBlockId || scrollFrame !== null) {
      return;
    }
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null;
      // Settings routes share one live page; keep the document's ID lookup scoped to it.
      const target = targetBlockId ? host().ownerDocument.getElementById(targetBlockId) : null;
      if (!target || !host().contains(target)) {
        return;
      }
      target.scrollIntoView?.({ behavior: resolveScrollBehavior(), block: "start" });
      targetBlockId = null;
    });
  }

  function synchronizeRuntimeConfig(runtimeConfig: ApplicationContext["runtimeConfig"]) {
    if (runtimeConfig !== runtimeConfigSource) {
      if (runtimeConfigSource) {
        customThemeImportOwner.retireImport();
      }
      runtimeConfigSource = runtimeConfig;
      resetConfigViewState();
    }
    const config = runtimeConfig.state;
    if (!config.configSnapshot && !config.configLoading) {
      void runtimeConfig
        .ensureLoaded()
        .then(() =>
          runtimeConfigSource === runtimeConfig && pageId !== "updates"
            ? runtimeConfig.ensureSchemaLoaded()
            : undefined,
        )
        .catch(() => undefined);
      return;
    }
    if (pageId !== "updates" && !config.configSchema && !config.configSchemaLoading) {
      void runtimeConfig.ensureSchemaLoaded().catch(() => undefined);
    }
  }

  function resetConfigViewState() {
    // Revealed secrets and raw caches never cross a capability/source epoch.
    configViewState = createConfigViewState();
    invalidate();
  }

  function isUpdateBusy(): boolean {
    const update = context.overlays.snapshot;
    return update.updateRunning || update.updateReconciliationPending;
  }

  function isCuratedConfigMutationDisabled(): boolean {
    const runtimeState = context.runtimeConfig.state;
    return (
      !runtimeState.connected ||
      runtimeState.configLoading ||
      runtimeState.configSaving ||
      runtimeState.configApplying ||
      isUpdateBusy() ||
      context.overlays.snapshot.updateStatusRefreshing ||
      !context.runtimeConfig.canSet ||
      !hasOperatorAdminAccess(context.gateway.snapshot.hello?.auth ?? null)
    );
  }

  function configProps() {
    revision();
    const configObject = readConfigObject();
    const runtimeConfig = context.runtimeConfig;
    const configState = runtimeConfig.state;
    const includeSections = configSectionKeysForPage(pageId);
    // Advanced shows everything without a curated home elsewhere.
    const excludeSections = pageId === "advanced" ? ADVANCED_EXCLUDED_SECTIONS : undefined;
    const currentSelection = presentation.selections[pageId] ?? defaultConfigSelection(pageId);
    const selection = normalizeConfigSelection(
      pageId,
      currentSelection.activeSection,
      currentSelection.activeSubsection,
    );
    const activeSection = pageId === "mcp" ? "mcp" : selection.activeSection;
    const activeSubsection = pageId === "mcp" ? null : selection.activeSubsection;
    const gatewayConfig = asConfigRecord(configObject.gateway);
    const controlUiConfig = asConfigRecord(gatewayConfig?.controlUi);
    const agentsDefaults = asConfigRecord(asConfigRecord(configObject.agents)?.defaults);
    const utilityModel = readModelSetting(agentsDefaults?.utilityModel);
    const id = context.agentSelection.state.selectedId;
    const agent = agents.read().agentsList?.agents.find((entry) => entry.id === id);
    const unlocked = lobsterdex.read();
    const themePref = currentSyncedPref("theme");
    const themeModePref = currentSyncedPref("themeMode");
    const accentPref = currentSyncedPref("accent");
    const localePref = currentSyncedPref("locale");
    const chatSendShortcutPref = currentSyncedPref("chatSendShortcut");
    const chatFollowUpModePref = currentSyncedPref("chatFollowUpMode");
    const sessionObserverBusy =
      !configState.connected ||
      configState.configSaving ||
      configState.configApplying ||
      isUpdateBusy() ||
      context.overlays.snapshot.updateStatusRefreshing ||
      !hasOperatorAdminAccess(context.gateway.snapshot.hello?.auth ?? null);
    const withConfigMutation =
      <Args extends unknown[]>(mutate: (...args: Args) => void) =>
      (...args: Args) => {
        customThemeImportOwner.retireForConfigMutation(t("common.unsavedChanges"));
        mutate(...args);
      };
    return {
      onAppearanceChange: applySettings,
      raw: configState.configRaw,
      originalRaw: configState.configRawOriginal,
      valid: configState.configValid,
      issues: configState.configIssues,
      loading: configState.configLoading,
      saving: configState.configSaving,
      applying: configState.configApplying,
      updating: isUpdateBusy() || context.overlays.snapshot.updateStatusRefreshing,
      connected: configState.connected,
      mutationAllowed: runtimeConfig.canSet,
      openFileAllowed: runtimeConfig.canOpenFile,
      schema: configState.configSchema,
      schemaLoading: configState.configSchemaLoading,
      uiHints: configState.configUiHints,
      formMode: presentation.formModes[pageId] ?? "form",
      rawDraftPending: configState.configFormMode === "raw" && configState.configFormDirty,
      viewState: configViewState,
      rawAvailable: Boolean(
        configState.configSnapshot?.config || configState.configForm || configState.configRaw,
      ),
      showModeToggle: pageId === "advanced",
      formValue: configState.configForm,
      activeSection,
      activeSubsection,
      onRawChange: withConfigMutation((next: string) => runtimeConfig.setRaw(next)),
      onFormModeChange: (mode: View.ConfigFormMode) => {
        setPresentation((draft) => {
          draft.formModes[pageId] = mode;
        });
        invalidate();
      },
      onViewStateChange: () => invalidate(),
      onFormPatch: withConfigMutation((path: Array<string | number>, value: unknown) =>
        runtimeConfig.patchForm(path, value),
      ),
      onFormRemove: withConfigMutation((path: Array<string | number>) =>
        runtimeConfig.removeFormValue(path),
      ),
      onSectionChange: (section: string | null) => {
        setPresentation((draft) => {
          draft.selections[pageId] = { activeSection: section, activeSubsection: null };
        });
        invalidate();
      },
      onSubsectionChange: (section: string | null) => {
        setPresentation((draft) => {
          draft.selections[pageId] = {
            ...(draft.selections[pageId] ?? defaultConfigSelection(pageId)),
            activeSubsection: section,
          };
        });
        invalidate();
      },
      onSave: () => void runtimeConfig.save(),
      onRawDiscard: () => void runtimeConfig.discardDraft(),
      onOpenFile: () => void runtimeConfig.openFile(),
      theme: preferences.settings.theme,
      themeOverridden: themePref.overridden,
      themeProvenance: themePref.provenance,
      themeResetValue: themePref.resetValue ?? UI_APPEARANCE_DEFAULTS.theme,
      themeMode: preferences.settings.themeMode,
      themeModeOverridden: themeModePref.overridden,
      themeModeProvenance: themeModePref.provenance,
      themeModeResetValue: themeModePref.resetValue ?? UI_APPEARANCE_DEFAULTS.themeMode,
      accent: preferences.settings.accent,
      accentProvenance: accentPref.provenance,
      accentResetValue: accentPref.resetValue,
      fontUi: preferences.settings.fontUi,
      fontChat: preferences.settings.fontChat,
      fontUiProvenance: currentSyncedPref("fontUi").provenance,
      fontChatProvenance: currentSyncedPref("fontChat").provenance,
      setFontUi: (font: TypefaceId | undefined) => setFont("fontUi", font),
      setFontChat: (font: TypefaceId | undefined) => setFont("fontChat", font),
      systemLocale: i18n.getSystemLocale(),
      localeOverride: isSupportedLocale(localePref.value) ? localePref.value : undefined,
      localeOverridden: localePref.overridden,
      localeProvenance: localePref.provenance,
      localeResetValue: isSupportedLocale(localePref.resetValue)
        ? localePref.resetValue
        : undefined,
      onLocaleChange: (locale: Locale | undefined) => {
        preferences.setLocale(locale);
      },
      themeCatalog: pageId === "appearance" ? context.theme.catalog : undefined,
      onRetryThemeCatalog: () => context.theme.retryCatalog?.(),
      setTheme: (theme: ThemeName) => preferences.setTheme(theme),
      setThemeMode: (mode: ThemeMode) => preferences.setThemeMode(mode),
      setAccent: (accent: string | undefined) =>
        accent === undefined ? resetSyncedPref("accent") : applySettings({ accent }),
      ...preferences.customThemeProps(),
      tabIcon: preferences.settings.tabIcon,
      lobsterdexEnabled: context.theme.branding.lobsterdex,
      tabIconAgentAvatar: agent ? resolveAgentAvatarUrl(agent, identities.read().get(id)) : null,
      tabIconLobsters: LOBSTER_PET_PALETTES.filter((palette) => unlocked.has(palette.id)),
      setTabIconMode: (preference: NonNullable<UiSettings["tabIcon"]>) =>
        preferences.setTabIconMode(preference),
      textScale: preferences.settings.textScale ?? UI_APPEARANCE_DEFAULTS.textScale,
      textScaleOverridden: preferences.settings.textScale !== undefined,
      setTextScale: (value: number) =>
        applySettings({
          textScale:
            value === UI_APPEARANCE_DEFAULTS.textScale ? undefined : normalizeTextScale(value),
        }),
      sidebarLiveActivity:
        preferences.settings.sidebarLiveActivity ?? UI_APPEARANCE_DEFAULTS.sidebarLiveActivity,
      hiddenSessionCatalogIds,
      hiddenSessionCatalogLabels: requests.hiddenSessionCatalogLabels,
      setSessionCatalogHidden: setStoredSessionCatalogHidden,
      terminalFontFamily: preferences.settings.terminalFontFamily,
      setTerminalFontFamily: (value: string | undefined) =>
        applySettings({ terminalFontFamily: value }),
      chatMessageMaxWidth: preferences.settings.chatMessageMaxWidth,
      chatShowTaskProgress:
        preferences.settings.chatShowTaskProgress ?? UI_APPEARANCE_DEFAULTS.chatShowTaskProgress,
      openLinksExternally: preferences.settings.openLinksExternally === true,
      openLinksInControlUiBrowser: preferences.settings.openLinksInControlUiBrowser === true,
      chatCollapseTaskProgress: preferences.settings.chatCollapseTaskProgress === true,
      showAdvancedSettings: preferences.settings.showAdvancedSettings === true,
      forceShowAdvanced: pageId === "advanced",
      forceAdvancedSection: routeData?.advanced
        ? (routeData.section ?? defaultConfigSelection(pageId).activeSection)
        : null,
      sessionObserverEnabled: controlUiConfig?.sessionObserver !== false,
      sessionObserverUtilityModel: modelSettingPrimary(utilityModel),
      sessionObserverResolvedModel: requests.systemInfo?.defaultAgentUtilityModel,
      sessionObserverModels: requests.sessionObserverModels,
      sessionObserverModelsUnavailable: requests.sessionObserverModelsUnavailable,
      sessionObserverDisabled: sessionObserverBusy,
      setSessionObserverEnabled: (enabled: boolean) =>
        void runtimeConfig.patch({
          raw: buildSessionObserverTogglePatch(enabled),
          note: t("configView.sessionObserver.toggleNote"),
        }),
      setSessionObserverUtilityModel: (modelSelection: SessionObserverModelSelection) =>
        void runtimeConfig
          .patch({
            raw: buildSessionObserverUtilityModelPatch(modelSelection, utilityModel),
            note: t("configView.sessionObserver.modelNote"),
            replacePaths: ["agents.defaults.utilityModel.fallbacks"],
          })
          .then((saved) => {
            if (saved) {
              void requests.refreshSystemInfo();
            }
          }),
      lobsterPetVisits:
        preferences.settings.lobsterPetVisits ?? UI_APPEARANCE_DEFAULTS.lobsterPetVisits,
      sessionDeleteConfirm:
        preferences.settings.sessionDeleteConfirm ?? UI_APPEARANCE_DEFAULTS.sessionDeleteConfirm,
      lobsterPetSounds:
        preferences.settings.lobsterPetSounds ?? UI_APPEARANCE_DEFAULTS.lobsterPetSounds,
      lobsterdexHref: pathForRoute("lobsterdex", context.basePath),
      onOpenLobsterdex: () => context.navigate("lobsterdex"),
      chatSendShortcut: normalizeChatSendShortcut(preferences.settings.chatSendShortcut),
      chatSendShortcutOverridden: chatSendShortcutPref.overridden,
      chatSendShortcutProvenance: chatSendShortcutPref.provenance,
      chatSendShortcutResetValue:
        chatSendShortcutPref.resetValue ?? UI_APPEARANCE_DEFAULTS.chatSendShortcut,
      chatFollowUpMode: preferences.settings.chatFollowUpMode,
      chatFollowUpModeOverridden: chatFollowUpModePref.overridden,
      chatFollowUpModeProvenance: chatFollowUpModePref.provenance,
      serverQueueMode: configState.configSnapshot
        ? resolveControlUiServerQueueMode(configState.configSnapshot.runtimeConfig, {
            configNeedsApply: configState.configNeedsApply,
          })
        : undefined,
      resetChatFollowUpMode: () => resetSyncedPref("chatFollowUpMode"),
      catalogOpenTarget: normalizeCatalogOpenTarget(preferences.settings.catalogOpenTarget),
      pluginsHref: pathForRoute("plugin-settings", context.basePath),
      installedSessionSourcePluginIds: requests.installedSessionSourcePluginIds,
      sessionSourcePluginsLoading: requests.pluginsPending,
      microphone: {
        ...mediaDevices.microphone,
        selectedDeviceId: preferences.settings.realtimeTalkInputDeviceId ?? "",
      },
      composerHoldToRecord: preferences.settings.composerHoldToRecord !== false,
      onMicrophoneRefresh: () => void media.refresh("microphone", true),
      onMicrophoneSelect: (deviceId: string) =>
        applySettings({ realtimeTalkInputDeviceId: deviceId.trim() || undefined }),
      camera: {
        ...mediaDevices.camera,
        selectedDeviceId: preferences.settings.realtimeTalkVideoDeviceId ?? "",
      },
      onCameraRefresh: () => void media.refresh("camera", true),
      onCameraSelect: (deviceId: string) => void media.selectCamera(deviceId),
      gatewayUrl: context.gateway.connection.gatewayUrl,
      assistantName: applicationConfig.read().assistantIdentity.name,
      configPath: configState.configSnapshot?.path ?? null,
      navRootLabel: pageId === "advanced" ? undefined : titleForRoute(pageId),
      showSectionDocs: pageId !== "communications",
      showRootTab: !includeSections?.length,
      includeSections,
      excludeSections,
      includeVirtualSections: pageId === "appearance" || pageId === "notifications",
      settingsLayout: pageId === "advanced" ? ("accordion" as const) : undefined,
      nativeNotifications: notifications?.read(),
      onNativeNotificationsRequestPermission: () =>
        context.nativeNotifications?.requestPermission(),
      onNativeNotificationsSendTest: () => context.nativeNotifications?.sendTest(),
      // Downstream equality checks need a new value for the mutable owner snapshot.
      webPush: { ...webPush.read() },
      onWebPushSubscribe: () => void context.webPush.run({ kind: "enable" }),
      onWebPushUnsubscribe: () => void context.webPush.run({ kind: "disable" }),
      onWebPushTest: () => void context.webPush.run({ kind: "test" }),
      onWebPushSetUserPreferences: (userPreferences: Push.WebPushNotificationPreferences) =>
        void context.webPush.run({ kind: "set", scope: "user", preferences: userPreferences }),
      onWebPushSetDevicePreferences: (devicePreferences: Push.WebPushDevicePreferences) =>
        void context.webPush.run({ kind: "set", scope: "device", preferences: devicePreferences }),
    };
  }
  const refresh = () => {
    synchronize();
    invalidate();
  };
  // Route changes synchronize the config owners, lazy requests, and polling.
  createEffect(route, (next) => updateRoute(next.pageId, next.routeData));
  onSettled(() => {
    // These notifications admit requests and retire connection-scoped work synchronously.
    const subscriptions = [
      context.gateway,
      context.runtimeConfig,
      context.settingsAgentSelection,
      context.agentSelection,
      context.overlays,
    ].map((source) => source.subscribe(refresh));
    // Server selection intent can change while the stored preferences stay equal.
    subscriptions.push(context.theme.subscribe(refresh));
    connected = true;
    preferences.reload();
    hiddenSessionCatalogsChanged();
    subscriptions.push(
      listen(window, SIDEBAR_HIDDEN_SESSION_CATALOGS_CHANGED_EVENT, hiddenSessionCatalogsChanged),
      listen(document, "visibilitychange", synchronize),
      listen(window, "focus", synchronize),
    );
    customThemeImportOwner.connect(context.gateway.connection.gatewayUrl);
    media.startWatching();
    synchronize();
    return () => {
      subscriptions.forEach((stop) => stop());
      connected = false;
      customThemeImportOwner.retireImport();
      media.retirePermissionRequests();
      media.stopWatching();
      requests.stopPolling();
      clearInterval(countdown);
      requests.abort();
      if (scrollFrame !== null) {
        cancelAnimationFrame(scrollFrame);
        scrollFrame = null;
      }
      runtimeConfigSource = null;
      resetConfigViewState();
    };
  });
  return {
    admittedRoute,
    application() {
      revision();
      return context;
    },
    configProps: createMemo(configProps),
    configObject: createMemo(readConfigObject),
    nowMs,
    mutationDisabled,
    updateBusy,
  };
}
