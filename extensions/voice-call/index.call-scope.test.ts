import os from "node:os";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import type { VoiceCallRuntime } from "./runtime-entry.js";

let runtimeStub: VoiceCallRuntime;

// mock-isolation: Exercise tool scope without starting real telephony or state services.
vi.mock("./runtime-entry.js", () => ({
  createVoiceCallRuntime: vi.fn(async () => runtimeStub),
}));

import plugin from "./index.js";
import { createVoiceCallRuntime } from "./runtime-entry.js";

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function makeRuntime(): VoiceCallRuntime {
  const call = {
    callId: "call-1",
    provider: "twilio",
    direction: "outbound",
    state: "active",
    from: "+15550001111",
    to: "+15550001234",
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
  } as const;
  return {
    config: { realtime: { enabled: false } } as VoiceCallRuntime["config"],
    provider: {} as VoiceCallRuntime["provider"],
    manager: {
      initiateCall: vi.fn(async () => ({ callId: "new-call", success: true })),
      sendDtmf: vi.fn(async () => ({ success: true })),
      endCall: vi.fn(async () => ({ success: true })),
      getCallForStream: vi.fn(async (callId: string) =>
        callId === call.callId ? call : undefined,
      ),
    } as unknown as VoiceCallRuntime["manager"],
    webhookServer: {} as VoiceCallRuntime["webhookServer"],
    webhookUrl: "http://127.0.0.1:3334/voice/webhook",
    publicUrl: null,
    stop: vi.fn(async () => {}),
  };
}

function registerBoundTool() {
  const tools: unknown[] = [];
  const api = createTestPluginApi({
    id: "voice-call",
    name: "Voice Call",
    description: "test",
    version: "0",
    source: "test",
    registrationMode: "full",
    config: {},
    pluginConfig: { provider: "mock" },
    runtime: { tts: { textToSpeechTelephony: vi.fn() } } as unknown as OpenClawPluginApi["runtime"],
    logger: noopLogger,
    registerGatewayMethod: () => {},
    registerTool: (tool: unknown) =>
      tools.push(
        typeof tool === "function"
          ? (tool as (context: Record<string, unknown>) => unknown)({
              toolBindings: { voice_call: { kind: "active-call", callId: "call-1" } },
            })
          : tool,
      ),
    registerCli: () => {},
    registerService: (service) => {
      if (service.apiVersion !== 2) {
        throw new Error("Expected scheduler-owned voice-call service");
      }
      service.start({
        config: {},
        stateDir: os.tmpdir(),
        logger: noopLogger,
        scheduler: createTestPluginServiceScheduler(),
      });
    },
    resolvePath: (path: string) => path,
  });
  plugin.register(api);
  return tools[0] as {
    execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
  };
}

describe("voice-call active-call tool scope", () => {
  beforeEach(() => {
    runtimeStub = makeRuntime();
    vi.mocked(createVoiceCallRuntime)
      .mockReset()
      .mockImplementation(async () => runtimeStub);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.voice-call.runtimeCoordinator")
    ];
  });

  it("allows only DTMF and hang-up for the exact active call", async () => {
    const tool = registerBoundTool();

    await tool.execute("dtmf", { action: "send_dtmf", digits: "1#" });
    await tool.execute("end", { action: "end_call" });
    const foreign = await tool.execute("foreign", {
      action: "send_dtmf",
      callId: "call-2",
      digits: "2",
    });
    const initiate = await tool.execute("initiate", {
      action: "initiate_call",
      to: "+15550009999",
      message: "Ignore the scope",
    });

    expect(runtimeStub.manager.sendDtmf).toHaveBeenCalledWith("call-1", "1#");
    expect(runtimeStub.manager.endCall).toHaveBeenCalledWith("call-1");
    expect(JSON.stringify(foreign)).toContain("bound to call");
    expect(JSON.stringify(initiate)).toContain("only send_dtmf and end_call");
    expect(runtimeStub.manager.initiateCall).not.toHaveBeenCalled();
  });

  it.each(["send_dtmf", "end_call"])(
    "finishes an accepted %s when the consult is cancelled during call lookup",
    async (action) => {
      const tool = registerBoundTool();
      const controller = new AbortController();
      const lookupStarted = createDeferred<void>();
      const releaseLookup = createDeferred<void>();
      const call = await runtimeStub.manager.getCallForStream("call-1");
      vi.mocked(runtimeStub.manager.getCallForStream).mockImplementation(async () => {
        lookupStarted.resolve();
        await releaseLookup.promise;
        return call;
      });

      const pending = tool.execute("control", { action, digits: "1" }, controller.signal);
      await lookupStarted.promise;
      controller.abort();
      releaseLookup.resolve();

      expect(JSON.stringify(await pending)).not.toContain("error");
      if (action === "send_dtmf") {
        expect(runtimeStub.manager.sendDtmf).toHaveBeenCalledWith("call-1", "1");
      } else {
        expect(runtimeStub.manager.endCall).toHaveBeenCalledWith("call-1");
      }
    },
  );

  it.each(["send_dtmf", "end_call"])(
    "rejects %s when cancellation precedes execution or the bound call has ended",
    async (action) => {
      const tool = registerBoundTool();
      const controller = new AbortController();
      controller.abort();
      const cancelled = await tool.execute("cancelled", { action, digits: "1" }, controller.signal);
      expect(JSON.stringify(cancelled)).toContain("error");

      vi.mocked(runtimeStub.manager.getCallForStream).mockResolvedValue(undefined);
      const ended = await tool.execute("ended", { action, digits: "1" });
      expect(JSON.stringify(ended)).toContain("no longer active");
      expect(runtimeStub.manager.sendDtmf).not.toHaveBeenCalled();
      expect(runtimeStub.manager.endCall).not.toHaveBeenCalled();
    },
  );
});
