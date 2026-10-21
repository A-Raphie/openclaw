import type { ApplicationContext } from "../../app/context-types.ts";
import { resetServerUiPref, selectThemeSettings } from "../../app/server-prefs-controls.ts";
import { canSyncAppearancePreference } from "../../app/server-prefs-profile-runtime.ts";
import * as serverUiPrefs from "../../app/server-prefs-reconcile.ts";
import { isAppearancePref, type ResettableServerUiPrefKey } from "../../app/server-prefs-state.ts";
import { loadSettings, patchSettings, type UiSettings } from "../../app/settings.ts";
import type { ThemeMode, ThemeName } from "../../app/theme.ts";
import type { TypefaceId } from "../../app/typography.ts";
import { getLobsterdex } from "../../components/lobster-dex.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import { i18n, isSupportedLocale, type Locale } from "../../i18n/index.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { CustomThemeImportOwner } from "./custom-theme-import-owner.ts";
import { importCustomThemeFromUrl } from "./custom-theme-import.ts";

/** Keeps preference reads and writes synchronous with the existing settings owners. */
export function createConfigPagePreferences(
  context: Pick<ApplicationContext, "gateway" | "runtimeConfig" | "theme">,
  invalidate: () => void,
) {
  let settings = loadSettings();
  const importOwner = new CustomThemeImportOwner(invalidate);

  function applySettings(patch: Partial<UiSettings>, selectedTheme?: ThemeName) {
    settings = selectedTheme ? selectThemeSettings(selectedTheme, patch) : patchSettings(patch);
    // theme.refresh() also republishes non-theme appearance prefs (text
    // scale, lobster pet visits/sounds) to app-host subscribers.
    context.theme.refresh();
    invalidate();
  }

  function currentSyncedPref<K extends ResettableServerUiPrefKey>(key: K) {
    const appearance = isAppearancePref(key);
    return serverUiPrefs.resolveServerUiPrefState(
      context.runtimeConfig.state.configSnapshot?.config,
      key,
      context.gateway.connection.gatewayUrl,
      settings,
      {
        canSync: canSyncAppearancePreference(context, appearance ? key : undefined),
        profileId: appearance ? context.gateway.snapshot?.selfUser?.id : undefined,
      },
    );
  }

  function setFont(key: "fontUi" | "fontChat", font: TypefaceId | undefined) {
    const preference = currentSyncedPref(key);
    if (preference.overridden && font === preference.resetValue) {
      resetSyncedPref(key);
    } else {
      applySettings({ [key]: font });
    }
  }

  function resetSyncedPref(key: ResettableServerUiPrefKey) {
    settings = resetServerUiPref(
      key,
      currentSyncedPref(key),
      context.gateway.connection.gatewayUrl,
      context.gateway.snapshot?.selfUser?.id,
    );
    if (key === "locale") {
      if (isSupportedLocale(settings.locale)) {
        void i18n.setLocale(settings.locale);
      } else {
        void i18n.useSystemLocale();
      }
    } else {
      context.theme.refresh();
      invalidate();
    }
  }

  function setLocale(locale: Locale | undefined) {
    if (locale === undefined) {
      resetSyncedPref("locale");
      return;
    }
    settings = patchSettings({ locale });
    void i18n.setLocale(locale);
    invalidate();
  }

  function setTheme(theme: ThemeName) {
    const preference = currentSyncedPref("theme");
    if (preference.overridden && theme === preference.resetValue) {
      resetSyncedPref("theme");
    } else {
      applySettings({}, theme);
    }
  }
  function setThemeMode(mode: ThemeMode) {
    const preference = currentSyncedPref("themeMode");
    if (preference.overridden && mode === preference.resetValue) {
      resetSyncedPref("themeMode");
    } else {
      context.theme.setMode(mode);
    }
  }

  function setTabIconMode(preference: NonNullable<UiSettings["tabIcon"]>) {
    if (
      preference.startsWith("lobster:") &&
      (!context.theme.branding.lobsterdex ||
        !LOBSTER_PET_PALETTES.some((palette) => palette.id === preference.slice(8)) ||
        !getLobsterdex().has(preference.slice(8)))
    ) {
      return;
    }
    applySettings({ tabIcon: preference });
  }

  function customThemeProps() {
    return {
      hasCustomTheme: Boolean(settings.customTheme),
      customThemeLabel: settings.customTheme?.label ?? null,
      customThemeSourceUrl: settings.customTheme?.sourceUrl ?? null,
      customThemeImportUrl: importOwner.snapshot.url,
      customThemeImportBusy: importOwner.snapshot.busy,
      customThemeImportMessage: importOwner.snapshot.message,
      customThemeImportExpanded: importOwner.snapshot.expanded,
      onCustomThemeImportUrlChange: (next: string) => importOwner.setUrl(next),
      onImportCustomTheme: () => {
        void importOwner.import({
          config: context.runtimeConfig.state,
          hasCustomTheme: Boolean(settings.customTheme),
          readTheme: () => settings.theme,
          load: importCustomThemeFromUrl,
          apply: (customTheme, activate) =>
            applySettings({ customTheme }, activate ? "custom" : settings.theme),
          messages: {
            blocked: (reason) =>
              t(reason === "loading" ? "common.loading" : "common.unsavedChanges"),
            imported: (label) => t("configPage.themeImported", { name: label }),
          },
        });
      },
      onClearCustomTheme: () => {
        importOwner.clear({
          apply: () =>
            applySettings(
              { customTheme: undefined },
              settings.theme === "custom" ? "claw" : settings.theme,
            ),
          message: t("configPage.themeRemoved"),
        });
      },
      onOpenCustomThemeImport: () => importOwner.open(),
    };
  }

  return {
    get settings() {
      return settings;
    },
    importOwner,
    applySettings,
    currentSyncedPref,
    setFont,
    resetSyncedPref,
    setLocale,
    setTheme,
    setThemeMode,
    setTabIconMode,
    customThemeProps,
    reload: () => {
      settings = loadSettings();
    },
    synchronize: () => {
      settings = importOwner.adoptSettings(settings, loadSettings());
    },
  };
}
