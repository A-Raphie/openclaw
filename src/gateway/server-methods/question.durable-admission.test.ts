import { describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  prepareOperatorModelPolicy,
  restoreOperatorModelPolicySnapshot,
} from "../../agents/operator-model-policy.js";
import * as questionStorage from "../../config/sessions/session-questions.js";
import * as questionChannel from "../../infra/question-channel-runtime.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createOwnRunFixture } from "./question.own-run.test-support.js";
import {
  broadcast,
  callQuestionRpc,
  createQuestionTestPeer,
  installQuestionTestHooks,
  manager,
  requestParams,
} from "./question.test-support.js";

installQuestionTestHooks();
const answers = { answers: { destination: ["Library"] } };
const sessionScope = { agentId: "main", sessionKey: requestParams.sessionKey };

describe("durable RPC mutation admission", () => {
  it("retains the original channel model ceiling in worker-owned question custody", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = await createOwnRunFixture(true);
      const originalModels = prepareOperatorModelPolicy({
        cfg: f.cfg,
        policy: { allow: ["fixture/original"] },
        manifestPlugins: [],
      });
      const currentModels = prepareOperatorModelPolicy({
        cfg: f.cfg,
        policy: { allow: ["fixture/*"] },
        manifestPlugins: [],
      });
      const authority = createAdmittedRunOperatorAuthority({
        ...f.source.authority,
        recoverySnapshot: undefined,
        channelRecoverySource: {
          reference: { version: 1, id: "11111111-1111-4111-8111-111111111111" },
          modelPolicy: originalModels,
        },
        modelPolicy: currentModels,
      });
      const runtime = {
        ...f.runtime,
        internal: { ...f.runtime.internal, operatorRunAuthority: authority },
      };
      const id = "channel-model-ceiling";
      try {
        const response = await f.call(
          "question.request",
          { ...requestParams, id, timeoutMs: 900_000, durable: true },
          runtime,
        );
        expect(response[0], JSON.stringify(response[2])).toBe(true);
        expect(response[1]).toMatchObject({ durable: true });
        const saved = await questionStorage.executeSessionQuestionOperation(
          { ...sessionScope, assertCurrent() {} },
          { kind: "get", id },
        );
        if (!saved || Array.isArray(saved) || !saved.provenance.channelRecoverySource) {
          throw new Error("Expected committed channel question custody");
        }
        const modelPolicy = saved.provenance.channelRecoverySource.modelPolicy;
        if (!modelPolicy) {
          throw new Error("Expected the original channel model policy");
        }
        const restored = restoreOperatorModelPolicySnapshot(modelPolicy);
        expect(restored?.allows({ provider: "fixture", model: "original" })).toBe(true);
        expect(restored?.allows({ provider: "fixture", model: "broadened" })).toBe(false);
      } finally {
        await f.close();
      }
    });
  });

  it("refuses durable registration in a foreign principal's conversation without effects", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const foreign = ensureProfileForEmail("foreign-durable@example.test");
      const f = await createOwnRunFixture(true, false, foreign.id);
      const id = "foreign-registration";
      const channel = vi.spyOn(questionChannel, "handleQuestionChannelRequested");
      try {
        expect(
          (
            await f.call(
              "question.request",
              { ...requestParams, id, timeoutMs: 900_000, durable: true },
              f.runtime,
            )
          )[0],
        ).toBe(false);
        expect(
          await questionStorage.executeSessionQuestionOperation(
            { ...sessionScope, assertCurrent() {} },
            { kind: "get", id },
          ),
        ).toBeUndefined();
        expect(manager.get(id)).toBeNull();
        expect(broadcast).not.toHaveBeenCalled();
        expect(channel).not.toHaveBeenCalled();
        expect(f.browser.socket.send).not.toHaveBeenCalled();
      } finally {
        channel.mockRestore();
        await f.close();
      }
    });
  });

  it("allows the original principal's durable answer and rejects foreign or reassigned responders without effects", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const foreign = ensureProfileForEmail("foreign-durable@example.test");
      const f = await createOwnRunFixture(true);
      const id = "principal-admission";
      const params = { ...requestParams, id, timeoutMs: 900_000, durable: true };
      const scope = { ...sessionScope, assertCurrent() {} };
      try {
        expect((await f.call("question.request", params, f.runtime))[1]).toMatchObject({
          durable: true,
        });
        broadcast.mockClear();
        f.browser.socket.send.mockClear();
        const foreignPeer = createQuestionTestPeer(foreign, "foreign-durable");
        for (const client of [foreignPeer.client, f.browser.client]) {
          const original = client.authenticatedUserProfile;
          client.authenticatedUserProfile = foreignPeer.client.authenticatedUserProfile;
          try {
            expect(await f.call("question.resolve", { id, answers }, client)).toMatchObject([
              false,
              undefined,
              { details: { reason: "QUESTION_NOT_FOUND" } },
            ]);
            expect(
              await questionStorage.executeSessionQuestionOperation(scope, { kind: "get", id }),
            ).toMatchObject({
              record: { status: "pending" },
              continuation: { status: "pending" },
            });
            expect(broadcast).not.toHaveBeenCalled();
            expect(f.browser.socket.send).not.toHaveBeenCalled();
            expect(foreignPeer.socket.send).not.toHaveBeenCalled();
          } finally {
            client.authenticatedUserProfile = original;
          }
        }
        expect((await f.call("question.resolve", { id, answers }))[1]).toEqual({
          status: "answered",
          answers,
        });
        expect(
          await questionStorage.executeSessionQuestionOperation(scope, { kind: "get", id }),
        ).toMatchObject({
          record: { status: "answered", answers },
          continuation: { status: "owed" },
        });
      } finally {
        await f.close();
      }
    });
  });

  it.each([
    ["register", "transaction"],
    ["register", "commit"],
    ["settle", "transaction"],
    ["settle", "commit"],
  ] as const)(
    "refuses %s when authority is revoked at native %s admission",
    async (operation, stage) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const f = await createOwnRunFixture(true);
        const id = "revoked-native-admission";
        const params = { ...requestParams, id, timeoutMs: 900_000, durable: true };
        const scope = { ...sessionScope, assertCurrent() {} };
        let responderCurrent = true;
        let revoked = false;
        let active = false;
        const operate = questionStorage.executeSessionQuestionOperation;
        let restore = () => {};
        try {
          if (operation === "settle") {
            expect((await f.call("question.request", params, f.runtime))[1]).toMatchObject({
              durable: true,
            });
          }
          broadcast.mockClear();
          f.browser.socket.send.mockClear();
          const channel = vi.spyOn(questionChannel, "handleQuestionChannelRequested");
          const storageSpy = vi
            .spyOn(questionStorage, "executeSessionQuestionOperation")
            .mockImplementation(async (target, input) => {
              active = input.kind === operation;
              try {
                return await operate(target, input);
              } finally {
                active = false;
              }
            });
          const create = workerAdmission.createSqliteWorkerOperationAdmission;
          const admissionSpy = vi
            .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
            .mockImplementation((callback, attachment) =>
              create((request, grant) => {
                if (active && request.stage === stage && !revoked) {
                  revoked = true;
                  if (operation === "register") {
                    f.revokeSource();
                  } else {
                    responderCurrent = false;
                  }
                }
                callback(request, grant);
              }, attachment),
            );
          restore = () => {
            channel.mockRestore();
            storageSpy.mockRestore();
            admissionSpy.mockRestore();
          };
          const request =
            operation === "register"
              ? f.call("question.request", params, f.runtime)
              : callQuestionRpc(
                  "question.resolve",
                  { id, answers },
                  {
                    cfg: f.cfg,
                    client: f.browser.client,
                    registered: true,
                    hasCurrentClientAuthority: () => responderCurrent,
                  },
                );
          await expect(request).rejects.toThrow(
            operation === "register"
              ? "Original question source revoked"
              : "Gateway requester authority changed",
          );
          expect(revoked, "the request must reach the real worker admission edge").toBe(true);
          expect(
            await questionStorage.executeSessionQuestionOperation(scope, { kind: "get", id }),
          ).toEqual(
            operation === "register"
              ? undefined
              : expect.objectContaining({
                  record: expect.objectContaining({ status: "pending" }),
                  continuation: { status: "pending" },
                }),
          );
          expect(broadcast).not.toHaveBeenCalled();
          expect(channel).not.toHaveBeenCalled();
          expect(f.browser.socket.send).not.toHaveBeenCalled();
        } finally {
          restore();
          await f.close();
        }
      });
    },
  );
});
