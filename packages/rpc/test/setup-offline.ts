/**
 * 默认测试集完全离线（workflow.md 第 5 节）：全局 fetch 只放行本机地址，
 * 其余一律抛错。需要网络行为的用例用 vi.stubGlobal 桩掉 fetch
 * （如 OpenRouter 授权交换）；忘记注入时在这里暴露，而不是悄悄联网。
 * 与 packages/core/test/setup-offline.ts 同一份策略。
 */
const realFetch = globalThis.fetch;

globalThis.fetch = (input, init) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    return Promise.reject(new Error(`默认测试集禁止联网：${url.href}`));
  }
  return realFetch(input, init);
};
