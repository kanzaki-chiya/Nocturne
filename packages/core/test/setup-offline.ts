/**
 * 默认测试集完全离线（workflow.md 第 5 节）：全局 fetch 只放行本机地址，
 * 其余一律抛错。需要网络行为的用例应注入自己的 fetch（如 modelsDevFetch）
 * 或用 vi.stubGlobal 桩掉 fetch；忘记注入时在这里暴露，而不是悄悄联网。
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
