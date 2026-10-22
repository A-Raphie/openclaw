import { isDeepStrictEqual } from "node:util";
import {
  ErrorCodes,
  errorShape,
  validateMcpAuthLoginParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { operatorMcpOAuthIdentity } from "../../agents/mcp-oauth-identity.js";
import type { McpOAuthLoginLifecycle } from "../../agents/mcp-oauth-provider.js";
import {
  cancelMcpOAuthAuthorization,
  completeOAuthCallback,
  startMcpOAuthAuthorization,
} from "../../agents/mcp-oauth.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { quoteCliArg } from "../../cli/quote-cli-arg.js";
import { getGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import { resolveOperatorMcpOAuthConnection } from "../../plugins/mcp-auth-status.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { WizardSession } from "../../wizard/session.js";
import {
  createProviderBrowserAuthSession,
  ProviderBrowserSignInUnavailableError,
} from "../provider-browser-auth.js";
import { rejectExistingSetupWizardSession } from "./system-agent-setup-wizard.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";
import { startWizardLogin } from "./wizard-login.js";

export const mcpAuthLoginHandlers: GatewayRequestHandlers = {
  "mcp.authLogin": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateMcpAuthLoginParams, "mcp.authLogin", respond)) {
      return;
    }
    const reject = (message: string) =>
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
    if (!client || !client.connect.scopes?.includes("operator.admin")) {
      reject("Sign-in requires an administrator connection.");
      return;
    }
    if (rejectExistingSetupWizardSession({ sessionId: params.sessionId, context, respond })) {
      return;
    }
    const metadata = getGatewayPluginMetadataSnapshot();
    const resolveConnection = () =>
      resolveOperatorMcpOAuthConnection({
        config: context.getRuntimeConfig(),
        metadata,
        serverName: params.serverName,
      });
    const connection = resolveConnection();
    const methodRegistry = context.getGatewayMethodRegistry?.();
    const isOperatorOwned = () =>
      getGatewayPluginMetadataSnapshot() === metadata &&
      getPluginRuntimeGatewayRequestScope()?.pluginRegistry === methodRegistry?.pluginRegistry;
    if (!connection || !isOperatorOwned()) {
      reject(
        "This MCP server cannot use operator browser sign-in. Check its existing account settings.",
      );
      return;
    }
    // `openclaw mcp login` reads only operator-authored `mcp.servers` and is
    // offline-only, so the terminal path names the stop step; servers a plugin
    // declares have no CLI sign-in path, so recovery points at the plugin.
    const terminalLogin = Object.hasOwn(
      context.getRuntimeConfig().mcp?.servers ?? {},
      params.serverName,
    )
      ? `stop the Gateway with ${formatCliCommand("openclaw gateway stop")}, run ${formatCliCommand(`openclaw mcp login ${quoteCliArg(params.serverName)}`)}, then start the Gateway again`
      : undefined;
    const settingsOwner = terminalLogin ? "MCP server" : "plugin";
    if (!client.browserOrigin) {
      reject(
        terminalLogin
          ? `Open Settings on this Gateway to sign in, or sign in from its terminal: ${terminalLogin}.`
          : "Open Settings on this Gateway to sign in.",
      );
      return;
    }
    const { config } = connection;
    const initialServer = structuredClone(connection.server);
    const identity = operatorMcpOAuthIdentity(params.serverName, config.url);
    const assertCurrent = () => {
      client.connectionSignal?.throwIfAborted();
      if (client.invalidated || !client.connect.scopes?.includes("operator.admin")) {
        throw new Error("Sign-in authority is no longer active.");
      }
      if (
        context.getGatewayMethodRegistry?.() !== methodRegistry ||
        !isDeepStrictEqual(initialServer, resolveConnection()?.server) ||
        !isOperatorOwned()
      ) {
        throw new Error(
          "This MCP server changed. Close this dialog and review its settings before signing in again.",
        );
      }
    };
    await startWizardLogin({
      client,
      context,
      sessionId: params.sessionId,
      respond,
      assertCurrent,
      createSession: () =>
        new WizardSession(
          async (prompter, signal, runner) => {
            let attemptState: string | undefined;
            let saved = false;
            const browser = createProviderBrowserAuthSession({
              signal: AbortSignal.any([
                signal,
                ...(client.connectionSignal ? [client.connectionSignal] : []),
              ]),
              browserOrigin: client.browserOrigin,
              openUrl: async (url) => {
                login.assertCurrent();
                await prompter.openUrl?.(url);
                login.assertCurrent();
              },
            });
            const login: McpOAuthLoginLifecycle = {
              signal: browser.signal,
              assertCurrent: () => {
                signal.throwIfAborted();
                assertCurrent();
                browser.assertCurrent();
              },
              onAuthorizationPublished: (state) => {
                attemptState = state;
              },
              beforeTokensSaved: () => runner.lockCancellation(),
              onTokensSaved: () => {
                saved = true;
              },
            };
            const failure = () =>
              new Error(
                saved
                  ? `Authentication saved, but sign-in cleanup did not finish. Close this dialog and check the ${settingsOwner} before trying again.`
                  : terminalLogin
                    ? `Sign-in did not finish. Check the MCP server settings and try again, or sign in from this Gateway's terminal: ${terminalLogin}.`
                    : "Sign-in did not finish. Check the plugin settings and try again.",
              );
            try {
              try {
                const result = await browser.authorizePrepared<"authorized">({
                  timeoutMs: 10 * 60_000,
                  prepare: async (redirectUrl) => {
                    const started = await startMcpOAuthAuthorization(identity, config, {
                      redirectUrl,
                      login,
                    });
                    return started.status === "authorized" ? { result: "authorized" } : started;
                  },
                });
                if (
                  result !== "authorized" &&
                  (await completeOAuthCallback(identity, config, result, login)) !== "authorized"
                ) {
                  throw failure();
                }
              } finally {
                browser.close();
                if (attemptState) {
                  await cancelMcpOAuthAuthorization(identity, attemptState);
                }
              }
            } catch (error) {
              throw error instanceof ProviderBrowserSignInUnavailableError ? error : failure();
            }
          },
          { timeoutMs: 10 * 60_000 },
        ),
    });
  },
};
