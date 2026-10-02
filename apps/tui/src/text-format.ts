/** 逐行 CLI 可静态加载的纯文本入口，不导入 React 或 Ink。 */
export { stripControls, truncateMiddle } from "./format.js";

export function providerCredentialDescription(p: {
  auth?: string | undefined;
  credentialStatus?: "valid" | "expiring" | "expired" | "missing" | undefined;
  credentialStorage?: "system" | "plaintext" | "memory" | undefined;
}): string {
  const status = { valid: "有效", expiring: "即将过期", expired: "已失效", missing: "缺少" };
  const storage = { system: "系统保存", plaintext: "明文保存", memory: "仅本次运行" };
  return [
    p.auth,
    p.credentialStatus && status[p.credentialStatus],
    p.credentialStorage && storage[p.credentialStorage],
  ]
    .filter(Boolean)
    .join(" • ");
}
