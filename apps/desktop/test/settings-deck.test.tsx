import { useEffect, useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "@nocturne/rpc/client";
import { SettingsDeck } from "../src/SettingsDeck";
import type { SettingsSection } from "../src/Sidebar";

afterEach(cleanup);

it("进入设置区预加载每页；返回页面立即保留数据，并在后台刷新；配置变更失效所有页", () => {
  const loaded = vi.fn();
  function Probe({ name, version }: { name: string; version: number }) {
    const [value, setValue] = useState("旧数据");
    useEffect(() => {
      loaded(name, version);
    }, [name, version]);
    return (
      <button onClick={() => setValue("保存的新数据")}>
        {name}:{value}
      </button>
    );
  }
  const client = {} as RpcClient;
  const deck = (page: SettingsSection | null, version = 0, connection = client) => (
    <SettingsDeck page={page} client={connection} version={version}>
      {(name, revision) => <Probe name={name} version={revision} />}
    </SettingsDeck>
  );
  const view = render(deck(null));
  expect(loaded).not.toHaveBeenCalled();
  view.rerender(deck("general"));
  expect(loaded).toHaveBeenCalledTimes(13);
  expect(loaded.mock.calls.map((call) => call[0])).toContain("archive");
  fireEvent.click(screen.getByRole("button", { name: "general:旧数据" }));
  view.rerender(deck("providers"));
  view.rerender(deck(null));
  view.rerender(deck("general"));
  expect(screen.getByRole("button", { name: "general:保存的新数据" })).toBeTruthy();
  const before = loaded.mock.calls.length;
  view.rerender(deck("general", 1));
  expect(loaded.mock.calls.length - before).toBe(13);
  view.rerender(deck("general", 1, {} as RpcClient));
  expect(screen.getByRole("button", { name: "general:旧数据" })).toBeTruthy();
  expect(within(view.container).queryByText("general:保存的新数据")).toBeNull();
});
