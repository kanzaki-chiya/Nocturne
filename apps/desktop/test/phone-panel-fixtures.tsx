import { useState } from "react";
import { vi } from "vitest";
import {
  createSessionView,
  type BackgroundShellTask,
  type SubagentSummary,
  type SubagentObserver,
} from "@nocturne/core/protocol";
import type { ContextSummary, RpcClient, RpcSession } from "@nocturne/rpc/client";
import { createAttachmentImageSource } from "../src/attachment-images";
import { PhoneSidePanel, type PhonePanelPage } from "../src/web/PhoneSidePanel";
import type { PhoneContextSource } from "../src/web/SessionHeaderTools";
import type { PhoneSession } from "../src/web/sessions";

export const panelContext = {
  report: {
    estimatedTokens: 43210,
    budgetTokens: 128000,
    sections: [
      { name: "system", estimatedTokens: 5000, chars: 20000 },
      { name: "history", estimatedTokens: 38210, chars: 152840 },
    ],
  },
  overBudget: false,
} as ContextSummary;

export function panelFixture({
  agents = [],
  shells = [],
}: { agents?: SubagentSummary[]; shells?: BackgroundShellTask[] } = {}) {
  const session = {
    id: "p",
    shellOutput: vi.fn(async () => ({
      task: shells[0],
      text: "output",
      start: 0,
      end: 6,
      durationMs: 0,
    })),
    shellKill: vi.fn(async () => undefined),
    fileIndex: vi.fn(async () => [{ path: "src/long.ts", kind: "file" as const }]),
    readFile: vi.fn(async () => ({
      kind: "text" as const,
      path: "src/long.ts",
      text: "const long = '" + "long".repeat(80) + "';",
      bytes: 335,
    })),
  };
  const runtime = {
    listSubagents: vi.fn(async () => agents),
    cancelSubagent: vi.fn(async () => undefined),
    observeSubagent: vi.fn(
      async (
        _input: { parentSessionId: string; childSessionId: string },
        _observer: SubagentObserver,
      ) => {
        const agent = agents[0];
        if (!agent) throw new Error("missing agent fixture");
        return { lastSeq: 0, summary: agent, mode: "live" as const, unsubscribe: vi.fn() };
      },
    ),
  };
  const view = createSessionView();
  view.backgroundShells = shells;
  const entry: PhoneSession = {
    session: session as unknown as RpcSession,
    client: { runtime, onEvent: () => () => undefined } as unknown as RpcClient,
    workspace: "Z:/work",
    view,
    warnings: [],
    dead: false,
    listeners: new Set(),
    turnChanges: new Map(),
    changeDiffs: new Map(),
    pendingInputs: { items: [], paused: false },
  };
  const onError = vi.fn();
  const onClose = vi.fn();
  const loadDiff = vi.fn(async () => ({ diff: "@@ -1 +1 @@\n-old\n+new\n" }));
  return { entry, session, runtime, onError, onClose, loadDiff };
}

export function PanelHarness({
  fixture,
  context,
  initial = { kind: "overview" },
}: {
  fixture: ReturnType<typeof panelFixture>;
  initial?: PhonePanelPage;
  context?: PhoneContextSource;
}) {
  const [page, setPage] = useState<PhonePanelPage>(initial);
  return (
    <div className="phone">
      <PhoneSidePanel
        entry={fixture.entry}
        page={page}
        connected
        context={context ?? { load: async () => panelContext, key: "0" }}
        images={createAttachmentImageSource()}
        openUrl={vi.fn()}
        onNavigate={setPage}
        onBack={() => setPage({ kind: "overview" })}
        onClose={fixture.onClose}
        onError={fixture.onError}
        loadDiff={fixture.loadDiff}
      />
    </div>
  );
}
