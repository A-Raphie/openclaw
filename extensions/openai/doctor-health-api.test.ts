import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { HealthCheck } from "openclaw/plugin-sdk/health";
import { expect, it, vi } from "vitest";
import { daybreakAliasHealthCheck, registerOpenAIDoctorChecks } from "./doctor-health-api.js";

const runtime = {
  log() {},
  error() {},
  exit(): never {
    throw new Error("unexpected exit");
  },
};

it("warns about retiring references without rewriting models or account pins", async () => {
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        model: {
          primary: "openai/gpt-daybreak-blue-latest@openai:work",
          fallbacks: ["openai/gpt-daybreak-red-latest"],
        },
        models: { "openai/gpt-daybreak-blue-latest": { alias: "defensive" } },
        embeddedAgent: { cyberFailover: { model: "openai/gpt-daybreak-red-latest" } },
      },
    },
    plugins: {
      entries: {
        codex: { config: { appServer: { cyberFailover: { model: "gpt-daybreak-blue-latest" } } } },
      },
    },
  };
  const original = structuredClone(cfg);
  const result = await daybreakAliasHealthCheck.detect({ cfg, mode: "lint", runtime });
  expect(cfg).toEqual(original);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ severity: "warning" });
  expect(daybreakAliasHealthCheck).not.toHaveProperty("repair");
  for (const path of [
    "agents.defaults.model.primary",
    "agents.defaults.model.fallbacks.0",
    "agents.defaults.models.openai/gpt-daybreak-blue-latest",
    "agents.defaults.embeddedAgent.cyberFailover.model",
    "plugins.entries.codex.config.appServer.cyberFailover.model",
  ]) {
    expect(result[0]?.message).toContain(path);
  }
  expect(result[0]?.message).toContain("October 28, 2026");
  expect(result[0]?.message).toContain("No automatic replacement");
  expect(await daybreakAliasHealthCheck.detect({ cfg, mode: "fix", runtime })).toEqual(result);
});

it("leaves specific models and other providers alone", async () => {
  const cfg: OpenClawConfig = {
    agents: { defaults: { model: "openai/gpt-daybreak-fixture-2026-10-01" } },
    plugins: {
      entries: {
        codex: {
          config: { appServer: { cyberFailover: { model: "custom/gpt-daybreak-blue-latest" } } },
        },
      },
    },
  };
  expect(await daybreakAliasHealthCheck.detect({ cfg, mode: "lint", runtime })).toEqual([]);
});

it("registers once per registry and registers again after it is cleared", () => {
  const registry = new Map<string, HealthCheck>();
  const registerHealthCheck = vi.fn((check: HealthCheck) => {
    if (registry.has(check.id)) {
      throw new Error("duplicate health check");
    }
    registry.set(check.id, check);
  });
  const host = { getHealthCheck: (id: string) => registry.get(id), registerHealthCheck };
  registerOpenAIDoctorChecks(host);
  registerOpenAIDoctorChecks(host);
  expect(registerHealthCheck).toHaveBeenCalledTimes(1);
  registry.clear();
  registerOpenAIDoctorChecks(host);
  expect(registerHealthCheck).toHaveBeenCalledTimes(2);
});
