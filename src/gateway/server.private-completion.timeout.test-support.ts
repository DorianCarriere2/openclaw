import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import { resolveAgentRunErrorLifecycleFields } from "../agents/run-termination.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS } from "../sessions/session-lifecycle-admission.js";
import type { UserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.types.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { waitForChatAbortControllerRemoval } from "./chat-abort-lifecycle-internal.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import * as lifecycleState from "./session-lifecycle-state.js";
import type { agentCommandMock as gatewayAgentCommandMock } from "./test-helpers.js";

type PrivateCompletionTimeoutFixture = {
  context: GatewayRequestContext;
  sessionKey: string;
  sessionId: string;
  runId: string;
  recorder: (input: unknown) => UserTurnTranscriptRecorder;
  dispatch: () => Promise<Record<string, unknown>>;
  completions: () => Record<string, unknown>[];
  agentCommandMock: typeof gatewayAgentCommandMock;
};

export function registerPrivateCompletionTimeoutTests(
  getFixture: () => PrivateCompletionTimeoutFixture,
) {
  it.each(["resolved", "rejected", "abandoned"] as const)(
    "preserves executing private timeout facts (%s)",
    async (kind) => {
      const {
        context,
        sessionKey,
        sessionId,
        runId,
        recorder,
        dispatch,
        completions,
        agentCommandMock,
      } = getFixture();
      const consumed = createDeferred<ReturnType<typeof recorder>>();
      const release = createDeferred();
      agentCommandMock.mockImplementationOnce(async (input) => {
        const command = input as AgentCommandOpts;
        const startedAt = Date.now();
        await command.onExecutionStarted?.();
        const inputRecorder = recorder(input);
        await inputRecorder.persistApproved();
        inputRecorder.markSentToProvider?.();
        consumed.resolve(inputRecorder);
        // Hold the producer after abort so lifecycle projection cannot stand
        // in for execution settlement; abandoned work also outlives the grace.
        await release.promise;
        // The real command owns its terminal publication after execution settles.
        emitAgentEvent({
          runId,
          sessionKey,
          sessionId,
          lifecycleGeneration: command.lifecycleGeneration,
          stream: "lifecycle",
          data: {
            phase: kind === "rejected" ? "error" : "end",
            startedAt,
            endedAt: Date.now(),
            executionSettled: true,
            ...resolveAgentRunErrorLifecycleFields(
              command.abortSignal?.reason,
              command.abortSignal,
            ),
            ...(kind !== "rejected" ? { timeoutPhase: "provider", providerStarted: true } : {}),
          },
        });
        if (kind === "rejected") {
          command.abortSignal!.throwIfAborted();
        }
        return {
          payloads: [],
          meta: {
            durationMs: 1,
            aborted: true,
            stopReason: "timeout",
            timeoutPhase: "provider",
            providerStarted: true,
          },
        };
      });
      const first = dispatch();
      const observed = first.then(
        (value) => ({ value }),
        (error: unknown) => ({ error: String(error) }),
      );
      const inputRecorder = await consumed.promise;
      const active = expectDefined(context.chatAbortControllers.get(runId), "executing controller");
      expect(active.executionStarted).toBe(true);
      const releaseTerminalWrite = createDeferred();
      const terminalWriteStarted = createDeferred();
      let terminalWrite: Promise<void> | undefined;
      const persistLifecycle = lifecycleState.persistGatewaySessionLifecycleEvent;
      const delayedTerminalWrite =
        kind === "abandoned"
          ? vi
              .spyOn(lifecycleState, "persistGatewaySessionLifecycleEvent")
              .mockImplementation((params) => {
                if (params.event.runId !== runId) {
                  return persistLifecycle(params);
                }
                terminalWrite = releaseTerminalWrite.promise.then(() => persistLifecycle(params));
                terminalWriteStarted.resolve();
                return terminalWrite;
              })
          : undefined;
      active.expiresAtMs = Date.now() - 1;
      const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
      const { createGatewayMaintenanceStateForTest } =
        await import("./test-helpers.maintenance-state.js");
      const clock = createGatewaySchedulerClock(Date.now());
      const now = vi.spyOn(Date, "now").mockImplementation(clock.clock.now);
      const timers = startGatewayMaintenanceTimers({
        ...createGatewayMaintenanceStateForTest(),
        ...context,
        scheduler: createTestGatewayScheduler(clock.clock),
        logHealth: { info: vi.fn(), error: vi.fn() },
        runWorktreeGc: async () => undefined,
        runDeliveryQueueMediaGc: async () => undefined,
        runManagedOutgoingMediaGc: async () => undefined,
      });
      try {
        await clock.advanceBy(60_000);
        expect(active.controller.signal.aborted).toBe(true);
        expect(active.abortStopReason).toBe("timeout");
        expect(context.chatAbortControllers.get(runId)).toBe(active);
        expect(completions()).toEqual([]);
        expect(active.projectSessionTerminalPersistence).toBeUndefined();
        if (kind === "abandoned") {
          // Timeout receipts settle after grace even while execution ignores abort.
          expect(terminalWrite).toBeUndefined();
          await clock.advanceBy(60_000);
          await awaitGateBeforeSettlement(
            expectDefined(inputRecorder.waitForPendingInputSettlement?.(), "input settlement"),
            expectDefined(active.executionSettlement, "execution settlement").completion,
            "Execution settled before its producer was released",
          );
          expect(context.chatAbortControllers.get(runId)).toBe(active);
          expect(active.executionSettlement?.status).toBe("pending");
          expect(active.projectSessionTerminalPersistence).toBeUndefined();
          expect(JSON.parse(String(completions()[0]?.outcome_json))).toMatchObject({
            reason: "timed_out",
            status: "timeout",
            stopReason: "timeout",
          });
          release.resolve();
          await awaitGateBeforeSettlement(
            terminalWriteStarted.promise,
            observed,
            "Agent response settled before its terminal write started",
          );
          expect(terminalWrite).toBeInstanceOf(Promise);
          expect(active.projectSessionTerminalPersistence).toBeInstanceOf(Promise);
          expect(active.projectSessionTerminalPending).toBe(true);
          expect(context.chatAbortControllers.get(runId)).toBe(active);
        }
      } finally {
        await timers.stopPeriodicTasks();
        await timers.skillUsageCleanup();
        now.mockRestore();
        releaseTerminalWrite.resolve();
        release.resolve();
        try {
          await terminalWrite;
        } finally {
          delayedTerminalWrite?.mockRestore();
        }
      }
      const response = await observed;
      const rows = completions();
      const outcome = JSON.parse(String(rows[0]?.outcome_json));
      expect(response).toMatchObject({ value: { status: "timeout", stopReason: "timeout" } });
      expect(outcome).toMatchObject({ status: "timeout", stopReason: "timeout" });
      expect(
        await waitForChatAbortControllerRemoval({
          entries: context.chatAbortControllers,
          targets: [{ runId, entry: active }],
          timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
        }),
      ).toBe(true);
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      expect(active.projectSessionTerminalPersisted).toBe(true);
      if (kind === "resolved") {
        expect(outcome).toMatchObject({
          reason: "hard_timeout",
          timeoutPhase: "provider",
          providerStarted: true,
        });
        expect(response).toMatchObject({
          value: { timeoutPhase: "provider", providerStarted: true },
        });
      } else {
        expect(outcome.reason).toBe("timed_out");
        expect(outcome.timeoutPhase).toBeUndefined();
        expect(outcome.providerStarted).toBeUndefined();
      }
      context.dedupe.delete(`agent:${runId}`);
      agentCommandMock.mockImplementationOnce(async (input) => {
        await recorder(input).persistApproved();
        return { payloads: [], meta: { durationMs: 1 } };
      });
      expect(await dispatch()).toMatchObject({ status: "ok", inputProcessingCompleted: true });
      expect(agentCommandMock).toHaveBeenCalledTimes(2);
    },
  );
}
