import { writeFile } from "node:fs/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Daybreak chat controls",
  startServer: () => startControlUiE2eServer(),
});
suite.define(() => {
  it.each([
    { reported: undefined, width: 1440, height: 900 },
    { reported: "standard", width: 1440, height: 900 },
    { reported: undefined, width: 390, height: 844 },
  ] as const)(
    "keeps requested access separate from provider-reported $reported at $width",
    async ({ reported, width, height }) => {
      await suite.withPage(
        { viewport: { width, height }, colorScheme: "dark" },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            agentModel: "openai/gpt-6.1-sol",
            models: [
              {
                id: "gpt-6.1-sol",
                name: "GPT-6.1 Sol",
                provider: "openai",
                reasoning: true,
                available: true,
                supportsFastMode: true,
                serviceTiers: ["priority", "ultrafast"],
              },
            ],
            sessions: [
              {
                key: "agent:main:main",
                label: "Main",
                model: "gpt-6.1-sol",
                modelProvider: "openai",
                thinkingLevel: "medium",
                thinkingLevels: [
                  { id: "low", label: "Low" },
                  { id: "medium", label: "Medium" },
                  { id: "high", label: "High" },
                ],
              },
            ],
            historyMessages: [
              {
                role: "user",
                content: [{ type: "text", text: "Review the security test plan." }],
                timestamp: 1780000000000,
              },
              {
                role: "assistant",
                model: "gpt-6.1-sol",
                provider: "openai",
                responseAccessProgram: reported,
                content: [
                  {
                    type: "text",
                    text: "I’ll review the plan and call out gaps before we run any tests.",
                  },
                ],
                timestamp: 1780000001000,
              },
            ],
          });
          await page.goto(suite.server.baseUrl + "chat");
          const picker = page.locator(".chat-controls__effort-picker").first();
          await expect
            .poll(() => picker.locator("summary").getAttribute("aria-disabled"))
            .toBe("false");
          await picker.locator("summary").click();
          const menu = picker.locator(".chat-controls__effort-menu");
          await expect.poll(() => menu.isVisible()).toBe(true);
          await expect
            .poll(() => menu.evaluate((element) => element.scrollHeight <= element.clientHeight))
            .toBe(true);
          await expect
            .poll(() => picker.locator("[data-chat-speed-option=ultrafast]").count())
            .toBe(1);
          const access = picker.locator("[data-chat-access-program]");
          const blue = access.locator('[data-chat-access-option="daybreak_blue"]');
          const standard = access.locator('[data-chat-access-option="standard"]');
          const red = access.locator('[data-chat-access-option="daybreak_red"]');
          const reset = picker.locator("[data-chat-access-reset]");
          await expect.poll(() => access.locator('[aria-checked="true"]').count()).toBe(0);
          await expect.poll(() => red.isDisabled()).toBe(false);
          await expect
            .poll(() => picker.locator("[data-chat-access-reported]").textContent())
            .toContain(reported ? "Last response: Standard" : "Not reported · unverified");
          await blue.click();
          await expect
            .poll(async () =>
              (await gateway.getRequests("sessions.patch")).some(
                (request) =>
                  asOptionalRecord(request.params)?.cyberAccessProgram === "daybreak_blue",
              ),
            )
            .toBe(true);
          await expect.poll(() => blue.getAttribute("aria-checked")).toBe("true");
          await expect
            .poll(() => picker.locator("[data-chat-access-reported]").textContent())
            .toContain(reported ? "Last response: Standard" : "Not reported · unverified");
          if (!reported) {
            if (!(await menu.isVisible())) {
              await picker.locator("summary").click();
            }
            const frame = await takeControlUiScreenshotFrame(
              page,
              menu,
              [access, picker.locator("[data-chat-access-reported]")],
              { animations: "disabled" },
            );
            const dir = createControlUiE2eArtifactDir("daybreak-after-" + width);
            await writeFile(dir + "/after.png", frame.png);
          }
          await standard.click();
          await expect.poll(() => standard.getAttribute("aria-checked")).toBe("true");
          await reset.click();
          await expect
            .poll(
              async () =>
                asOptionalRecord((await gateway.getRequests("sessions.patch")).at(-1)?.params)
                  ?.cyberAccessProgram,
            )
            .toBeNull();
          await expect.poll(() => access.locator('[aria-checked="true"]').count()).toBe(0);
        },
      );
    },
  );
});
