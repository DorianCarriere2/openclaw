import { describe, expect, it, vi } from "vitest";
import { createVoiceCallCommandService } from "./command-service.js";
import type { VoiceCallRuntime } from "./runtime.js";
import type { CallRecord } from "./types.js";

function makeRuntime(
  sendDtmfRealtime: () => {
    success: boolean;
    error?: string;
    streamActive?: boolean;
  },
) {
  const managerSendDtmf = vi.fn(async () => ({ success: true }));
  const runtime = {
    config: { realtime: { enabled: true } },
    manager: {
      sendDtmf: managerSendDtmf,
    },
    webhookServer: {
      getRealtimeHandler: () => ({ sendDtmf: sendDtmfRealtime }),
    },
  } as unknown as VoiceCallRuntime;
  return { managerSendDtmf, runtime };
}

describe("voice call command service realtime control", () => {
  it("binds steering to the requester and active call, and keeps guidance for consults", async () => {
    const call: CallRecord = {
      callId: "call-1",
      provider: "mock",
      direction: "outbound",
      state: "active",
      from: "+15550001111",
      to: "+15550002222",
      startedAt: 0,
      transcript: [],
      processedEventIds: [],
      metadata: { requesterSessionKey: "agent:main:owner" },
    };
    const speakRealtime = vi.fn(() => ({ success: true }));
    let currentAuthority = true;
    const updateCallMetadata = vi.fn(async (_call, update, options) => {
      options?.beforeCommit?.();
      call.metadata = update(call.metadata);
    });
    const runtime = {
      config: { realtime: { enabled: true } },
      manager: {
        getCall: (id: string) => (id === call.callId ? call : undefined),
        updateCallMetadata,
      },
      webhookServer: { speakRealtime },
    } as unknown as VoiceCallRuntime;
    const commands = createVoiceCallCommandService(async () => runtime);
    await expect(
      commands.steer({
        callId: "call-1",
        message: "Ask for Tuesday",
        requesterSessionKey: "agent:main:stranger",
      }),
    ).rejects.toThrow("requester");
    await expect(
      commands.steer({
        callId: "call-2",
        message: "Ask for Tuesday",
        requesterSessionKey: "agent:main:owner",
      }),
    ).rejects.toThrow("active");
    expect(speakRealtime).not.toHaveBeenCalled();
    await expect(
      commands.steer({
        callId: "call-1",
        message: "Ask for Tuesday",
        requesterSessionKey: "agent:main:owner",
        mode: "guidance",
      }),
    ).resolves.toEqual({ success: true });
    expect(call.metadata?.ownerInstructions).toEqual(["Ask for Tuesday"]);
    expect(speakRealtime).toHaveBeenCalledWith(
      "call-1",
      expect.stringContaining("Ask for Tuesday"),
    );
    updateCallMetadata.mockImplementationOnce(async (_call, update, options) => {
      currentAuthority = false;
      options?.beforeCommit?.();
      call.metadata = update(call.metadata);
    });
    await expect(
      commands.steer({
        callId: "call-1",
        message: "Make an unauthorized commitment",
        operator: true,
        assertCurrent: () => {
          if (!currentAuthority) {
            throw new Error("Caller authority expired");
          }
        },
      }),
    ).rejects.toThrow("Caller authority expired");
    expect(call.metadata?.ownerInstructions).toEqual(["Ask for Tuesday"]);
    call.state = "completed";
    await expect(
      commands.steer({ callId: "call-1", message: "Too late", operator: true }),
    ).rejects.toThrow("active");
    expect(speakRealtime).toHaveBeenCalledTimes(1);
  });

  it("does not replace an active realtime stream when DTMF delivery fails", async () => {
    const fixture = makeRuntime(() => ({
      success: false,
      error: "paced audio queue exceeded",
      streamActive: true,
    }));
    const commands = createVoiceCallCommandService(async () => fixture.runtime);

    await expect(commands.sendDtmf("call-1", "1#")).rejects.toThrow("paced audio queue exceeded");
    expect(fixture.managerSendDtmf).not.toHaveBeenCalled();
  });

  it("uses carrier DTMF only when no realtime stream owns the call", async () => {
    const fixture = makeRuntime(() => ({ success: false, streamActive: false }));
    const commands = createVoiceCallCommandService(async () => fixture.runtime);

    await expect(commands.sendDtmf("call-1", "12")).resolves.toEqual({ success: true });
    expect(fixture.managerSendDtmf).toHaveBeenCalledWith("call-1", "12");
  });
});
