import { afterEach, expect, it, vi } from "vitest";
import { subscribeThemePreset } from "../src/theme-sync";
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
