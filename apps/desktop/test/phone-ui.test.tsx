import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PhoneApp } from "../src/web/App";
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
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "开启推送通知",
  );
  if (ios) {
    expect(button).toBeUndefined();
    expect(container.textContent).toContain("添加到主屏幕后才能接收推送");
  } else {
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });
    expect(request).toHaveBeenCalledOnce();
  }
});
