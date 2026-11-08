import { beforeEach, expect, it, vi } from "vitest";
import { AndroidUpdate } from "../src/update";

beforeEach(() => {
  localStorage.clear();
});

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
  const tagFetch = vi.fn().mockImplementation(async (url: string) => {
    const version = url.slice(url.lastIndexOf("/v") + 2);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: `v${version}`,
        assets: [{ name: `nocturne-${version}.apk` }],
      }),
    };
  });
  const wrappedFetch: typeof globalThis.fetch = async (url, init) =>
    String(url).includes("/tags/") ? tagFetch(String(url), init) : fetch(url, init);
  const update = new AndroidUpdate({
    version: "1.0.0",
    fetch: wrappedFetch,
    now: () => time,
    storage,
  });
  return {
    update,
    fetch,
    tagFetch,
    wrappedFetch,
    storage,
    advance: () => {
      time += 86400000;
    },
  };
}

it("两个来源均需更新，电脑版本确认 APK 后取较大的版本", async () => {
  const { update, fetch } = fixture();
  update.computer("0.9.0");
  expect(update.version).toBeUndefined();
  update.computer("1.1.0");
  await new Promise((done) => setTimeout(done, 0));
  expect(update.version).toBe("1.1.0");
  expect(fetch).not.toHaveBeenCalled();
  await update.check(true);
  expect(update.version).toBe("1.2.0");
  update.computer("2.0.0");
  await new Promise((done) => setTimeout(done, 0));
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
  await new Promise((done) => setTimeout(done, 0));
  expect(update.version).toBe("2.0.0");
});

it("关闭按版本记住，更高版本恢复提示", async () => {
  const { update, wrappedFetch, storage } = fixture();
  await update.check(true);
  expect(update.notice).toBe("1.2.0");
  update.dismiss();
  expect(update.notice).toBeUndefined();
  const restored = new AndroidUpdate({ version: "1.0.0", fetch: wrappedFetch, storage });
  expect(restored.notice).toBeUndefined();
  restored.computer("1.3.0");
  await new Promise((done) => setTimeout(done, 0));
  expect(restored.notice).toBe("1.3.0");
  expect(restored.url("1.3.0")).toBe(
    "https://github.com/kanzaki-chiya/Nocturne/releases/download/v1.3.0/nocturne-1.3.0.apk",
  );
});

it("电脑版本比 App 和 github 都新时按标签查询：请求中不生效，200 有 APK 确认存在", async () => {
  let resolveTag: (value: unknown) => void = () => undefined;
  const fetch = vi.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveTag = resolve;
      }),
  );
  const update = new AndroidUpdate({ version: "1.0.0", fetch });
  update.computer("1.1.0");
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[0]).toBe(
    "https://api.github.com/repos/kanzaki-chiya/Nocturne/releases/tags/v1.1.0",
  );
  expect(update.version).toBeUndefined();
  resolveTag({
    ok: true,
    status: 200,
    json: async () => ({
      tag_name: "v1.1.0",
      prerelease: false,
      draft: false,
      assets: [{ name: "nocturne-1.1.0.apk" }],
    }),
  });
  await vi.waitFor(() => {
    expect(update.version).toBe("1.1.0");
  });
});

it.each([
  ["404", { ok: false, status: 404, json: async () => ({ message: "Not Found" }) }],
  [
    "200 无 APK",
    {
      ok: true,
      status: 200,
      json: async () => ({ tag_name: "v2.0.0", assets: [{ name: "nctrn-2.0.0.tgz" }] }),
    },
  ],
  [
    "prerelease",
    {
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: "v2.0.0",
        prerelease: true,
        assets: [{ name: "nocturne-2.0.0.apk" }],
      }),
    },
  ],
  [
    "draft",
    {
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: "v2.0.0",
        draft: true,
        assets: [{ name: "nocturne-2.0.0.apk" }],
      }),
    },
  ],
] as const)(
  "电脑版本确认不存在（%s）：不采用电脑版本，回退到比 App 新的 github 版本",
  async (_label, tagResponse) => {
    const { update, tagFetch } = fixture();
    await update.check(true);
    expect(update.version).toBe("1.2.0");
    tagFetch.mockResolvedValueOnce(tagResponse);
    update.computer("2.0.0");
    expect(update.version).toBe("1.2.0");
    await new Promise((done) => setTimeout(done, 10));
    expect(update.version).toBe("1.2.0");
    const updateNoGithub = new AndroidUpdate({
      version: "1.0.0",
      fetch: vi.fn().mockResolvedValue(tagResponse),
    });
    updateNoGithub.computer("2.0.0");
    await new Promise((done) => setTimeout(done, 10));
    expect(updateNoGithub.version).toBeUndefined();
  },
);

it.each([
  ["网络错误", () => Promise.reject(new Error("network"))],
  ["403", () => Promise.resolve({ ok: false, status: 403, json: async () => ({}) })],
  ["500", () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) })],
  [
    "格式错误的 JSON",
    () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError("bad json")),
      }),
  ],
] as const)(
  "电脑版本无法确认（%s）：仍采用电脑版本，且下次 computer() 重新请求",
  async (_label, impl) => {
    const fetch = vi.fn().mockImplementation(impl);
    const update = new AndroidUpdate({ version: "1.0.0", fetch });
    update.computer("2.0.0");
    await vi.waitFor(() => {
      expect(update.version).toBe("2.0.0");
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    update.computer("2.0.0");
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(update.version).toBe("2.0.0");
    });
  },
);

it("电脑版本不比 App 新或不比已知 github 新时不发标签请求", async () => {
  const { update, fetch } = fixture();
  update.computer("0.9.0");
  update.computer("1.0.0");
  expect(fetch).not.toHaveBeenCalled();
  await update.check(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  update.computer("1.1.0");
  update.computer("1.2.0");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(update.version).toBe("1.2.0");
});

it("确认存在后不再请求；确认不存在后 1h 内不请求、1h 后重新请求可变为存在；只存内存不写 storage", async () => {
  let time = 1000;
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
  const fetch = vi.fn();
  const update = new AndroidUpdate({ version: "1.0.0", fetch, now: () => time, storage });

  fetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ tag_name: "v1.5.0", assets: [{ name: "nocturne-1.5.0.apk" }] }),
  });
  update.computer("1.5.0");
  await vi.waitFor(() => {
    expect(update.version).toBe("1.5.0");
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  update.computer("1.5.0");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(data.size).toBe(0);

  fetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
  update.computer("2.0.0");
  await new Promise((done) => setTimeout(done, 10));
  expect(update.version).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(data.size).toBe(0);

  time += 3600000 - 1;
  update.computer("2.0.0");
  expect(fetch).toHaveBeenCalledTimes(2);

  time += 1;
  fetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ tag_name: "v2.0.0", assets: [{ name: "nocturne-2.0.0.apk" }] }),
  });
  update.computer("2.0.0");
  await vi.waitFor(() => {
    expect(update.version).toBe("2.0.0");
  });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(data.size).toBe(0);
});

it("missing 记录过期后连续 computer() 只发一个标签请求", async () => {
  let time = 1000;
  let resolveTag: (value: unknown) => void = () => undefined;
  const fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 404 });
  const update = new AndroidUpdate({ version: "1.0.0", fetch, now: () => time });
  update.computer("2.0.0");
  await new Promise((done) => setTimeout(done, 10));
  expect(update.version).toBeUndefined();
  time += 3600000;
  fetch.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveTag = resolve;
      }),
  );
  update.computer("2.0.0");
  update.computer("2.0.0");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(update.version).toBeUndefined();
  resolveTag({
    ok: true,
    status: 200,
    json: async () => ({ tag_name: "v2.0.0", assets: [{ name: "nocturne-2.0.0.apk" }] }),
  });
  await vi.waitFor(() => expect(update.version).toBe("2.0.0"));
});

it("missing 记录手动重新确认时连续 check(true) 只发一个标签请求", async () => {
  let resolveTag: (value: unknown) => void = () => undefined;
  const tagFetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 404 });
  const latestFetch = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ tag_name: "v1.0.0", assets: [] }) });
  const fetch = vi.fn((url: unknown) =>
    String(url).endsWith("/latest") ? latestFetch() : tagFetch(),
  );
  const update = new AndroidUpdate({ version: "1.0.0", fetch });
  update.computer("2.0.0");
  await new Promise((done) => setTimeout(done, 10));
  expect(update.version).toBeUndefined();
  tagFetch.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveTag = resolve;
      }),
  );
  const first = update.check(true);
  const second = update.check(true);
  expect(tagFetch).toHaveBeenCalledTimes(2);
  expect(update.version).toBeUndefined();
  expect(update.state).toBe("checking");
  resolveTag({
    ok: true,
    status: 200,
    json: async () => ({ tag_name: "v2.0.0", assets: [{ name: "nocturne-2.0.0.apk" }] }),
  });
  await Promise.all([first, second]);
  expect(update.version).toBe("2.0.0");
  expect(update.state).toBe("latest");
});

it("present 记录手动重新确认期间不参与版本比较，并复用标签请求", async () => {
  let resolveTag: (value: unknown) => void = () => undefined;
  const tagFetch = vi.fn().mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ tag_name: "v2.0.0", assets: [{ name: "nocturne-2.0.0.apk" }] }),
  });
  const fetch = vi.fn((url: unknown) =>
    String(url).endsWith("/latest")
      ? Promise.resolve({ ok: true, json: async () => ({ tag_name: "v1.0.0", assets: [] }) })
      : tagFetch(),
  );
  const update = new AndroidUpdate({ version: "1.0.0", fetch });
  update.computer("2.0.0");
  await vi.waitFor(() => expect(update.version).toBe("2.0.0"));
  tagFetch.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveTag = resolve;
      }),
  );
  const first = update.check(true);
  const second = update.check(true);
  expect(tagFetch).toHaveBeenCalledTimes(2);
  expect(update.version).toBeUndefined();
  resolveTag({
    ok: true,
    status: 200,
    json: async () => ({ tag_name: "v2.0.0", assets: [{ name: "nocturne-2.0.0.apk" }] }),
  });
  await Promise.all([first, second]);
  expect(update.version).toBe("2.0.0");
});

it("同一电脑版本并发只发一个请求", async () => {
  let resolveTag: (value: unknown) => void = () => undefined;
  const fetch = vi.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveTag = resolve;
      }),
  );
  const update = new AndroidUpdate({ version: "1.0.0", fetch });
  update.computer("2.0.0");
  update.computer("2.0.0");
  expect(fetch).toHaveBeenCalledOnce();
  resolveTag({
    ok: true,
    status: 200,
    json: async () => ({ tag_name: "v2.0.0", assets: [{ name: "nocturne-2.0.0.apk" }] }),
  });
  await vi.waitFor(() => {
    expect(update.version).toBe("2.0.0");
  });
});

it("手动 check(true) 重新确认已记录为不存在的电脑版本，并等两个请求都结束才离开 checking", async () => {
  let resolveLatest: (value: unknown) => void = () => undefined;
  let resolveTag: (value: unknown) => void = () => undefined;
  const fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
  const update = new AndroidUpdate({ version: "1.0.0", fetch });
  update.computer("2.0.0");
  await new Promise((done) => setTimeout(done, 10));
  expect(update.version).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(1);

  fetch.mockImplementation((url: string) =>
    url.endsWith("/latest")
      ? new Promise((resolve) => {
          resolveLatest = resolve;
        })
      : new Promise((resolve) => {
          resolveTag = resolve;
        }),
  );
  const checking = update.check(true);
  expect(update.state).toBe("checking");

  resolveLatest({
    ok: true,
    status: 200,
    json: async () => ({ tag_name: "v1.2.0", assets: [{ name: "nocturne-1.2.0.apk" }] }),
  });
  await new Promise((done) => setTimeout(done, 10));
  expect(update.state).toBe("checking");

  resolveTag({
    ok: true,
    status: 200,
    json: async () => ({ tag_name: "v2.0.0", assets: [{ name: "nocturne-2.0.0.apk" }] }),
  });
  await checking;
  expect(update.state).toBe("latest");
  expect(update.version).toBe("2.0.0");
});

it("晚到的标签响应只更新记录，不把已切换的电脑版本改回去", async () => {
  let resolveFirst: (value: unknown) => void = () => undefined;
  const fetch = vi.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );
  const update = new AndroidUpdate({ version: "1.0.0", fetch });
  update.computer("2.0.0");
  update.computer(undefined);
  resolveFirst({
    ok: true,
    status: 200,
    json: async () => ({ tag_name: "v2.0.0", assets: [{ name: "nocturne-2.0.0.apk" }] }),
  });
  await new Promise((done) => setTimeout(done, 10));
  expect(update.version).toBeUndefined();
  update.computer("2.0.0");
  expect(fetch).toHaveBeenCalledOnce();
  expect(update.version).toBe("2.0.0");
});
