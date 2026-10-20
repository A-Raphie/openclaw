// Real built UI, Gateway persistence, queue admission and OpenAI plugin; only external I/O is synthetic.
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { zstdDecompressSync } from "node:zlib";
import { expect, it } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.js";
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

let owner: OpenClawTestInstance;
let dir: string;
let programs: string[] | undefined = ["standard", "daybreak_blue", "daybreak_red"];
const receipts: Array<{ model: string; access?: unknown; tier?: string }> = [];
const held = new Map<number, ServerResponse>();
let holdNext = false;
const proof: Record<string, unknown> = {
  externalIO: "synthetic authenticated catalog and Responses fixture",
  productionEntitlement: false,
  complete: false,
};
const reply = (response: ServerResponse, index: number) =>
  writeOpenAiResponsesText(response, {
    text: "Fixture reply " + index,
    responseId: "response-" + index,
    messageId: "message-" + index,
  });
const suite = createControlUiE2eSuite({
  name: "Daybreak through a real built Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    dir = createControlUiE2eArtifactDir("daybreak-real-gateway");
    const provider = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          void (async () => {
            const url = new URL(request.url ?? "/", "http://fixture");
            if (url.pathname.endsWith("/models")) {
              response.setHeader("content-type", "application/json");
              response.end(
                JSON.stringify({
                  models: [
                    {
                      slug: "gpt-6.1-sol",
                      display_name: "GPT-6.1 Sol",
                      visibility: "list",
                      context_window: 128000,
                      max_output_tokens: 16000,
                      supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
                      service_tiers: [{ id: "priority" }, { id: "ultrafast" }],
                      ...(programs ? { available_access_programs: { cyber: programs } } : {}),
                    },
                  ],
                }),
              );
              return;
            }
            if (request.method === "POST" && url.pathname.endsWith("/responses")) {
              const wire = await buffer(request);
              const body = JSON.parse(
                (request.headers["content-encoding"] === "zstd"
                  ? zstdDecompressSync(wire)
                  : wire
                ).toString(),
              );
              if (body.model !== "gpt-6.1-sol") {
                proof.auxiliaryRequests = [
                  ...(Array.isArray(proof.auxiliaryRequests) ? proof.auxiliaryRequests : []),
                  { model: body.model, keys: Object.keys(body) },
                ];
                reply(response, -1);
                return;
              }
              const index = receipts.length;
              receipts.push({
                model: body.model,
                access: body.access_programs,
                tier: body.service_tier,
              });
              if (holdNext) {
                holdNext = false;
                held.set(index, response);
              } else {
                reply(response, index);
              }
              return;
            }
            request.resume();
            response.writeHead(404).end();
          })().catch((error: unknown) => {
            proof.fixtureFailure = String(error);
            response.destroy();
          });
        }),
    });
    const preload = path.join(dir, "provider-network-fixture.cjs");
    await writeFile(
      preload,
      `const undici = require("undici/index.js");
const original = globalThis.fetch;
const localDispatcher = new undici.Agent();
globalThis.fetch = (input, init) => { const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url); if (url.hostname === "chatgpt.com" || url.hostname === "api.openai.com") { const local = "http://127.0.0.1:PORT" + url.pathname + url.search; const { dispatcher, ...localInit } = init ?? {}; return original(typeof input === "string" || input instanceof URL ? local : new Request(local, input), { ...localInit, dispatcher: localDispatcher }); } if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return original(input, init); throw new Error("External network forbidden in Daybreak fixture: " + url.hostname); };
// Cover native dispatcher fetch as well as global fetch; no provider I/O leaves the fixture.
globalThis.fetch.mock = {};
globalThis.__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__ = { ...undici, fetch: globalThis.fetch };
`.replace("PORT", String(provider.claim.port)),
    );
    owner = await createOpenClawTestInstance({
      name: "daybreak-real-gateway",
      entrypoint: ["dist/index.js"],
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        VITEST: undefined,
        NODE_OPTIONS: (process.env.NODE_OPTIONS ?? "") + " --require=" + preload,
      },
      config: {
        update: { checkOnStart: false },
        auth: {
          profiles: { "openai:daybreak-fixture": { provider: "openai", mode: "oauth" } },
          order: { openai: ["openai:daybreak-fixture"] },
        },
        gateway: { controlUi: { enabled: true } },
        cron: { enabled: false },
        memory: { search: { enabled: false } },
        agents: {
          defaults: {
            model: "openai/gpt-6.1-sol",
            models: {
              "openai/gpt-6.1-sol": {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse", responsesServerCompaction: false },
              },
            },
          },
        },
        plugins: { allow: ["openai"], entries: { codex: { enabled: false } } },
        models: { catalogRefresh: { enabled: false } },
      },
    });
    const token =
      "e30." +
      Buffer.from(
        JSON.stringify({
          exp: Math.floor(Date.now() / 1000) + 86400,
          "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-daybreak-account" },
        }),
      ).toString("base64url") +
      ".synthetic";
    await owner.state.writeAuthProfiles({
      version: 1,
      profiles: {
        "openai:daybreak-fixture": {
          type: "oauth",
          provider: "openai",
          access: token,
          refresh: "synthetic-refresh",
          expires: Date.now() + 86400000,
          accountId: "synthetic-daybreak-account",
        },
      },
    });
    const close = async () => {
      try {
        await writeFile(path.join(dir, "gateway.private.log"), owner.logs());
        await owner.cleanup();
      } finally {
        for (const response of held.values()) {
          response.destroy();
        }
        provider.listener.closeAllConnections();
        await provider.releaseListener();
        await provider.claim.release();
        await writeFile(
          path.join(dir, "proof.json"),
          JSON.stringify({ ...proof, receipts, cleanupReturned: true }, null, 2),
        );
      }
    };
    try {
      await owner.startGateway();
      return { baseUrl: "http://127.0.0.1:" + owner.port + "/", close };
    } catch (error) {
      proof.startupFailure = String(error);
      await close();
      throw error;
    }
  },
});

suite.define(() => {
  it("persists visible selections and refreshes queued requests on desktop and mobile", async () => {
    const runCli = async (args: string[]) => {
      const result = await owner.cli(args);
      expect(result.code, result.stderr).toBe(0);
      return result.stdout;
    };
    const call = async (method: string, params: Record<string, unknown>) =>
      JSON.parse(
        await runCli(["gateway", "call", method, "--json", "--params", JSON.stringify(params)]),
      );
    for (const mobile of [false, true]) {
      const name = mobile ? "mobile" : "desktop";
      const key = "agent:main:daybreak-" + name;
      programs = ["standard", "daybreak_blue", "daybreak_red"];
      proof.initialCatalog = await call("models.list", { agentId: "main", refresh: true });
      await call("sessions.create", { key, agentId: "main", label: "Daybreak " + name });
      await suite.withPage(
        {
          viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
          colorScheme: "dark",
        },
        async ({ page }) => {
          await pairControlUiPage(page, runCli);
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
          await waitForControlUiGatewayReady(page);
          const picker = page.locator(".chat-controls__effort-picker").first();
          const menu = picker.locator(".chat-controls__effort-menu");
          const select = picker.locator("[data-chat-access-program]");
          const open = async () => {
            if (!(await menu.isVisible())) {
              await picker.locator("summary").click();
            }
            await menu.waitFor();
          };
          const snapshot = async (stage: string) => {
            const frame = await takeControlUiScreenshotFrame(page, menu, [], {
              animations: "disabled",
            });
            await writeFile(path.join(dir, name + "-" + stage + ".png"), frame.png);
          };
          const row = async () => {
            const result = await call("sessions.list", { agentId: "main", limit: 100 });
            return result.sessions.find((entry: { key: string }) => entry.key === key);
          };
          const choose = async (value: string) => {
            await open();
            await select.selectOption(value);
            await expect
              .poll(async () => (await row()).cyberAccessProgram)
              .toBe(value || undefined);
          };
          const send = async (text: string) =>
            evaluateControlUiContext(
              page,
              async (context, data) =>
                context.gateway.snapshot.client!.request("chat.send", {
                  sessionKey: data.key,
                  message: data.text,
                  queueMode: "followup",
                  idempotencyKey: data.id,
                }),
              { key, text, id: randomUUID() },
            );
          await open();
          await expect.poll(() => select.count()).toBe(1);
          expect(
            await select
              .locator("option")
              .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("value"))),
          ).toEqual(["", "standard", "daybreak_blue", "daybreak_red"]);
          const script = await page
            .locator('script[type="module"][src]')
            .first()
            .getAttribute("src");
          const bytes = await (
            await page.request.get(new URL(script!, suite.server.baseUrl).href)
          ).body();
          expect(bytes.equals(await readFile(path.join("dist/control-ui", script!.slice(1))))).toBe(
            true,
          );
          proof.uiAsset = {
            path: script,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
          await snapshot("both");
          for (const target of ["standard", ""]) {
            await choose("daybreak_blue");
            const first = receipts.length;
            holdNext = true;
            await send("Hold this fixture turn.");
            await expect.poll(() => held.has(first)).toBe(true);
            expect(receipts[first]?.access).toEqual({ cyber: "daybreak_blue" });
            await send("Use the preference saved before this queued turn starts.");
            proof.persistedDuringRun = (await row()).cyberAccessProgram;
            proof.afterSendCatalog = await call("models.list", {
              agentId: "main",
              sessionKey: key,
            });
            await choose(target);
            expect(receipts).toHaveLength(first + 1);
            const response = held.get(first)!;
            held.delete(first);
            reply(response, first);
            await expect.poll(() => receipts.length).toBe(first + 2);
            expect(receipts[first + 1]?.access).toEqual(target ? { cyber: target } : undefined);
            await expect.poll(async () => Boolean((await row()).hasActiveRun)).toBe(false);
            proof[name + "-queued-" + (target || "cleared")] = receipts.slice(first, first + 2);
          }
          await choose("daybreak_blue");
          programs = ["standard", "daybreak_blue"];
          await call("models.list", { agentId: "main", refresh: true });
          await page.reload();
          await waitForControlUiGatewayReady(page);
          await open();
          await expect.poll(() => select.locator('option[value="daybreak_red"]').count()).toBe(0);
          await snapshot("blue-only");
          programs = [];
          await call("models.list", { agentId: "main", refresh: true });
          await page.reload();
          await waitForControlUiGatewayReady(page);
          await open();
          await expect.poll(() => select.count()).toBe(0);
          expect((await row()).cyberAccessProgram).toBe("daybreak_blue");
          await snapshot("no-access");
          programs = undefined;
          await call("models.list", { agentId: "main", refresh: true });
          await page.reload();
          await waitForControlUiGatewayReady(page);
          await open();
          expect(await select.count()).toBe(0);
          await snapshot("unknown");
          await picker.locator("summary").click();
          const modelPicker = page.locator(".chat-controls__model-picker").first();
          await modelPicker.locator("summary").click();
          const recovery = modelPicker.getByRole("button", { name: "Clear saved Access" });
          await recovery.waitFor();
          const stale = await takeControlUiScreenshotFrame(
            page,
            modelPicker.locator(".chat-controls__model-menu"),
            [],
            { animations: "disabled" },
          );
          await writeFile(path.join(dir, name + "-stale-selection.png"), stale.png);
          await recovery.click();
          await expect.poll(async () => (await row()).cyberAccessProgram).toBeUndefined();
          await expect.poll(() => recovery.count()).toBe(0);
          const before = receipts.length;
          await send("Continue after clearing stale Access.");
          await expect.poll(() => receipts.length).toBe(before + 1);
          expect(receipts[before]?.access).toBeUndefined();
          await expect.poll(async () => Boolean((await row()).hasActiveRun)).toBe(false);
        },
      );
    }
    proof.complete = true;
  }, 180_000);
});
