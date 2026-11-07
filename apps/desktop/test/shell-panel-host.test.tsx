import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createSessionView, type BackgroundShellTask } from "@nocturne/core/protocol";
import { useSidePanel } from "../src/PanelHost";
import { TitlebarSlot } from "../src/PanelChrome";
import { createPrefsStore } from "../src/prefs";
import type { OpenConversation } from "../src/conversations";
import type { DesktopHost } from "../src/host";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
it("overview opens one shell output tab per task, persists it and closing never kills the task", async () => {
  const task: BackgroundShellTask = {
    taskId: "task",
    callId: "call",
    name: "fixture",
    command: "node fixture",
    logPath: "/log",
    outputChars: 3,
    status: "running",
    startedAt: new Date().toISOString(),
  };
  const view = createSessionView();
  view.backgroundShells = [task];
  const shellKill = vi.fn(async () => undefined);
  const active = {
    session: {
      id: "parent",
      fileIndex: async () => [],
      shellOutput: async () => ({ task, text: "one", start: 0, end: 3, durationMs: 0 }),
      shellKill,
    },
    workspace: "Z:/test",
    view,
    turnChanges: new Map(),
  } as unknown as OpenConversation;
  const prefs = createPrefsStore(localStorage);
  prefs.update({ overviewOpen: true });
  const host = {
    openPath: vi.fn(),
    openUrl: vi.fn(),
    revealItem: vi.fn(),
    openInEditor: vi.fn(),
  } as unknown as DesktopHost;
  function Panel() {
    const panel = useSidePanel({
      prefs,
      host,
      sessionId: "parent",
      active,
      sessionCwd: undefined,
      sessions: [{ id: "parent", mtimeMs: 1 }],
      openIds: new Set(["parent"]),
      loadDiff: vi.fn(),
      editors: { vscode: false, cursor: false },
      settingsOpen: false,
      plainKey: null,
      client: undefined,
      ensureClient: () => Promise.reject(new Error("not required")),
    });
    return (
      <div className="body" ref={panel.bodyRef}>
        <nav className="sidebar" />
        <main className={`mainpane${panel.mainClass}`} />
        {panel.mainOverlays}
        {panel.panel}
      </div>
    );
  }
  function Harness() {
    const [slot, setSlot] = useState<HTMLElement | null>(null);
    return (
      <>
        <div ref={setSlot} />
        <TitlebarSlot.Provider value={slot}>
          <Panel />
        </TitlebarSlot.Provider>
      </>
    );
  }
  render(<Harness />);
  const row = screen.getByRole("button", { name: /fixture/ });
  fireEvent.click(row);
  await waitFor(() => expect(screen.getByTestId("shell-output").textContent).toBe("one"));
  fireEvent.click(row);
  expect(screen.getAllByRole("tab", { name: /fixture/ })).toHaveLength(1);
  expect(prefs.get().panelSessions?.parent?.tabs?.some((tab) => tab.kind === "shell")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "关闭 fixture" }));
  expect(screen.queryByRole("tab", { name: /fixture/ })).toBeNull();
  expect(shellKill).not.toHaveBeenCalled();
});
