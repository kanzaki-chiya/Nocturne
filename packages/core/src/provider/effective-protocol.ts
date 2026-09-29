/**
 * 生效协议的装配期解析（ADR-0026 §1、§5）：把 merged 配置层的
 * protocol/endpoints 声明翻译为 ModelInfo 上的 protocol/unavailable 标记。
 * 推导规则本身是 protocol 层的纯函数；本文件只做盖章与文案。
 */
import {
  resolveEffectiveProtocol,
  unavailableProtocolReason,
  type EffectiveProtocol,
  type ModelProtocol,
} from "../protocol/index.js";
import type { ModelInfo } from "./types.js";

export { unavailableProtocolReason };

export function isModelProtocol(t: string): t is ModelProtocol {
  return t === "openai-compatible" || t === "anthropic";
}

/**
 * 在 ModelInfo 上解析生效协议（幂等）：
 * - 可识别 → protocol 置为生效协议，清除 unavailable；
 * - "unavailable" → 清除 protocol，置 unavailable.reason；
 * - 上游未声明 endpoints → protocol 为声明值或条目 type（ADR-0026 §2）。
 */
export function withEffectiveProtocol(model: ModelInfo, entryType: ModelProtocol): ModelInfo {
  const effective: EffectiveProtocol = resolveEffectiveProtocol(
    model.protocol,
    model.endpoints,
    entryType,
  );
  if (effective === "unavailable") {
    const { protocol: _p, ...rest } = model;
    return {
      ...rest,
      unavailable: { reason: unavailableProtocolReason(model.endpoints ?? []) },
    };
  }
  const { unavailable: _u, ...rest } = model;
  return { ...rest, protocol: effective };
}
