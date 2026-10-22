import { createRequire } from "node:module";
import path from "node:path";
import solid from "@solidjs/vite-plugin";
import type { FilterPattern, Plugin } from "vite";
import type { ViteUserConfig } from "vitest/config";

const require = createRequire(import.meta.url);

export function controlUiSolidPlugin(include: FilterPattern = /\.[jt]sx$/u): Plugin[] {
  let testMode = false;
  return [
    {
      name: "openclaw:solid-match-test-diagnostic",
      enforce: "pre",
      apply(_config, env) {
        return (
          env.command === "serve" &&
          env.mode === "test" &&
          process.env.OPENCLAW_UI_MATCH_DIAGNOSTIC === "1"
        );
      },
      transform(code, id) {
        if (!/\/(?:solid-js\/dist\/solid\.dev|deps\/solid\.dev-[^/?]+)\.js(?:\?.*)?$/u.test(id)) {
          return;
        }
        const original = 'throw narrowedError("Match")';
        if (code.split(original).length !== 2) {
          throw new Error("Expected one Solid Match diagnostic");
        }
        console.info(`[match-diagnostic] instrumented ${id}`);
        return {
          code: code.replace(original, 'throw new Error(narrowedError("Match"))'),
          map: null,
        };
      },
    },
    ...solid({
      include,
      // Skip automatic page-wide Chrome performance tracks; keep Solid's dev runtime.
      performanceTracks: false,
    }),
    {
      name: "openclaw:solid-test-runtime",
      enforce: "post",
      apply(config, env) {
        return env.command === "serve" && env.mode === "test" && config.test !== undefined;
      },
      config(_config, env): ViteUserConfig | undefined {
        testMode = env.mode === "test";
        if (!testMode) {
          return undefined;
        }
        return {
          resolve: {
            alias: [
              {
                find: /^solid-js$/u,
                replacement: path.join(path.dirname(require.resolve("solid-js")), "solid.dev.js"),
              },
              {
                find: /^@solidjs\/web$/u,
                replacement: path.join(path.dirname(require.resolve("@solidjs/web")), "web.dev.js"),
              },
            ],
          },
          test: {
            server: {
              deps: {
                // Native imports and optimized browser imports must share one owner graph.
                inline: [
                  "solid-js",
                  "@solidjs/signals",
                  "@solidjs/web",
                  "@solidjs/testing-library",
                ],
              },
            },
          },
        };
      },
      configEnvironment(name, config) {
        if (testMode && (name === "ssr" || config.consumer === "server") && config.resolve) {
          // Node-pragmas share this server; only Solid should use its browser runtime.
          config.resolve.conditions = config.resolve.conditions?.filter(
            (condition) => condition !== "browser",
          );
          config.resolve.externalConditions = config.resolve.externalConditions?.filter(
            (condition) => condition !== "browser",
          );
        }
      },
    },
  ];
}
