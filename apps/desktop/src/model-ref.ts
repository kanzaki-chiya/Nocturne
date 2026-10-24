import type { ModelRef } from "@nocturne/core/protocol";

/**
 * 文案规则 R2：模型引用统一写「provider · model」，桌面与手机共用这一处拼接。
 * 状态栏把 provider 段做成可隐藏的独立元素，用 MODEL_REF_SEPARATOR 自己拼。
 */
export const MODEL_REF_SEPARATOR = " · ";

export function modelRefText(ref: Pick<ModelRef, "provider" | "model">): string {
  return `${ref.provider}${MODEL_REF_SEPARATOR}${ref.model}`;
}

/** "provider/model" → "provider · model"；没有斜杠时原样返回 */
export function modelKeyText(key: string): string {
  const at = key.indexOf("/");
  return at < 0 ? key : modelRefText({ provider: key.slice(0, at), model: key.slice(at + 1) });
}
