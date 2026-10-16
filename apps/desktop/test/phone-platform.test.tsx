import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  acceptPairingHello,
  createMemoryFramePair,
  createPairingOffer,
  generateIdentity,
} from "@nocturne/remote";
import { PhoneApp } from "../src/web/App";
import { memoryStorage } from "../src/web/storage";
import { pairPhone, parsePairingLink, parsePairingTarget } from "../src/web/pairing";
import type { PhonePlatform } from "../src/web/platform";

const connections: { origin: string; hostId: string }[] = [];
const visibilities: boolean[] = [];
vi.mock("../src/web/connection", () => ({
  PhoneConnection: class {
    state = "offline";
    message = "电脑已离线";
    constructor(options: { origin: string; host: { hostId: string } }) {
      connections.push({ origin: options.origin, hostId: options.host.hostId });
    }
    start = vi.fn();
    stop = vi.fn();
    visibility = vi.fn((visible: boolean) => visibilities.push(visible));
  },
}));
let root: Root | undefined;
beforeEach(() => {
  connections.length = 0;
  visibilities.length = 0;
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});
afterEach(async () => {
  await act(() => root?.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(ui: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(ui);
  });
  // 身份密钥与电脑记录异步读取，连接在其后创建
  await act(async () => {
    await new Promise((done) => setTimeout(done, 100));
  });
  return container;
}

it("App 配对链接必须带中继地址，只接受 https 与本机 http://127.0.0.1", async () => {
  const host = await generateIdentity({ extractable: true });
  const offer = await createPairingOffer(host, "AAAAAAAAAAAAAAAAAAAAAA");
  const secure = parsePairingTarget(`  https://Relay.Example/#${offer.fragment}  `);
  expect(secure.origin).toBe("https://relay.example");
  expect(secure.offer.slot).toBe("AAAAAAAAAAAAAAAAAAAAAA");
  expect(parsePairingTarget(`http://127.0.0.1:8787/#${offer.fragment}`).origin).toBe(
    "http://127.0.0.1:8787",
  );
  expect(() => parsePairingTarget(`#${offer.fragment}`)).toThrow("完整的配对链接");
  expect(() => parsePairingTarget(offer.fragment)).toThrow("完整的配对链接");
  expect(() => parsePairingTarget("不是链接")).toThrow("格式不对");
  expect(() => parsePairingTarget(`http://relay.example/#${offer.fragment}`)).toThrow("https");
  expect(() => parsePairingTarget(`http://localhost:8787/#${offer.fragment}`)).toThrow("https");
  expect(() => parsePairingTarget("https://relay.example/")).toThrow();
});

it("网页配对不记中继，App 配对把中继地址存在电脑记录里", async () => {
  for (const remember of [false, true]) {
    const host = await generateIdentity({ extractable: true });
    const offer = await createPairingOffer(host, "AAAAAAAAAAAAAAAAAAAAAA");
    const store = memoryStorage();
    const [phone, computer] = createMemoryFramePair();
    computer.onFrame((frame) => {
      void acceptPairingHello(host, offer.secret, frame).then(({ reply }) => {
        computer.send(reply);
      });
    });
    const paired = await pairPhone(
      store,
      parsePairingLink(`https://relay.example/#${offer.fragment}`, "https://relay.example"),
      "https://relay.example",
      "手机",
      () => Promise.resolve(phone),
      undefined,
      remember,
    );
    expect(paired.origin).toBe(remember ? "https://relay.example" : undefined);
    expect(await store.hosts()).toEqual([paired]);
    expect("origin" in paired).toBe(remember);
  }
});

it("App 平台：用电脑记录里的中继地址连接，没有推送区块，信任说明可替换", async () => {
  const storage = memoryStorage();
  await storage.putHost({
    hostId: "computer",
    hostPub: "pub",
    name: "电脑 1",
    pairedAt: 1,
    origin: "https://relay.example",
  });
  const platform: PhonePlatform = {
    relay: "link",
    trustText: "安装包信任说明",
    background: () => <section aria-label="后台服务">后台区块</section>,
  };
  const container = await mount(<PhoneApp storage={storage} platform={platform} />);
  expect(connections).toEqual([{ origin: "https://relay.example", hostId: "computer" }]);
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="设置"]')?.click();
  });
  expect(container.textContent).toContain("后台区块");
  expect(container.textContent).toContain("安装包信任说明");
  expect(container.querySelector('input[aria-label="推送通知"]')).toBeNull();
});

it("网页平台仍用页面源连接，推送区块照常", async () => {
  const storage = memoryStorage();
  await storage.putHost({ hostId: "computer", hostPub: "pub", name: "电脑 1", pairedAt: 1 });
  const container = await mount(<PhoneApp storage={storage} />);
  expect(connections).toEqual([{ origin: location.origin, hostId: "computer" }]);
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="设置"]')?.click();
  });
  expect(container.textContent).not.toContain("后台区块");
});

it("没有中继地址的 App 电脑记录提示重新配对，不连接", async () => {
  const storage = memoryStorage();
  await storage.putHost({ hostId: "computer", hostPub: "pub", name: "电脑 1", pairedAt: 1 });
  const container = await mount(<PhoneApp storage={storage} platform={{ relay: "link" }} />);
  expect(connections).toEqual([]);
  expect(container.textContent).toContain("缺少中继地址");
});

it.each([true, false])("keepConnected=%s：页面隐藏时的连接判定", async (keep) => {
  const storage = memoryStorage();
  await storage.putHost({
    hostId: "computer",
    hostPub: "pub",
    name: "电脑 1",
    pairedAt: 1,
    origin: "https://relay.example",
  });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await mount(<PhoneApp storage={storage} platform={{ relay: "link", keepConnected: keep }} />);
  expect(visibilities.at(-1)).toBe(keep);
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(visibilities.at(-1)).toBe(keep);
});

it("平台的 onForeground 在页面挂载时登记、卸载时退订；没有它的平台不受影响", async () => {
  const storage = memoryStorage();
  await storage.putHost({
    hostId: "computer",
    hostPub: "pub",
    name: "电脑 1",
    pairedAt: 1,
    origin: "https://relay.example",
  });
  const unsubscribe = vi.fn();
  const onForeground = vi.fn((_listener: () => void) => unsubscribe);
  await mount(<PhoneApp storage={storage} platform={{ relay: "link", onForeground }} />);
  expect(onForeground).toHaveBeenCalledOnce();
  // 未连上电脑时回前台没有可刷新的连接，调用不报错
  const listener = onForeground.mock.calls[0]?.[0];
  await act(async () => {
    listener?.();
  });
  await act(() => root?.unmount());
  root = undefined;
  expect(unsubscribe).toHaveBeenCalledOnce();
  await mount(<PhoneApp storage={storage} platform={{ relay: "link" }} />);
});
