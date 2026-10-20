// Only external model I/O is scripted; admission, Git, progress, history and Stop are real.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { acquireGatewayTestClient } from "../../../test/helpers/gateway-client.ts";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  takeControlUiViewportScreenshot,
  takeControlUiScreenshotFrame,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { enterControlUiSession } from "../test-helpers/control-ui-session-entry.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const execFileAsync = promisify(execFile);
const reply = "Repository ready. The fresh default branch is checked out.";
let instance: OpenClawTestInstance;
let providerRequests = 0;
const suite = createControlUiE2eSuite({
  name: "Repository preparation with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const provider = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        providerRequests++;
        writeOpenAiResponsesText(response, {
          text: reply,
          messageId: "repository-fixture",
          responseId: "repository-response",
        });
      });
    });
    await new Promise<void>((resolve) => {
      provider.listen(0, "127.0.0.1", resolve);
    });
    const address = provider.address();
    if (!address || typeof address === "string") {
      throw new Error("Provider did not bind");
    }
    instance = await createOpenClawTestInstance({
      name: "repository-progress",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        VITEST: undefined,
        NO_PROXY: [process.env.no_proxy ?? process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"]
          .filter(Boolean)
          .join(","),
        no_proxy: [process.env.no_proxy ?? process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"]
          .filter(Boolean)
          .join(","),
      },
      config: {
        update: { checkOnStart: false },
        gateway: { controlUi: { enabled: true } },
        cron: { enabled: false },
        agents: {
          ownership: "explicit",
          defaults: {
            model: "repository-fixture/echo",
            modelPolicy: { allow: ["repository-fixture/*"] },
            models: {
              "repository-fixture/echo": {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
          },
          entries: { main: { identity: { name: "Repository assistant" } } },
        },
        models: {
          catalogRefresh: { enabled: false },
          providers: {
            "repository-fixture": {
              api: "openai-responses",
              apiKey: "synthetic-unused-key",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              request: { allowPrivateNetwork: true },
              models: [{ id: "echo", name: "Echo" }],
            },
          },
        },
        plugins: { allow: ["openai"] },
      },
    });
    const close = async () => {
      try {
        await instance.cleanup();
      } finally {
        await new Promise<void>((resolve, reject) => {
          provider.close((error) => (error ? reject(error) : resolve()));
          provider.closeAllConnections();
        });
      }
    };
    try {
      await instance.startGateway();
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close };
    } catch (error) {
      await close();
      throw error;
    }
  },
});

type History = {
  inFlightRun?: { runId: string; events?: Array<{ stream: string; data: { phase?: string } }> };
  messages: Array<{ role: string; content: unknown }>;
};

suite.define(() => {
  it.each(["complete", "abort"] as const)(
    "shows and replays repository progress until %s",
    async (mode) => {
      const artifacts = createControlUiE2eArtifactDir(`repository-progress-${mode}`);
      const root = instance.state.path(mode);
      const repo = path.join(root, "repo");
      const remote = path.join(root, "origin.git");
      await mkdir(repo, { recursive: true });
      const git = (cwd: string, ...args: string[]) => execFileAsync("git", ["-C", cwd, ...args]);
      await git(repo, "init", "-b", "main");
      await git(repo, "config", "user.name", "Repository proof");
      await git(repo, "config", "user.email", "proof@example.invalid");
      await writeFile(path.join(repo, "README.md"), "Initial revision\n");
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "initial");
      await git(root, "init", "--bare", "-b", "main", remote);
      await git(repo, "remote", "add", "origin", remote);
      await git(repo, "push", "-u", "origin", "main");
      // Advance only the bare origin, leaving the registered checkout and cached ref stale.
      const publisher = path.join(root, "publisher");
      await git(root, "clone", remote, publisher);
      await git(publisher, "config", "user.name", "Repository proof");
      await git(publisher, "config", "user.email", "proof@example.invalid");
      await writeFile(path.join(publisher, "README.md"), "Fresh origin revision\n");
      await git(publisher, "commit", "-am", "fresh default");
      await git(publisher, "push");
      const freshCommit = (await git(publisher, "rev-parse", "HEAD")).stdout.trim();
      const held = path.join(root, "fetch-held");
      const release = path.join(root, "release-fetch");
      const count = path.join(root, "upload-count");
      const wrapper = path.join(root, "upload-pack.cjs");
      const uploadPack = path.join(
        (await git(repo, "--exec-path")).stdout.trim(),
        "git-upload-pack",
      );
      // Hold the real fetch's upload-pack, not a progress callback or internal decision.
      // The first invocation serves ls-remote; the second serves fetch. The bound is below fetch's timeout.
      await writeFile(
        wrapper,
        `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const count = ${JSON.stringify(count)};
const n = fs.existsSync(count) ? Number(fs.readFileSync(count, 'utf8')) + 1 : 1;
fs.writeFileSync(count, String(n));
if (n === 2) {
  fs.writeFileSync(${JSON.stringify(held)}, 'held');
  const deadline = Date.now() + 45000;
  while (!fs.existsSync(${JSON.stringify(release)})) {
    if (Date.now() > deadline) process.exit(75);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}
const child = spawnSync(${JSON.stringify(uploadPack)}, process.argv.slice(2), { stdio: 'inherit' });
process.exit(child.status ?? 1);
`,
        { mode: 0o755 },
      );
      await git(repo, "config", "remote.origin.uploadpack", wrapper);
      const statuses: unknown[] = [];
      const client = await acquireGatewayTestClient(
        {
          url: instance.url,
          token: instance.gatewayToken,
          deviceIdentity: null,
          clientName: "cli",
          mode: "cli",
          scopes: ["operator.admin", "operator.read", "operator.write"],
          onEvent: (event) => {
            if (event.event === "chat") {
              statuses.push(event.payload);
            }
          },
        },
        { timeoutMs: 15_000, timeoutMessage: "RPC connect timeout", closeMessage: "RPC closed" },
      );
      const key = `agent:main:repository-${mode}`;
      const requestsBefore = providerRequests;
      try {
        const project = await client.request<{ id: string }>("projects.register", {
          path: repo,
          name: "Repository progress proof",
        });
        await client.request("sessions.create", {
          key,
          agentId: "main",
          projectId: project.id,
          worktree: true,
          worktreeName: `progress-${mode}`,
          label: `Review the latest repository (${mode})`,
          message: "Inspect the latest repository revision.",
        });
        await expect.poll(() => existsSync(held), { timeout: 20_000 }).toBe(true);
        expect(providerRequests).toBe(requestsBefore);
        const dashboard = await instance.cli(["dashboard", "--json"]);
        expect(dashboard.code, dashboard.stderr).toBe(0);
        const url = new URL(controlUiSessionUrl(suite.server.baseUrl, key, "chat"));
        url.hash = new URL(
          (JSON.parse(dashboard.stdout) as { browserUrl: string }).browserUrl,
        ).hash;
        await suite.withPage(
          { locale: "en-US", serviceWorkers: "block", viewport: { width: 1200, height: 800 } },
          async ({ page }) => {
            await page.goto(url.href);
            await enterControlUiSession(page);
            await waitForControlUiGatewayReady(page);
            const working = page.locator('.chat-working-indicator[role="status"]');
            // Capture before the assertion so a baseline failure leaves honest UI evidence.
            await writeFile(
              path.join(artifacts, "repository-held.png"),
              await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
                page.getByText("Inspect the latest repository revision.", { exact: true }),
              ]),
            );
            await expect.poll(() => working.textContent()).toContain("Updating repository…");
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.locator(".shell"),
              [working],
              { animations: "disabled" },
            );
            await writeFile(path.join(artifacts, "repository-updating.png"), frame.png);
            expect(statuses).toContainEqual(
              expect.objectContaining({
                sessionKey: key,
                state: "status",
                phase: "preparing_worktree_base",
              }),
            );
            const history = await client.request<History>("chat.history", { sessionKey: key });
            expect(history.inFlightRun?.events).toContainEqual(
              expect.objectContaining({
                stream: "run_status",
                data: { phase: "preparing_worktree_base" },
              }),
            );
            const runId = history.inFlightRun?.runId;
            expect(runId).toBeTruthy();
            await page.reload();
            await waitForControlUiGatewayReady(page);
            await expect.poll(() => working.textContent()).toContain("Updating repository…");
            if (mode === "abort") {
              await page.getByRole("button", { name: "Stop generating", exact: true }).click();
              await expect.poll(() => working.count()).toBe(0);
              await expect
                .poll(() => statuses)
                .toContainEqual(expect.objectContaining({ sessionKey: key, state: "aborted" }));
              await writeFile(release, "release");
              await expect
                .poll(
                  async () =>
                    (await client.request<History>("chat.history", { sessionKey: key }))
                      .inFlightRun,
                )
                .toBeUndefined();
              expect(providerRequests).toBe(requestsBefore);
              expect(
                (await git(repo, "branch", "--list", "openclaw/progress-abort")).stdout.trim(),
              ).toBe("");
            } else {
              await writeFile(release, "release");
              try {
                await expect
                  .poll(() => providerRequests, { timeout: 15_000 })
                  .toBeGreaterThan(requestsBefore);
                await page
                  .locator(".chat-bubble")
                  .getByText(reply, { exact: true })
                  .waitFor({ timeout: 30_000 });
              } catch (error) {
                await writeFile(
                  path.join(artifacts, "runtime-failure.private.log"),
                  instance.logs(),
                );
                await writeFile(
                  path.join(artifacts, "history-failure.private.json"),
                  JSON.stringify({
                    providerRequests,
                    history: await client.request<History>("chat.history", { sessionKey: key }),
                    statuses,
                  }),
                );
                throw error;
              }
              await expect.poll(() => working.count()).toBe(0);
              const described = await client.request<{ session: { spawnedCwd: string } }>(
                "sessions.describe",
                { key },
              );
              expect(
                (await git(described.session.spawnedCwd, "rev-parse", "HEAD")).stdout.trim(),
              ).toBe(freshCommit);
              expect(
                await readFile(path.join(described.session.spawnedCwd, "README.md"), "utf8"),
              ).toBe("Fresh origin revision\n");
              const final = await client.request<History>("chat.history", { sessionKey: key });
              expect(final.inFlightRun).toBeUndefined();
              expect(JSON.stringify(final.messages)).toContain(reply);
              expect(statuses).toContainEqual(
                expect.objectContaining({ sessionKey: key, phase: "creating_worktree" }),
              );
              expect(statuses).toContainEqual(
                expect.objectContaining({ sessionKey: key, phase: "starting_model" }),
              );
            }
          },
        );
      } finally {
        await writeFile(release, "release");
        await client.stopAndWait();
      }
    },
    180_000,
  );
});
