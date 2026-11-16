import { afterEach, expect, it, vi } from "vitest";
import { subscribeThemePreset, subscribeThemeSettings } from "../src/theme-sync";
import { fakeServer, withInit } from "./fake-server";

const servers: ReturnType<typeof fakeServer>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});
it("预设首读、实时通知重读与未知值回退，清理后不再通知", async () => {
  let value = "paper";
  const server = fakeServer(
    withInit({
      "runtime.describeSettings": () => [{ key: "appearance.themePreset", effective: value }],
    }),
  );
  servers.push(server);
  await server.initialize();
  const changed = vi.fn();
  const stop = subscribeThemePreset(server.client, changed);
  await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith("paper"));
  value = "celadon";
  server.notify("runtime.settingsChanged", {});
  await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith("celadon"));
  value = "unknown";
  server.notify("runtime.settingsChanged", {});
  await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith("workbench"));
  stop();
  const count = server.calls.length;
  server.notify("runtime.settingsChanged", {});
  await Promise.resolve();
  expect(server.calls).toHaveLength(count);
});
it("旧请求与旧电脑的迟到响应不能覆盖新预设", async () => {
  let finish: ((value: unknown) => void) | undefined;
  let count = 0;
  const server = fakeServer(
    withInit({
      "runtime.describeSettings": () =>
        ++count === 1
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : [{ key: "appearance.themePreset", effective: "ink" }],
    }),
  );
  servers.push(server);
  await server.initialize();
  const changed = vi.fn();
  const stop = subscribeThemePreset(server.client, changed);
  server.notify("runtime.settingsChanged", {});
  await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith("ink"));
  stop();
  finish?.([{ key: "appearance.themePreset", effective: "paper" }]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(changed.mock.calls).toEqual([["ink"]]);
});

it("读取 appearance.customThemes JSON 与 themePreset，settingsChanged 实时重读并忽略无效项", async () => {
  const fog = { id: "c-fog", name: "雾蓝", bg: "#f6f8fa", text: "#16202a", accent: "#2f6db5" };
  const moss = { id: "c-moss", name: "苔绿", bg: "#11140f", text: "#e5eadf", accent: "#a3c98a" };
  let preset = "c-fog";
  let rawThemes = JSON.stringify([fog, { id: "bad", name: "", bg: "nope" }]);
  const server = fakeServer(
    withInit({
      "runtime.describeSettings": () => [
        { key: "appearance.themePreset", effective: preset },
        { key: "appearance.customThemes", effective: rawThemes },
      ],
    }),
  );
  servers.push(server);
  await server.initialize();
  const changed = vi.fn();
  const stop = subscribeThemeSettings(server.client, changed);
  await vi.waitFor(() =>
    expect(changed).toHaveBeenLastCalledWith({ id: "c-fog", customThemes: [fog] }),
  );
  preset = "c-moss";
  rawThemes = JSON.stringify([fog, moss]);
  server.notify("runtime.settingsChanged", {});
  await vi.waitFor(() =>
    expect(changed).toHaveBeenLastCalledWith({ id: "c-moss", customThemes: [fog, moss] }),
  );
  // 自定义主题被删除或 JSON 损坏时回退工作台
  rawThemes = "{broken";
  server.notify("runtime.settingsChanged", {});
  await vi.waitFor(() =>
    expect(changed).toHaveBeenLastCalledWith({ id: "workbench", customThemes: [] }),
  );
  stop();
});
