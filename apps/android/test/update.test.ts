import { expect, it, vi } from "vitest";
import { AndroidUpdate } from "../src/update";

it("自动检查未结束时手动检查显示进度，失败可重试", async () => {
  let reject: (reason: Error) => void = () => undefined;
  const fetch = vi.fn().mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const update = new AndroidUpdate({ version: "1.0.0", fetch });
  const auto = update.check();
  const manual = update.check(true);
  expect(update.state).toBe("checking");
  reject(new Error("offline"));
  await Promise.all([auto, manual]);
  expect(update.state).toBe("error");
  expect(fetch).toHaveBeenCalledOnce();
});

function fixture() {
  let time = 100;
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ tag_name: "v1.2.0", assets: [{ name: "nocturne-1.2.0.apk" }] }),
  });
  const update = new AndroidUpdate({ version: "1.0.0", fetch, now: () => time, storage });
  return {
    update,
    fetch,
    storage,
    advance: () => {
      time += 86400000;
    },
  };
}

it("两个来源均需更新，取较大的版本，电脑比较无需网络", async () => {
  const { update, fetch } = fixture();
  update.computer("0.9.0");
  expect(update.version).toBeUndefined();
  update.computer("1.1.0");
  expect(update.version).toBe("1.1.0");
  expect(fetch).not.toHaveBeenCalled();
  await update.check(true);
  expect(update.version).toBe("1.2.0");
  update.computer("2.0.0");
  expect(update.version).toBe("2.0.0");
  update.computer("1.0.0");
  expect(update.version).toBe("1.2.0");
  update.computer(undefined);
  expect(update.version).toBe("1.2.0");
});

it.each(["v1.3.0-rc.1", "1.3.0+build", "1.3", "junk1.3.0", "01.3.0"])(
  "忽略非正式版本 %s",
  async (tag) => {
    const { update, fetch } = fixture();
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: tag, assets: [{ name: `nocturne-${tag}.apk` }] }),
    });
    update.computer(tag);
    await update.check(true);
    expect(update.version).toBeUndefined();
  },
);

it("没有匹配的 APK 或明确标记为预发布不算", async () => {
  const { update, fetch } = fixture();
  fetch.mockResolvedValue({ ok: true, json: async () => ({ tag_name: "v3.0.0", assets: [] }) });
  await update.check(true);
  expect(update.version).toBeUndefined();
  fetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      tag_name: "v3.0.0",
      prerelease: true,
      assets: [{ name: "nocturne-3.0.0.apk" }],
    }),
  });
  await update.check(true);
  expect(update.version).toBeUndefined();
});

it("启动和回前台 24h 节流，手动绕过，成功时间可跨实例保存", async () => {
  const { update, fetch, advance, storage } = fixture();
  await update.check();
  await update.check();
  expect(fetch).toHaveBeenCalledTimes(1);
  await update.check(true);
  expect(fetch).toHaveBeenCalledTimes(2);
  const restored = new AndroidUpdate({ version: "1.0.0", fetch, storage, now: () => 101 });
  expect(restored.version).toBe("1.2.0");
  await restored.check();
  expect(fetch).toHaveBeenCalledTimes(2);
  advance();
  await update.check();
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("失败不记时间，自动失败静默，电脑来源仍有效", async () => {
  const { update, fetch } = fixture();
  fetch.mockRejectedValue(new Error("offline"));
  await update.check();
  expect(update.state).toBe("idle");
  await update.check(true);
  expect(update.state).toBe("error");
  await update.check();
  expect(fetch).toHaveBeenCalledTimes(3);
  update.computer("2.0.0");
  expect(update.version).toBe("2.0.0");
});

it("关闭按版本记住，更高版本恢复提示", async () => {
  const { update, fetch, storage } = fixture();
  await update.check(true);
  expect(update.notice).toBe("1.2.0");
  update.dismiss();
  expect(update.notice).toBeUndefined();
  const restored = new AndroidUpdate({ version: "1.0.0", fetch, storage });
  expect(restored.notice).toBeUndefined();
  restored.computer("1.3.0");
  expect(restored.notice).toBe("1.3.0");
  expect(restored.url("1.3.0")).toBe(
    "https://github.com/kanzaki-chiya/Nocturne/releases/download/v1.3.0/nocturne-1.3.0.apk",
  );
});
