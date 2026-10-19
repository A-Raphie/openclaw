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
  it.each([undefined, "standard"] as const)(
    "keeps requested access separate from provider-reported %s",
    async (reported) => {
      await suite.withPage(
        { viewport: { width: 1120, height: 820 }, colorScheme: "dark" },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            agentModel: "openai/gpt-5.4",
            models: [{ id: "gpt-5.4", name: "GPT-5.4", provider: "openai", reasoning: true }],
            sessions: [
              {
                key: "agent:main:main",
                label: "Main",
                model: "gpt-5.4",
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
                model: "gpt-5.4",
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
          const select = picker.locator("[data-chat-access-program]");
          await expect.poll(() => select.inputValue()).toBe("");
          await expect
            .poll(() => picker.locator("[data-chat-access-reported]").textContent())
            .toContain(reported ? "Last response: Standard" : "Not reported · unverified");
          await select.selectOption("daybreak_blue");
          await expect
            .poll(async () =>
              (await gateway.getRequests("sessions.patch")).some(
                (request) =>
                  asOptionalRecord(request.params)?.cyberAccessProgram === "daybreak_blue",
              ),
            )
            .toBe(true);
          await expect.poll(() => select.inputValue()).toBe("daybreak_blue");
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
              [select, picker.locator("[data-chat-access-reported]")],
              { animations: "disabled" },
            );
            const dir = createControlUiE2eArtifactDir("daybreak-after");
            await writeFile(dir + "/after.png", frame.png);
          }
          await select.selectOption("standard");
          await expect.poll(() => select.inputValue()).toBe("standard");
          await select.selectOption("");
          await expect
            .poll(
              async () =>
                asOptionalRecord((await gateway.getRequests("sessions.patch")).at(-1)?.params)
                  ?.cyberAccessProgram,
            )
            .toBeNull();
          await expect.poll(() => select.inputValue()).toBe("");
        },
      );
    },
  );
});
