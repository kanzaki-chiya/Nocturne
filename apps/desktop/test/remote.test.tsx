import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import qrcode from "qrcode-generator";
import {
  createMemoryTransportPair,
  createRpcClient,
  type RemoteStatus,
} from "@nocturne/rpc/client";
import { PairingDialog, PairingQr, RemoteBadge, RemotePage, qrModules } from "../src/RemotePage";
import { pushRemoteNotification } from "../src/notify";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const empty: RemoteStatus = {
  registered: false,
  enabled: false,
  connection: "off",
  devices: [],
  connections: [],
  warnings: [],
};
const online: RemoteStatus = {
  ...empty,
  registered: true,
  enabled: true,
  connection: "online",
  relay: { origin: "https://relay.example", hostId: "host" },
  devices: [{ id: "one", name: "测试手机", createdAt: 1, online: true, push: true }],
  connections: [{ deviceId: "one", name: "测试手机", since: 1 }],
};
function harness(status = empty) {
  const [server, transport] = createMemoryTransportPair();
  const calls: { method: string; params: unknown }[] = [];
  let error: string | undefined;
  server.onLine((line) => {
    const request = JSON.parse(line) as { method: string; params: unknown; id: number };
    calls.push(request);
    server.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        ...(error
          ? { error: { code: -32004, message: error, data: { code: "failed" } } }
          : {
              result:
                request.method === "remote.push"
                  ? { sent: 1 }
                  : request.method === "remote.startPairing"
                    ? { url: "https://relay.example/#pair=test", expiresAt: Date.now() + 300000 }
                    : status,
            }),
      }),
    );
  });
  const client = createRpcClient(transport, { clientName: "test" });
  return {
    client,
    calls,
    fail: (message: string) => {
      error = message;
    },
    notify: (method: string, params: unknown) => {
      server.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    },
  };
}
it("未登记只查询 describe，显示说明和邀请输入，不调用写方法", async () => {
  const h = harness();
  const view = render(<RemotePage client={h.client} />);
  await screen.findByPlaceholderText("粘贴邀请（nocturne-invite:…）");
  expect(screen.getByText("你需要信任谁")).toBeTruthy();
  view.unmount();
  expect(h.calls.map((c) => c.method)).toEqual(["remote.describe"]);
});
it("登记失败在页内显示中文错误", async () => {
  const h = harness();
  render(<RemotePage client={h.client} />);
  fireEvent.change(await screen.findByLabelText("中继邀请"), {
    target: { value: "nocturne-invite:example/test" },
  });
  h.fail("邀请无效，请向管理员索取新的邀请");
  fireEvent.click(screen.getByText("登记"));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "邀请无效，请向管理员索取新的邀请",
  );
});
it("已登记显示中继、开关、设备状态和推送订阅", async () => {
  const h = harness(online);
  render(<RemotePage client={h.client} />);
  expect(await screen.findByText("relay.example")).toBeTruthy();
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText("测试手机")).toBeTruthy();
  expect(screen.getByText(/已订阅推送/)).toBeTruthy();
});
it.each(["移除", "退出登记"])("%s 先在页内确认，确认前不发写请求", async (label) => {
  const h = harness(online);
  render(<RemotePage client={h.client} />);
  await screen.findByText("测试手机");
  fireEvent.click(screen.getByText(label));
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  expect(h.calls.map((c) => c.method)).toEqual(["remote.describe"]);
  fireEvent.click(screen.getByText(`确认${label}`));
  await waitFor(() => {
    expect(
      h.calls.some(
        (c) => c.method === (label === "移除" ? "remote.removeDevice" : "remote.unregister"),
      ),
    ).toBe(true);
  });
});
it("remote.statusChanged 更新界面", async () => {
  const h = harness();
  render(<RemotePage client={h.client} />);
  await screen.findByLabelText("中继邀请");
  act(() => h.notify("remote.statusChanged", { status: online }));
  expect(await screen.findByText("测试手机")).toBeTruthy();
});
it("配对对话框存在二维码和倒计时，收到 paired 显示成功并自动关闭", async () => {
  vi.useFakeTimers();
  const h = harness(),
    close = vi.fn();
  render(
    <PairingDialog
      client={h.client}
      offer={{ url: "https://relay.example/#pair=test", expiresAt: Date.now() + 120000 }}
      onClose={close}
    />,
  );
  expect(screen.getByRole("img", { name: "手机配对二维码" })).toBeTruthy();
  expect(screen.getByText(/2:00/)).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(screen.getByText(/1:59/)).toBeTruthy();
  await act(async () => {
    h.notify("remote.paired", { device: { id: "one", name: "手机" } });
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByText("已配对：手机")).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1600);
  });
  expect(close).toHaveBeenCalledTimes(1);
});
it("配对失败显示可读原因", async () => {
  const h = harness();
  render(
    <PairingDialog
      client={h.client}
      offer={{ url: "https://relay.example/#pair=test", expiresAt: Date.now() + 120000 }}
      onClose={vi.fn()}
    />,
  );
  act(() => h.notify("remote.pairingFailed", { code: "bad_mac" }));
  expect(await screen.findByText("配对密钥不匹配，请重新扫码")).toBeTruthy();
});
it("状态栏无连接不显示；单台、多台文案，面板支持断开", async () => {
  const h = harness();
  const view = render(<RemoteBadge status={empty} client={h.client} onOpen={vi.fn()} />);
  expect(screen.queryByText(/手机在线/)).toBeNull();
  view.rerender(<RemoteBadge status={online} client={h.client} onOpen={vi.fn()} />);
  fireEvent.click(screen.getByText("手机在线"));
  expect(screen.getByRole("dialog", { name: "在线手机" })).toBeTruthy();
  fireEvent.click(screen.getByText("断开"));
  await waitFor(() => {
    expect(h.calls).toContainEqual(
      expect.objectContaining({ method: "remote.disconnectDevice", params: { id: "one" } }),
    );
  });
  view.rerender(
    <RemoteBadge
      status={{
        ...online,
        connections: [...online.connections, { deviceId: "two", name: "另一台手机", since: 2 }],
      }}
      client={h.client}
      onOpen={vi.fn()}
    />,
  );
  expect(screen.getByText("手机在线 2")).toBeTruthy();
});
it("吊销时状态栏警示可打开远程设置", () => {
  const open = vi.fn();
  render(
    <RemoteBadge status={{ ...online, connection: "revoked" }} client={undefined} onOpen={open} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "远程已被吊销" }));
  expect(open).toHaveBeenCalledTimes(1);
});
it("通知只有登记、开启、在线且没有手机连接才推送", async () => {
  const h = harness(),
    log = vi.fn();
  await pushRemoteNotification(h.client, { ...online, connections: [] }, log);
  expect(h.calls.map((c) => c.method)).toEqual(["remote.push"]);
  for (const status of [
    empty,
    online,
    { ...online, enabled: false },
    { ...online, connection: "offline" as const },
  ])
    await pushRemoteNotification(h.client, status, log);
  expect(h.calls).toHaveLength(1);
  h.fail("失败");
  await pushRemoteNotification(h.client, { ...online, connections: [] }, log);
  expect(log).toHaveBeenCalledWith("[remote] 手机推送失败");
});
it("固定 URL 的二维码 SVG path 模块数与 M 纠错矩阵一致并有四模块留白", () => {
  const url = "https://relay.example/#pair=test",
    matrix = qrcode(0, "M");
  matrix.addData(url, "Byte");
  matrix.make();
  let count = 0;
  for (let row = 0; row < matrix.getModuleCount(); row++)
    for (let col = 0; col < matrix.getModuleCount(); col++) if (matrix.isDark(row, col)) count++;
  const qr = qrModules(url);
  expect(qr.count).toBe(count);
  expect(qr.size).toBe(matrix.getModuleCount() + 8);
  const { container } = render(<PairingQr url={url} />);
  expect(container.querySelector("path")?.getAttribute("d")?.match(/M/g)).toHaveLength(count);
});
