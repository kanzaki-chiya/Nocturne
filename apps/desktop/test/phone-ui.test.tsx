import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PAIR_TRUST_NOTE, PhoneApp, TRUST_TEXT } from "../src/web/App";
import { memoryStorage } from "../src/web/storage";
import { PhonePush } from "../src/web/push";

vi.mock("../src/web/connection", () => ({
  PhoneConnection: class {
    state = "offline";
    message = "电脑已离线";
    start = vi.fn();
    stop = vi.fn();
    visibility = vi.fn();
  },
}));
let root: Root | undefined;
beforeEach(() => {
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
it.each([true, false])("iOS 非 standalone=%s：按钮显示与权限只在点击发起", async (ios) => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ios ? "iPhone Safari" : "Chrome");
  const storage = memoryStorage();
  await storage.putHost({ hostId: "computer", hostPub: "pub", name: "电脑 1", pairedAt: 1 });
  const request = vi.fn(() => Promise.resolve<NotificationPermission>("denied"));
  const push = new PhonePush({
    registration: () =>
      Promise.resolve({
        pushManager: { getSubscription: () => Promise.resolve(null) } as PushManager,
      }),
    permission: () => "default",
    requestPermission: request,
    info: vi.fn(),
    changed: vi.fn(),
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<PhoneApp storage={storage} push={push} />);
  });
  expect(request).not.toHaveBeenCalled();
  // 推送开关在设置页
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="设置"]')?.click();
  });
  const toggle = container.querySelector<HTMLInputElement>('input[aria-label="推送通知"]');
  if (ios) {
    expect(toggle).toBeNull();
    expect(container.textContent).toContain("添加到主屏幕后才能接收推送");
  } else {
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle?.click();
    });
    expect(request).toHaveBeenCalledOnce();
  }
});
it("配对页只留一句信任指引，完整说明在设置「关于」", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<PhoneApp storage={memoryStorage()} />);
  });
  expect(container.textContent).toContain(PAIR_TRUST_NOTE);
  expect(container.textContent).not.toContain(TRUST_TEXT);
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="设置"]')?.click();
  });
  const about = container.querySelector('section[aria-label="关于"]');
  expect(about?.textContent).toContain(TRUST_TEXT);
  expect(about?.textContent).not.toContain("手机能做会话里的一切");
});
