/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivityItem } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ToolCard } from "../../lib/chat/chat-types.ts";
import { resolveSpawnedSubagent, spawnedSubagentsRenderKey } from "./chat-spawned-subagent.ts";
import { selectActivityHeadline } from "./components/chat-activity-headline.ts";
import { renderToolCard } from "./components/chat-tool-cards.ts";

const parentKey = "agent:main:dashboard:11111111-1111-4111-8111-111111111111";
const label = "Write a six-line robot story";

function child(id: string, extra: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key: `agent:main:subagent:${id}`,
    sessionId: id,
    kind: "direct",
    label,
    spawnedBy: parentKey,
    parentSessionKey: parentKey,
    status: "done",
    hasActiveRun: false,
    activeRunIds: [],
    runtimeMs: 42_000,
    updatedAt: 1,
    ...extra,
  };
}

function launch(extra: Partial<ToolCard> = {}): ToolCard {
  return {
    id: "spawn",
    callId: "spawn",
    name: "sessions_spawn",
    args: {
      label,
      taskName: "demo-mini-story",
      task: "Write the story. Reply with the result only.",
      runTimeoutSeconds: 180,
    },
    completed: true,
    ...extra,
  };
}

const accepted = (key: string) =>
  JSON.stringify({ status: "accepted", childSessionKey: key, runId: "child-run" }, null, 2);

describe("a launched subagent", () => {
  const story = child("story");
  const running = { status: "running", hasActiveRun: true } satisfies Partial<GatewaySessionRow>;

  it("is named by its launch and finds its session from the result", () => {
    const finished = { key: story.key, running: false, runtimeMs: 42_000 };
    const roster = [child("other", { label: "Other" }), story];
    // History keeps the result as text; a live result still carries details.
    for (const result of [
      { outputText: accepted(story.key) },
      { details: { status: "accepted", childSessionKey: story.key } },
    ]) {
      expect(resolveSpawnedSubagent(launch(result), roster)).toEqual({ label, session: finished });
    }
    // Still at work, including while it waits on subagents of its own.
    for (const active of [running, { hasActiveSubagentRun: true }]) {
      expect(
        resolveSpawnedSubagent(launch({ outputText: accepted(story.key) }), [
          { ...story, ...active },
        ])?.session,
      ).toEqual({ key: story.key, running: true, runtimeMs: null });
    }
  });

  it("never borrows a session from its name alone", () => {
    // In flight, refused, or naming a session the roster does not hold: the
    // one child carrying the same label is an earlier launch or a retry.
    for (const result of [
      {},
      { outputText: JSON.stringify({ status: "error", error: "cwd is outside the workspace" }) },
      { outputText: accepted("agent:main:subagent:gone") },
    ]) {
      expect(resolveSpawnedSubagent(launch(result), [story])).toEqual({ label });
    }
  });

  it("stays a generic row without a label", () => {
    const unlabeled = { taskName: "demo-mini-story", task: "Write the story." };
    expect(resolveSpawnedSubagent(launch({ args: unlabeled }), [story])).toBeNull();
    expect(resolveSpawnedSubagent({ ...launch(), name: "exec" }, [story])).toBeNull();
  });

  it("repaints launch rows when a subagent starts or finishes, not when the roster reorders", () => {
    const puzzle = child("puzzle", { label: "Solve a tiny logic puzzle", ...running });
    const key = spawnedSubagentsRenderKey([story, puzzle]);
    // Activity patches move rows and touch fields no launch row draws.
    expect(spawnedSubagentsRenderKey([{ ...puzzle, updatedAt: 9 }, story])).toBe(key);
    expect(
      spawnedSubagentsRenderKey([story, { ...puzzle, status: "done", hasActiveRun: false }]),
    ).not.toBe(key);
    expect(spawnedSubagentsRenderKey([{ ...story, ...running }, puzzle])).not.toBe(key);
  });

  it("shows its name and duration, and opens its session without toggling the row", () => {
    const onOpenSession = vi.fn();
    const onToggleExpanded = vi.fn();
    const mount = (subagentSessions: GatewaySessionRow[]) => {
      const container = document.createElement("div");
      render(
        renderToolCard(launch({ outputText: accepted(story.key) }), {
          messageKey: "message",
          expanded: false,
          onToggleExpanded,
          subagents: { subagentSessions, onOpenSession },
        }),
        container,
      );
      return container;
    };
    const row = mount([story]);
    const link = row.querySelector<HTMLButtonElement>(".chat-tool-row__subagent-link")!;
    expect(link.textContent?.trim()).toBe(label);
    expect(row.querySelector(".chat-tool-row__subagent-state")?.textContent).toBe("42s");
    // The assignment and launch settings are detail, not the row's text.
    expect(row.querySelector(".chat-tool-disclosure__content")?.textContent).not.toMatch(
      /Reply with the result|demo-mini-story|180/u,
    );
    link.click();
    expect(onOpenSession).toHaveBeenCalledExactlyOnceWith(story.key);
    expect(onToggleExpanded).not.toHaveBeenCalled();
    row
      .querySelector<HTMLButtonElement>(".chat-tool-row--subagent > .chat-tool-row__toggle")!
      .click();
    expect(onToggleExpanded).toHaveBeenCalledOnce();

    expect(
      mount([{ ...story, ...running }]).querySelector(".chat-tool-row__subagent-state")
        ?.textContent,
    ).toBe("running");
    // Without its session the row is the ordinary disclosure, still named.
    const unlinked = mount([]);
    expect(unlinked.querySelector(".chat-tool-row__subagent-link")).toBeNull();
    expect(unlinked.querySelector("button.chat-tool-row .chat-tool-row__title")?.textContent).toBe(
      label,
    );
    expect(unlinked.querySelector(".chat-tool-row__subagent-state")).toBeNull();
  });

  it("names the live headline instead of listing its launch settings", () => {
    const card = launch();
    const item: AgentActivityItem = {
      itemId: "tool:spawn",
      toolCallId: "spawn",
      kind: "tool",
      phase: "end",
      status: "completed",
      name: "sessions_spawn",
      title: `Sub-agent label ${label}, task name demo-mini-story, timeout 180`,
      meta: `label ${label}, task name demo-mini-story, timeout 180`,
    };
    expect(
      selectActivityHeadline([item], [{ card, children: [] }], new Map([[card, item]])),
    ).toMatchObject({ title: label, name: "sessions_spawn" });
  });
});
