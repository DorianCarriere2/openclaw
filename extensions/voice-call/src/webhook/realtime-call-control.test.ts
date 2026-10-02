import type http from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceToolCallEvent,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import { createVoiceCallCommandService } from "../command-service.js";
import type { VoiceCallRuntime } from "../runtime.js";
import { resolveActiveVoiceCallToolScope } from "../tool-call-scope.js";
import type { CallRecord } from "../types.js";
import { connectWs, startUpgradeWsServer, waitForClose } from "../websocket-test-support.js";
import { makeCall, makeBridge, makeHandler } from "./realtime-call-control.test-helpers.js";
import { RealtimeCallHandler } from "./realtime-handler.js";

type RealtimeBridgeRequest = Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0];

afterEach(() => {
  vi.useRealTimers();
});

function parseMessage(data: RawData): Record<string, unknown> {
  const bytes = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
  return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
}

async function openCall(params: {
  call: CallRecord;
  handler: RealtimeCallHandler;
  providerCallId: string;
}) {
  const stream = params.handler.issueStreamSession({
    providerName: "twilio",
    callId: params.call.callId,
    direction: params.call.direction,
  });
  const server = await startUpgradeWsServer({
    urlPath: new URL(stream.streamUrl).pathname,
    onUpgrade: (request: http.IncomingMessage, socket, head) => {
      params.handler.handleWebSocketUpgrade(request, socket, head);
    },
  });
  const ws = await connectWs(server.url);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  ws.send(
    JSON.stringify({
      event: "start",
      start: { streamSid: `MZ-${params.providerCallId}`, callSid: params.providerCallId },
    }),
  );
  return { server, ws };
}

async function closeCall(
  handler: RealtimeCallHandler,
  server: { close: () => Promise<void> },
  ws: WebSocket,
) {
  if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
    const closed = waitForClose(ws);
    ws.close();
    await closed;
  }
  await handler.close();
  await server.close();
}

describe("realtime call control over the Twilio stream", () => {
  it("retires the realtime producer without ending a call before carrier playback", async () => {
    const providerCallId = "CA-carrier-playback";
    const call = makeCall(providerCallId);
    const created = createDeferred<void>();
    const close = vi.fn();
    const { handler, manager } = makeHandler({
      call,
      createBridge: () => {
        created.resolve();
        return makeBridge({ close });
      },
    });
    const { server, ws } = await openCall({ call, handler, providerCallId });
    try {
      await created.promise;
      await handler.prepareCarrierPlayback(call.callId);
      expect(close).toHaveBeenCalledOnce();
      expect(handler.speak(call.callId, "Too late")).toMatchObject({ success: false });
      expect(manager.processEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "call.ended" }),
      );
    } finally {
      await closeCall(handler, server, ws);
    }
  });

  it("abandons a pending realtime admission when carrier voicemail takes ownership", async () => {
    const providerCallId = "CA-pending-playback";
    const call = makeCall(providerCallId);
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const createBridge = vi.fn(() => makeBridge());
    const { handler, manager } = makeHandler({ call, createBridge });
    manager.updateCallMetadata = vi.fn(async (record, update) => {
      entered.resolve();
      await release.promise;
      record.metadata = update(record.metadata);
    });
    const { server, ws } = await openCall({ call, handler, providerCallId });
    try {
      await entered.promise;
      call.metadata = { ...call.metadata, voicemailStatus: "pending" };
      await handler.prepareCarrierPlayback(call.callId);
      const closed = waitForClose(ws);
      release.resolve();
      await closed;
      expect(createBridge).not.toHaveBeenCalled();
      expect(manager.endCall).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await closeCall(handler, server, ws);
    }
  });

  it("finishes accepted DTMF on the active stream after its consult is cancelled", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    const call = makeCall("CA-dtmf");
    const createBridge = vi.fn(() => makeBridge());
    const { handler, manager } = makeHandler({ call, createBridge });
    const { server, ws } = await openCall({ call, handler, providerCallId: "CA-dtmf" });
    ws.on("message", (data) => outbound.push(parseMessage(data)));

    try {
      await vi.waitFor(() => expect(createBridge).toHaveBeenCalledOnce());
      vi.useFakeTimers();
      const runtime = {
        config: { realtime: { enabled: true } },
        manager,
        webhookServer: { getRealtimeHandler: () => handler },
      } as unknown as VoiceCallRuntime;
      const commands = createVoiceCallCommandService(async () => runtime);
      const activeCall = createDeferred<CallRecord>();
      vi.mocked(manager.getCallForStream).mockReturnValueOnce(activeCall.promise);
      const consult = new AbortController();
      const pendingScope = resolveActiveVoiceCallToolScope({
        action: "send_dtmf",
        binding: { kind: "active-call", callId: call.callId },
        requestedCallId: undefined,
        runtime,
        signal: consult.signal,
      });
      consult.abort(new Error("Consult cancelled"));
      activeCall.resolve(call);
      const scope = await pendingScope;
      expect(scope).toBeDefined();
      await expect(commands.sendDtmf(scope?.callId, "1#", scope?.execution)).resolves.toEqual({
        success: true,
      });
      await vi.advanceTimersByTimeAsync(600);
      const clearIndex = outbound.findIndex((message) => message.event === "clear");
      const media = outbound.filter((message) => message.event === "media");
      expect(clearIndex).toBeGreaterThanOrEqual(0);
      expect(outbound.findIndex((message) => message.event === "media")).toBeGreaterThan(
        clearIndex,
      );
      expect(outbound.some((message) => message.event === "mark")).toBe(true);
      expect(
        Buffer.concat(
          media.map((message) =>
            Buffer.from((message.media as { payload?: string })?.payload ?? "", "base64"),
          ),
        ).length,
      ).toBe(2 * 960 + 800);
    } finally {
      vi.useRealTimers();
      await closeCall(handler, server, ws);
    }
  });

  it("keeps a native consult running when far-side speech arrives without model playback", async () => {
    let callbacks: RealtimeBridgeRequest | undefined;
    const receivedAudio = createDeferred<void>();
    const consultStarted = createDeferred<AbortSignal | undefined>();
    const consultResult = createDeferred<{ text: string }>();
    const handleBargeIn = vi.fn();
    const call = makeCall("CA-silent-consult");
    let inputFrames = 0;
    const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
      callbacks = request;
      return makeBridge({
        handleBargeIn,
        sendAudio: () => {
          if (++inputFrames === 4) {
            receivedAudio.resolve();
          }
        },
      });
    });
    const { handler } = makeHandler({ call, createBridge, nativeConsult: true });
    handler.registerToolHandler("openclaw_agent_consult", (_args, _callId, context) => {
      consultStarted.resolve(context?.abortSignal);
      return consultResult.promise;
    });
    const { server, ws } = await openCall({ call, handler, providerCallId: "CA-silent-consult" });
    try {
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      vi.useFakeTimers();
      const pending = callbacks?.runAgentConsult?.({ prompt: "Press one for reservations" });
      const signal = await consultStarted.promise;
      for (let i = 0; i < 4; i += 1) {
        ws.send(
          JSON.stringify({
            event: "media",
            media: { payload: Buffer.alloc(160, 0x00).toString("base64") },
          }),
        );
      }
      await receivedAudio.promise;
      expect(handleBargeIn).not.toHaveBeenCalled();
      expect(signal?.aborted).toBe(false);
      consultResult.resolve({ text: "Pressed one" });
      await expect(pending).resolves.toEqual({ text: "Pressed one" });
    } finally {
      consultResult.resolve({ text: "Finished" });
      vi.useRealTimers();
      await closeCall(handler, server, ws);
    }
  });

  it("pauses speech-idle hang-up while an agent consult is in flight", async () => {
    let callbacks: RealtimeBridgeRequest | undefined;
    const endCall = vi.fn(async () => ({ success: true }));
    const call = makeCall("CA-idle");
    const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
      callbacks = request;
      return makeBridge();
    });
    const { handler } = makeHandler({ call, createBridge, endCall, idleHangupMs: 1_000 });
    const { server, ws } = await openCall({ call, handler, providerCallId: "CA-idle" });

    try {
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      const consulted = createDeferred<{ text: string }>();
      handler.registerToolHandler("openclaw_agent_consult", () => consulted.promise);
      vi.useFakeTimers();
      callbacks?.onEvent?.({ direction: "server", type: "input_audio_buffer.speech_started" });
      const pending = callbacks?.onToolCall?.({
        itemId: "consult-idle",
        callId: "consult-idle",
        name: "openclaw_agent_consult",
        args: { question: "Check it" },
      } satisfies RealtimeVoiceToolCallEvent);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(endCall).not.toHaveBeenCalled();
      consulted.resolve({ text: "Done" });
      await pending;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(endCall).toHaveBeenCalledWith("call-1", { reason: "timeout" });
    } finally {
      vi.useRealTimers();
      await closeCall(handler, server, ws);
    }
  });

  it("waits for outbound speech and cancels the independent greeting fallback", async () => {
    let callbacks: RealtimeBridgeRequest | undefined;
    const triggerGreeting = vi.fn();
    const opening = "Buenas tardes. ¿A qué hora cierran hoy?";
    const call = makeCall("CA-opening", {
      direction: "outbound",
      metadata: { initialMessage: opening },
    });
    const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
      callbacks = request;
      return makeBridge({ triggerGreeting });
    });
    const { handler } = makeHandler({ call, createBridge, nativeConsult: true });
    const { server, ws } = await openCall({ call, handler, providerCallId: "CA-opening" });

    try {
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      expect(createBridge.mock.calls[0]?.[0].instructions).toContain(
        `Answer: ${JSON.stringify(opening)}`,
      );
      vi.useFakeTimers();
      callbacks?.onReady?.();
      callbacks?.onEvent?.({ direction: "server", type: "input_audio_buffer.speech_started" });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(triggerGreeting).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await closeCall(handler, server, ws);
    }
  });
});
