import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import type {
  ReplyBackendMessageInjectionV2,
  ReplyToolAuthorityOverlay,
} from "../../auto-reply/reply/reply-run-registry.contracts.js";
import {
  beginReplyMessageInjectionTarget,
  replyRunRegistry,
} from "../../auto-reply/reply/reply-run-registry.js";
import { createTestReplyOperation } from "../../auto-reply/reply/reply-run-registry.test-helpers.js";
import { testing } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { createCanonicalAgentConfigFixture } from "../../test-utils/config-roster.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../embedded-agent-runner/run/attempt-queue-message.js";
import {
  queueGuardedEmbeddedAgentMessageWithOutcomeAsync,
  setActiveEmbeddedRun,
} from "../embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing as embeddedTesting,
} from "../embedded-agent-runner/runs.test-support.js";
import {
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
} from "./agent-session-loop-correctness.test-support.js";

registerAgentSessionLoopTestLifecycle();
afterEach(() => {
  embeddedTesting.resetActiveEmbeddedRuns();
  testing.resetReplyRunRegistry();
  vi.useRealTimers();
});

it.each(["allowed", "refused", "revoked"] as const)(
  "retains the independent embedded caller guard through real enqueue: %s",
  async (caller) => {
    const { session } = await createTestSession();
    const enqueue = vi.spyOn(session.agent, "steer");
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    let canInject = caller !== "refused";
    const onQueueAccepted = vi.fn();
    const sourcePreparation = {
      assertCurrent() {},
      async prepareCurrent() {},
    };
    const injection: ReplyBackendMessageInjectionV2 = {
      version: 2,
      isAvailable: () => true,
      async queueMessage() {
        throw new Error("Expected prepared embedded steering");
      },
      queueMessageAsync: (text, options, preparation) =>
        steerActiveSessionWithOptionalDeliveryWait(
          session,
          text,
          options,
          undefined,
          () => {
            preparation.assertCurrent();
            return true;
          },
          undefined,
          async () => {
            await preparation.prepareCurrent();
            if (caller === "revoked") {
              entered.resolve();
              await resume.promise;
            }
          },
        ),
    };
    const sessionId = `independent-caller-${caller}`;
    setActiveEmbeddedRun(sessionId, {
      ...createEmbeddedRunHandle(),
      messageInjectionV2: injection,
    });
    const outcome = queueGuardedEmbeddedAgentMessageWithOutcomeAsync(
      sessionId,
      "independent caller input",
      { onQueueAccepted },
      () => canInject,
      sourcePreparation,
    );
    try {
      if (caller === "revoked") {
        await awaitGateBeforeSettlement(
          entered.promise,
          outcome,
          "Final preparation was not reached",
        );
        canInject = false;
        resume.resolve();
      }
      await expect(outcome).resolves.toMatchObject({ queued: caller === "allowed" });
      if (caller === "allowed") {
        expect(enqueue).toHaveBeenCalledOnce();
        expect(session.getSteeringMessages()).toEqual(["independent caller input"]);
        expect(onQueueAccepted).toHaveBeenCalledExactlyOnceWith(true);
      } else {
        expect(enqueue).not.toHaveBeenCalled();
        expect(session.getSteeringMessages()).toEqual([]);
        expect(onQueueAccepted).not.toHaveBeenCalledWith(true);
      }
    } finally {
      resume.resolve();
      await outcome;
    }
  },
);

it("orders final steering preparation through the actual session enqueue", async () => {
  vi.useFakeTimers();
  const { session } = await createTestSession();
  const enqueue = vi.spyOn(session.agent, "steer");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const steer = (text: string, prepare: () => Promise<void>) =>
    session.steer(
      text,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => true,
      undefined,
      prepare,
    );
  const first = steer("first", async () => {
    entered.resolve();
    await release.promise;
  });
  const pending = [first];
  try {
    await awaitGateBeforeSettlement(
      entered.promise,
      first,
      "first final preparation did not start",
    );
    pending.push(steer("second", async () => {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(enqueue).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all(pending);
    expect(enqueue.mock.calls.map(([message]) => message)).toMatchObject([
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ]);
  } finally {
    release.resolve();
    await Promise.allSettled(pending);
  }
});

it.each(["worker-policy", "worker-revoked", "legacy-policy"] as const)(
  "refuses steering after delayed preparation changes %s authority",
  async (change) => {
    await withOpenClawTestState({ label: `steering-${change}` }, async ({ env }) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env });
      const sessionKey = "agent:main:steering-policy";
      writeSessionEntry(database, sessionKey, {
        sessionId: "original",
        updatedAt: 1,
        sandboxMode: "off",
      });
      const run = createQueueTestRun({ prompt: "steer", originatingChannel: "webchat" });
      Object.assign(run.run, {
        agentId: "main",
        sessionId: "original",
        sessionKey,
        config: createCanonicalAgentConfigFixture({
          agents: { defaults: { sandbox: { mode: "all" } } },
        }).config,
        senderIsOwner: true,
        clientCaps: ["ui-commands"],
        gatewayUiCommandTarget: { connId: "browser", profileId: "viewer" },
      });
      const operation = createTestReplyOperation({ sessionKey, sessionId: "original" });
      await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(run));
      await operation.bindToolAuthorityRouteAsync({
        provider: run.run.provider,
        model: run.run.model,
      });
      const overlay: ReplyToolAuthorityOverlay = {
        ...run.run,
        originatingChannel: run.originatingChannel,
        senderIsOwner: true,
        disableTools: false,
        traceAuthorized: false,
      };
      const { session } = await createTestSession();
      const enqueue = vi.spyOn(session.agent, "steer");
      const recorderEntered = createDeferredCore();
      const releaseRecorder = createDeferredCore();
      const policyPrepared = createDeferredCore();
      const releasePolicy = createDeferredCore();
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("original source revoked");
        }
      };
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "steer" },
        resolveInput: async () => {
          recorderEntered.resolve();
          await releaseRecorder.promise;
          return { text: "steer" };
        },
        target: createTestUserTurnTranscriptTarget({
          sessionKey,
          sessionId: "original",
          storePath: database.path,
        }),
      });
      const injection: ReplyBackendMessageInjectionV2 = {
        version: 2,
        isAvailable: () => true,
        queueMessage: (text, options, assertOwner) =>
          session.steer(
            text,
            undefined,
            options?.userTurnTranscriptRecorder,
            undefined,
            undefined,
            undefined,
            () => {
              assertOwner();
              return true;
            },
          ),
        ...(change === "legacy-policy"
          ? {}
          : {
              queueMessageAsync: (async (text, options, preparation) =>
                session.steer(
                  text,
                  undefined,
                  options?.userTurnTranscriptRecorder,
                  undefined,
                  undefined,
                  undefined,
                  () => {
                    preparation.assertCurrent();
                    return true;
                  },
                  undefined,
                  async () => {
                    await preparation.prepareCurrent();
                    if (change === "worker-revoked") {
                      policyPrepared.resolve();
                      await releasePolicy.promise;
                    }
                  },
                )) satisfies NonNullable<ReplyBackendMessageInjectionV2["queueMessageAsync"]>,
            }),
      };
      operation.attachBackend({
        kind: "embedded",
        cancel: () => {},
        toolAuthorityFingerprint: operation.toolAuthorityFingerprint,
        messageInjectionV2: injection,
      });
      operation.setPhase("running");
      const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(sessionKey)!;
      const peer = new DatabaseSync(database.path);
      try {
        const attempt = await beginReplyMessageInjectionTarget(target, "steer", {
          isInboundUserMessage: true,
          toolAuthorityOverlay: overlay,
          userTurnTranscriptRecorder: recorder,
          assertCurrent,
        });
        await awaitGateBeforeSettlement(
          recorderEntered.promise,
          attempt.outcome,
          "Steering settled before recorder preparation",
        );
        if (change !== "worker-revoked") {
          peer
            .prepare(
              "UPDATE session_nodes SET entry_json = json_remove(entry_json, '$.sandboxMode') WHERE session_key = ?",
            )
            .run(sessionKey);
        }
        releaseRecorder.resolve();
        if (change === "worker-revoked") {
          await awaitGateBeforeSettlement(
            policyPrepared.promise,
            attempt.outcome,
            "Steering settled before policy preparation",
          );
          current = false;
          releasePolicy.resolve();
        }
        await expect(attempt.outcome).resolves.toMatchObject({ status: "failed" });
        expect(enqueue).not.toHaveBeenCalled();
      } finally {
        releaseRecorder.resolve();
        releasePolicy.resolve();
        peer.close();
        operation.complete();
      }
    });
  },
);
