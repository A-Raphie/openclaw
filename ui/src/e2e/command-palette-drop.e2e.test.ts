import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  expectForegroundUnchanged,
  openFromForeground,
  scenario,
} from "./command-palette.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "command palette file drops" });

async function attach(target: Locator, kind: "paste" | "drop" | "drag") {
  return target.evaluate((element, eventKind) => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 100;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#203549";
    context.fillRect(0, 0, 160, 100);
    context.fillStyle = "#9ec7d8";
    context.fillRect(12, 14, 136, 18);
    context.fillStyle = "#ff7164";
    context.fillRect(12, 44, 62, 40);
    context.fillStyle = "#6d9bac";
    context.fillRect(86, 44, 62, 40);
    const content = canvas.toDataURL("image/png").split(",")[1]!;
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([Uint8Array.from(atob(content), (c) => c.charCodeAt(0))], "launcher.png", {
        type: "image/png",
      }),
    );
    if (eventKind === "paste") {
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }),
      );
    } else {
      transfer.items.add(
        new File(["Synthetic design brief"], "design-brief.pdf", { type: "application/pdf" }),
      );
      for (const type of eventKind === "drag"
        ? ["dragenter", "dragover"]
        : ["dragenter", "dragover", "drop"]) {
        element.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
      }
    }
    return content;
  }, kind);
}

suite.define(() => {
  it.each([
    { width: 1280, theme: "dark" },
    { width: 390, theme: "light" },
  ] as const)(
    "drops files into a dedicated new-session draft at $width px ($theme)",
    async ({ width, theme }) => {
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport: { width, height: 900 } },
        async ({ page }) => {
          const gateway = await installMockGateway(
            page,
            scenario({
              "sessions.create": { key: "agent:main:dashboard:dropped-files", runStarted: true },
            }),
          );
          const { palette, input, composer, url } = await openFromForeground(
            page,
            suite.server.baseUrl,
          );
          await page.evaluate((mode) => {
            document.documentElement.dataset.theme = mode;
            document.documentElement.dataset.themeMode = mode;
          }, theme);
          const surface = palette.locator(".cmd-palette");
          await attach(input, "paste");
          const images = palette.locator(".chat-attachment-thumb img");
          await expect.poll(() => images.count()).toBe(1);
          const frame = await takeControlUiScreenshotFrame(page, surface, [input, images], {
            animations: "disabled",
            elements: [surface],
          });
          await writeFile(path.join(suite.artifactDir, "files-only-" + width + ".png"), frame.png);
          await writeFile(
            path.join(suite.artifactDir, "palette-" + width + ".png"),
            frame.elements[0]!.png,
          );
          await palette.getByRole("button", { name: "Remove launcher.png", exact: true }).click();
          await expect.poll(() => images.count()).toBe(0);
          await attach(surface, "drag");
          expect(await surface.getAttribute("data-attachment-drop-active")).not.toBeNull();
          const drag = await takeControlUiScreenshotFrame(page, surface, [input], {
            animations: "disabled",
            elements: [surface],
          });
          await writeFile(
            path.join(suite.artifactDir, "drag-" + width + ".png"),
            drag.elements[0]!.png,
          );
          const imageContent = await attach(surface, "drop");
          await expect.poll(() => palette.locator(".chat-attachment-thumb").count()).toBe(2);
          await expect
            .poll(() => palette.locator(".chat-attachment-file__name").textContent())
            .toBe("design-brief.pdf");
          const start = palette.getByRole("button", {
            name: "Start new session in background",
            exact: true,
          });
          await expect.poll(() => start.isEnabled()).toBe(true);
          expect(
            await palette.locator(".cmd-palette__search").getAttribute("inert"),
          ).not.toBeNull();
          expect(await input.getAttribute("aria-controls")).toBeNull();
          const mixed = await takeControlUiScreenshotFrame(
            page,
            surface,
            [input, images, palette.locator(".chat-attachment-file__name")],
            { animations: "disabled", elements: [surface] },
          );
          await writeFile(
            path.join(suite.artifactDir, "mixed-" + width + ".png"),
            mixed.elements[0]!.png,
          );
          await input.fill("Review these");
          await input.press("Enter");
          expect(await gateway.getRequests("sessions.create")).toEqual([]);
          await input.press("Escape");
          await input.waitFor({ state: "hidden" });
          await page.keyboard.press("ControlOrMeta+K");
          await input.waitFor({ state: "visible" });
          expect(await input.inputValue()).toBe("Review these");
          expect(await images.count()).toBe(1);
          expect(await palette.locator(".chat-attachment-thumb").count()).toBe(2);
          await input.press("ControlOrMeta+Enter");
          const created = await gateway.waitForRequest("sessions.create");
          expect(created.params).toMatchObject({
            message: "Review these",
            attachments: [
              {
                type: "image",
                fileName: "launcher.png",
                mimeType: "image/png",
                content: imageContent,
              },
              {
                type: "file",
                fileName: "design-brief.pdf",
                mimeType: "application/pdf",
                content: Buffer.from("Synthetic design brief").toString("base64"),
              },
            ],
          });
          await input.waitFor({ state: "hidden" });
          await expectForegroundUnchanged(page, composer, url);
          expect(await gateway.getRequests("chat.send")).toEqual([]);
        },
      );
    },
  );
});
