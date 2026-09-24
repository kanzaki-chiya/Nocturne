/**
 * L2 摘要的模型调用（context.md 6.6）。请求组装与边界选择在 build.js；
 * 本文件只做 provider 侧的一次流式调用——手动 /compact 与自动 L2 共用。
 */
import type { ModelRequest, ResolvedModel } from "../provider/index.js";

/**
 * 执行一次摘要调用（context.md 6.6：只尝试一轮，不嵌套压缩）。
 * 手动 /compact 与自动 L2 共用；返回摘要正文（空白视为失败，抛错）。
 */
export async function runSummaryCall(
  model: ResolvedModel,
  request: ModelRequest,
  signal: AbortSignal,
): Promise<string> {
  let summary = "";
  for await (const ev of model.provider.stream(request, signal)) {
    if (ev.type === "text_delta") summary += ev.text;
    if (ev.type === "finish") break;
  }
  if (summary.trim().length === 0) {
    throw new Error("摘要结果为空");
  }
  return summary;
}
