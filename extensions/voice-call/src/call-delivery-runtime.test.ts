import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createCallDeliveryRuntime } from "./call-delivery-runtime.js";
import { VoiceCallConfigSchema } from "./config.js";
import { createManagerHarness } from "./manager.test-harness.js";

// Gateway delivery and shutdown are exercised at the production plugin adapter boundary.
describe("call delivery runtime", () => {
  async function setup(
    options: {
      holdRoute?: boolean;
      route?: boolean;
      summaryFails?: boolean;
      webchat?: boolean;
    } = {},
  ) {
    const actor = new AsyncLocalStorage<string>();
    const serviceContext = actor.run("service", () => AsyncLocalStorage.snapshot());
    const { manager, storePath } = await createManagerHarness({ agentId: "owner" });
    const requester = {
      agentId: "owner",
      sessionId: "requester-session",
      sessionKey: "agent:owner:telegram:direct:42",
      storePath: path.join(storePath, "requester", "sessions.json"),
    };
    if (options.webchat) {
      await upsertSessionEntry({
        ...requester,
        entry: { sessionId: requester.sessionId, updatedAt: Date.now() },
      });
      onTestFinished(() => closeOpenClawAgentDatabasesAsync());
    }
    const coreConfig = {
      agents: { list: [{ id: "owner", default: true }] },
      session: { store: requester.storePath },
    };
    const config = VoiceCallConfigSchema.parse({
      reports: { enabled: true, summaryModel: "provider/summary" },
      ...(options.webchat ? { live: { transcript: true } } : {}),
    });
    const route = createDeferred<void>();
    const enteredRoute = createDeferred<void>();
    const sends: Record<string, unknown>[] = [];

    const request: PluginRuntime["gateway"]["request"] = async <T>(
      method: string,
      params?: Record<string, unknown>,
    ) => {
      expect(actor.getStore()).toBe("service");
      if (method === "sessions.describe") {
        enteredRoute.resolve();
        if (options.holdRoute) {
          await route.promise;
        }
        return {
          session:
            options.route === false
              ? null
              : options.webchat
                ? {
                    key: requester.sessionKey,
                    sessionId: requester.sessionId,
                    lastChannel: "webchat",
                  }
                : {
                    deliveryContext: {
                      channel: "telegram",
                      to: "42",
                      accountId: "personal",
                      threadId: "7",
                    },
                  },
        } as T;
      }
      expect(method).toBe("send");
      sends.push(params!);
      return { ok: true } as T;
    };
    const complete = vi.fn(
      async (_params: Parameters<PluginRuntime["subagent"]["complete"]>[0]) => {
        expect(actor.getStore()).toBe("service");
        if (options.summaryFails) {
          throw new Error("summary unavailable");
        }
        return { text: "Achieved: appointment booked Friday at 09:00." };
      },
    );
    const delivery = createCallDeliveryRuntime({
      config,
      coreConfig,
      runtime: { gateway: { request, isAvailable: async () => true }, subagent: { complete } },
      manager,
      runInServiceContext: (run) => serviceContext(run),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    const result = await manager.initiateCall("+15550000001", "call-session", {
      requesterSessionKey: "agent:owner:telegram:direct:42",
    });
    const call = expectDefined(manager.getCall(result.callId), "initiated call");
    call.metadata = {
      ...call.metadata,
      brief: { task: "Book a plumber", approvals: "No deposit" },
    };
    await manager.processEvent({
      id: "final",
      callId: call.callId,
      timestamp: Date.now(),
      type: "call.speech",
      transcript: "Friday 09:00. " + "Full transcript. ".repeat(600),
      isFinal: true,
    });
    await actor.run("ending-caller", () =>
      manager.processEvent({
        id: "ended",
        callId: call.callId,
        timestamp: Date.now(),
        type: "call.ended",
        reason: "hangup-user",
      }),
    );
    return { manager, call, delivery, sends, complete, route, enteredRoute, requester };
  }

  it("reports a manually ended call under service authority and delivers all transcript chunks", async () => {
    const { manager, call, delivery, sends, complete } = await setup();
    await manager.onCallUpdated?.(call);
    expect(complete).toHaveBeenCalledOnce();
    const params = expectDefined(complete.mock.calls[0], "call summary request")[0];
    expect(params).toMatchObject({ agentId: "owner", model: "provider/summary" });
    expect(params.message).toContain("Book a plumber");
    expect(params.message).toContain("Friday 09:00");
    expect(params).not.toHaveProperty("sessionKey");
    expect(params.extraSystemPrompt).toContain("untrusted");
    expect(sends.length).toBeGreaterThan(1);
    expect(
      sends.every((send) => typeof send.message === "string" && send.message.length <= 4000),
    ).toBe(true);
    expect(sends[0]).toMatchObject({
      channel: "telegram",
      to: "42",
      accountId: "personal",
      threadId: "7",
      sessionKey: "agent:owner:telegram:direct:42",
    });
    expect(sends.map((send) => send.message).join("")).toContain(
      expectDefined(call.transcript[0], "final call transcript").text,
    );
    expect(new Set(sends.map((send) => send.idempotencyKey)).size).toBe(sends.length);
    await delivery.stop();
  });

  it("persists live batches and reports in the requester transcript without admin scope or another agent turn", async () => {
    const { manager, call, delivery, sends, requester } = await setup({ webchat: true });
    await manager.onCallUpdated?.(call);
    expect(sends).toEqual([]);
    const entries = await readVisibleSessionTranscriptMessageEntries(requester);
    expect(entries.length).toBeGreaterThan(1);
    expect(entries.every(({ message }) => message.role === "assistant")).toBe(true);
    const text = entries
      .flatMap(({ message }) => (message.role === "assistant" ? message.content : []))
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    expect(text).toContain("live transcript:");
    expect(text).toContain("Achieved: appointment booked");
    expect(text).toContain(expectDefined(call.transcript[0], "final call transcript").text);
    expect(
      (await manager.getCallFromMemoryOrStore(call.callId))?.metadata?.callReport,
    ).toMatchObject({ status: "delivered" });
    await delivery.stop();
  });

  it("revokes delayed route work before send and waits for its settlement", async () => {
    const { manager, call, delivery, sends, route, enteredRoute } = await setup({
      holdRoute: true,
    });
    await enteredRoute.promise;
    let stopped = false;
    const stopping = delivery.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    route.resolve();
    await stopping;
    expect(sends).toEqual([]);
    expect(
      (await manager.getCallFromMemoryOrStore(call.callId))?.metadata?.callReport,
    ).toMatchObject({ status: "failed" });
  });

  it("records a missing requester route instead of sending to an account default", async () => {
    const { manager, call, delivery, sends } = await setup({ route: false });
    await manager.onCallUpdated?.(call);
    expect(sends).toEqual([]);
    expect(
      (await manager.getCallFromMemoryOrStore(call.callId))?.metadata?.callReport,
    ).toMatchObject({ status: "failed" });
    await delivery.stop();
  });

  it("delivers the factual report and transcript when summary generation fails", async () => {
    const { manager, call, delivery, sends } = await setup({ summaryFails: true });
    await manager.onCallUpdated?.(call);
    expect(sends.map((send) => send.message).join("")).toContain("Summary unavailable");
    expect(
      (await manager.getCallFromMemoryOrStore(call.callId))?.metadata?.callReport,
    ).toMatchObject({ status: "delivered", summaryError: "summary unavailable" });
    await delivery.stop();
  });
});
