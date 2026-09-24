/**
 * FakeProvider：按脚本返回流式事件的确定性 Provider。
 * Phase 1 集成测试的主 Provider，不依赖任何网络服务。
 * 每次 stream() 消费一份脚本；脚本用完后返回默认的 finish。
 */
import { abortError } from "./errors.js";
import type { ModelInfo, ModelRequest, ModelStreamEvent, Provider } from "./types.js";

/** 脚本条目：正常流式事件，或 throw（模拟 ProviderError / 任意异常） */
export type FakeScriptEvent = ModelStreamEvent | { type: "throw"; error: unknown };

export type FakeScript = FakeScriptEvent[];

export type FakeHandler = (
  request: ModelRequest,
  callIndex: number,
) => FakeScript | Promise<FakeScript>;

const DEFAULT_MODEL: ModelInfo = {
  ref: { provider: "fake", model: "fake-1" },
  displayName: "Fake Model",
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  capabilities: {
    toolCalls: true,
    parallelToolCalls: true,
    reasoning: "visible",
    imageInput: false,
    promptCache: false,
  },
};

export class FakeProvider implements Provider {
  readonly id: string;
  readonly type = "fake";
  readonly strictModels: boolean;
  /** 已收到的全部请求（测试断言用） */
  readonly requests: ModelRequest[] = [];
  private readonly modelInfos: ModelInfo[];
  private readonly source: FakeScript[] | FakeHandler;
  private callCount = 0;

  constructor(options: {
    id?: string | undefined;
    models?: ModelInfo[] | undefined;
    /** false 时接受清单外的模型 id（见 Provider.strictModels） */
    strictModels?: boolean | undefined;
    /** 每次 stream() 消费一份脚本 */
    scripts?: FakeScript[] | undefined;
    /** 或按请求动态生成脚本 */
    handler?: FakeHandler | undefined;
  }) {
    this.id = options.id ?? "fake";
    this.strictModels = options.strictModels ?? true;
    this.modelInfos = options.models ?? [
      { ...DEFAULT_MODEL, ref: { provider: this.id, model: "fake-1" } },
    ];
    this.source = options.handler ?? options.scripts ?? [];
  }

  models(): ModelInfo[] {
    return this.modelInfos;
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const index = this.callCount++;
    const script =
      typeof this.source === "function"
        ? await this.source(request, index)
        : (this.source[index] ?? [{ type: "finish", reason: "stop" } satisfies ModelStreamEvent]);
    let sawFinish = false;
    for (const ev of script) {
      if (signal.aborted) throw abortError();
      if (ev.type === "throw") {
        throw ev.error;
      }
      if (ev.type === "finish") sawFinish = true;
      yield ev;
      if (sawFinish) return; // finish 之后不再有事件
    }
    // 契约兜底：成功的流以 finish 结束
    yield { type: "finish", reason: "stop" };
  }
}
