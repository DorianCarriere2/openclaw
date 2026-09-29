import { describe, expect, it, vi } from "vitest";
import { createVoiceCallCommandService } from "./command-service.js";
import type { VoiceCallRuntime } from "./runtime.js";

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
