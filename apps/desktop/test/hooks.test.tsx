import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { HookOverview, HooksDescription } from "@nocturne/core/protocol";
import { HooksPage } from "../src/HooksPage";
import { fakeServer, withInit } from "./fake-server";

afterEach(cleanup);

const desc = (hooks: HookOverview[], warnings: string[] = []): HooksDescription => ({
  hooks,
  warnings,
});

describe("Hook 设置页（只读）", () => {
  it("按事件点分组并保留配置顺序，显示命令、matcher、超时、来源与未信任状态", async () => {
    const f = fakeServer(
      withInit({
        "hooks.describeHooks": desc([
          {
            point: "PreToolUse",
            matcher: "shell|edit",
            command: "node",
            args: ["./hooks/guard.mjs", "--strict"],
            timeoutMs: 10000,
            origin: "user",
            path: "C:/home/.nocturne/config.json",
            trusted: true,
          },
          {
            point: "PreToolUse",
            command: "node",
            args: ["./hooks/project-check.mjs"],
            timeoutMs: 5000,
            origin: "project",
            path: "Z:/demo/.nocturne/config.json",
            trusted: false,
          },
          {
            point: "TurnEnd",
            matcher: "should-not-render",
            command: "python3",
            args: ["audit.py"],
            timeoutMs: 5000,
            origin: "user",
            path: "C:/home/.nocturne/config.json",
            trusted: true,
          },
        ]),
      }),
    );
    await f.initialize();

    render(<HooksPage client={f.client} workspaceRoot="Z:/demo" version={0} />);

    const preRegion = await screen.findByRole("region", { name: "PreToolUse · 2" });
    const turnEndRegion = screen.getByRole("region", { name: "TurnEnd · 1" });

    const preRows = [...preRegion.querySelectorAll(".hook-item")];
    expect(preRows).toHaveLength(2);
    expect(preRows[0]?.querySelector(".hook-cmd")?.textContent).toBe(
      "node ./hooks/guard.mjs --strict",
    );
    expect(within(preRows[0] as HTMLElement).getByText("shell|edit")).toBeTruthy();
    expect(within(preRows[0] as HTMLElement).getByText("10 秒")).toBeTruthy();
    expect(
      within(preRows[0] as HTMLElement).getByText("C:/home/.nocturne/config.json"),
    ).toBeTruthy();
    expect(preRows[0]?.className).not.toContain("untrusted");

    expect(preRows[1]?.querySelector(".hook-cmd")?.textContent).toBe(
      "node ./hooks/project-check.mjs",
    );
    expect(within(preRows[1] as HTMLElement).getByText("未信任")).toBeTruthy();
    expect(within(preRows[1] as HTMLElement).getByText("5 秒")).toBeTruthy();
    expect(
      within(preRows[1] as HTMLElement).getByText("Z:/demo/.nocturne/config.json"),
    ).toBeTruthy();
    expect(preRows[1]?.className).toContain("untrusted");

    expect(within(turnEndRegion).queryByText("should-not-render")).toBeNull();
    expect(turnEndRegion.querySelector(".hook-cmd")?.textContent).toBe("python3 audit.py");

    // 只读：没有按钮或开关
    const page = screen.getByRole("region", { name: "Hook" });
    expect(within(page).queryAllByRole("button")).toHaveLength(0);
    expect(within(page).queryAllByRole("switch")).toHaveLength(0);

    expect(f.calls.find((c) => c.method === "hooks.describeHooks")?.params).toEqual({
      workspaceRoot: "Z:/demo",
    });
  });

  it("没有任何 Hook 时显示空状态", async () => {
    const f = fakeServer(
      withInit({
        "hooks.describeHooks": desc([]),
      }),
    );
    await f.initialize();

    render(<HooksPage client={f.client} workspaceRoot={undefined} version={0} />);

    expect(await screen.findByText("没有 Hook")).toBeTruthy();
    const page = screen.getByRole("region", { name: "Hook" });
    expect(within(page).queryAllByRole("button")).toHaveLength(0);
  });

  it("收到 grants.changed 通知后重新拉取 Hook 列表", async () => {
    let trusted = false;
    const f = fakeServer(
      withInit({
        "hooks.describeHooks": () =>
          desc([
            {
              point: "SessionStart",
              command: "node",
              args: ["./init.mjs"],
              timeoutMs: 5000,
              origin: "project",
              path: "Z:/demo/.nocturne/config.json",
              trusted,
            },
          ]),
      }),
    );
    await f.initialize();

    render(<HooksPage client={f.client} workspaceRoot="Z:/demo" version={0} />);

    expect(await screen.findByText("未信任")).toBeTruthy();

    trusted = true;
    act(() => {
      f.notify("grants.changed", { workspace: "Z:/demo" });
    });

    await waitFor(() => {
      expect(screen.getByText("已信任")).toBeTruthy();
    });
  });
});
