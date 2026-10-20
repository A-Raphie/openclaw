// @vitest-environment node
import { createEffect, createRoot, flush } from "@solidjs/signals";
import { expect, it, vi } from "vitest";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { registerApprovalPromptsEnglish } from "../locales/en-approval-prompts.ts";
import { registerBoardWebsiteEnglish } from "../locales/en-board-website.ts";
import { registerBoardEnglish } from "../locales/en-board.ts";
import { en } from "../locales/en.ts";
import { loadLazyLocaleTranslation } from "./registry.ts";
import { captureI18nStateForTesting } from "./translate.test-support.ts";
import { i18n } from "./translate.ts";

vi.hoisted(() => vi.resetModules());

it("loads approval-page copy on demand while retaining shared startup labels", () => {
  const original = { ...en.approvalPage };
  const originalExec = { ...en.execApproval };
  try {
    expect(t("approvalPage.brandName")).toBe("OpenClaw");
    expect(t("approvalPage.actionsLabel")).toBe("Approval decisions");
    expect(t("approvalPage.loadingTitle")).toBe("approvalPage.loadingTitle");
    expect(t("execApproval.reviewOnly")).toContain("Review only.");
    expect(t("execApproval.startWatcher")).toBe("execApproval.startWatcher");
    registerEnglishCatalog(registerApprovalPromptsEnglish);
    expect(t("approvalPage.loadingTitle")).toBe("Loading approval");
    expect(t("approvalPage.watcherTitle", { name: "Fixture" })).toBe("Watcher approval: Fixture");
    expect(t("approvalPage.brandName")).toBe("OpenClaw");
    expect(t("execApproval.startWatcher")).toBe("Start watching");
  } finally {
    for (const key of Object.keys(en.approvalPage)) {
      if (!Object.hasOwn(original, key)) {
        Reflect.deleteProperty(en.approvalPage, key);
      }
    }
    Object.assign(en.approvalPage, original);
    for (const key of Object.keys(en.execApproval)) {
      if (!Object.hasOwn(originalExec, key)) {
        Reflect.deleteProperty(en.execApproval, key);
      }
    }
    Object.assign(en.execApproval, originalExec);
  }
});

it.each([
  {
    register: registerBoardWebsiteEnglish,
    activeKey: "websiteOpen",
    activeText: "Webseite öffnen",
    fallbackKey: "websiteEmbedHint",
    fallbackText: "If this site does not load here, open it in a new tab.",
  },
  {
    register: registerBoardEnglish,
    activeKey: "appLoading",
    activeText: "App wird wiederhergestellt…",
    fallbackKey: "errorDetail",
    fallbackText: "The problem is contained to this card.",
  },
])(
  "invalidates public t for lazy $activeKey fallback without replacing active translations",
  async ({ register, activeKey, activeText, fallbackKey, fallbackText }) => {
    const restoreI18n = captureI18nStateForTesting();
    const originalGerman = await loadLazyLocaleTranslation("de");
    const widget = en.board.widget;
    const originalWidget = { ...widget };
    const labels: (readonly string[])[] = [];
    let dispose = () => {};
    try {
      i18n.registerTranslation("de", { board: { widget: { [activeKey]: activeText } } });
      await i18n.setLocale("de");
      dispose = createRoot((stop) => {
        createEffect(
          () => [t(`board.widget.${activeKey}`), t(`board.widget.${fallbackKey}`)],
          (value) => {
            labels.push(value);
          },
        );
        return stop;
      });
      flush();
      expect(labels).toEqual([[activeText, `board.widget.${fallbackKey}`]]);

      registerEnglishCatalog<ReturnType<typeof register>>(register);
      flush();
      expect(labels.at(-1)).toEqual([activeText, fallbackText]);
      expect(en.board.widget).toBe(widget);
      const count = labels.length;
      registerEnglishCatalog<ReturnType<typeof register>>(register);
      flush();
      expect(labels).toHaveLength(count);
    } finally {
      dispose();
      for (const key of Object.keys(widget)) {
        if (!Object.hasOwn(originalWidget, key)) {
          Reflect.deleteProperty(widget, key);
        }
      }
      Object.assign(widget, originalWidget);
      if (originalGerman) {
        i18n.registerTranslation("de", originalGerman);
      }
      await restoreI18n();
    }
  },
);
