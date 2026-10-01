/**
 * 思考强度（reasoningEffort，ADR-0018）真实服务冒烟——与默认测试集分离。
 * 运行：pnpm test:smoke；需要环境变量：
 *   NOCTURNE_SMOKE_BASE_URL / NOCTURNE_SMOKE_API_KEY / NOCTURNE_SMOKE_MODEL
 *     openai 格式端点（commandcode）
 *   NOCTURNE_SMOKE_ANTHROPIC_API_KEY / NOCTURNE_SMOKE_ANTHROPIC_MODEL /
 *   NOCTURNE_SMOKE_ANTHROPIC_BASE_URL
 *     openrouter 格式端点（借 anthropic 变量组，base_url 指向 openrouter.ai）
 * 未设置时跳过。Anthropic 协议无 Claude 端点，格式映射只有单测（未实测）。
 *
 * 断言策略：档位是否被服务接受由上游决定，测试不因 400 判失败；
 * 凡是 invalid_request 必须携带"该模型可能不支持档位"的定向提示；
 * off 在两端都必须成功（不接受才是代码问题）。openrouter/free 路由不稳定，
 * 网络/超时/限流只记录不判失败。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../src/index.js";
import type { OpenAICompatibleConfig } from "../src/provider/index.js";
import type { ReasoningEffort, RuntimeEvent, TurnCompletedPayload } from "../src/protocol/index.js";
import { REASONING_EFFORT_LEVELS } from "../src/protocol/index.js";

const OAI_BASE = process.env.NOCTURNE_SMOKE_BASE_URL;
const OAI_KEY = process.env.NOCTURNE_SMOKE_API_KEY;
const OAI_MODEL = process.env.NOCTURNE_SMOKE_MODEL;
const OR_BASE = process.env.NOCTURNE_SMOKE_ANTHROPIC_BASE_URL;
const OR_KEY = process.env.NOCTURNE_SMOKE_ANTHROPIC_API_KEY;
const OR_MODEL = process.env.NOCTURNE_SMOKE_ANTHROPIC_MODEL;

const oaiConfigured = OAI_BASE !== undefined && OAI_KEY !== undefined && OAI_MODEL !== undefined;
const orConfigured = OR_BASE !== undefined && OR_KEY !== undefined && OR_MODEL !== undefined;

const tmpRoots: string[] = [];
afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const makeTmp = (p: string) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  tmpRoots.push(d);
  return d;
};

interface Row {
  level: string;
  outcome: string;
  reasoningTokens: number | undefined;
  detail: string;
}

async function runLevel(
  entry: OpenAICompatibleConfig,
  model: string,
  level: ReasoningEffort,
): Promise<Row> {
  const runtime = await createRuntime({
    cwd: makeTmp("nct-effort-ws-"),
    sessionsDir: makeTmp("nct-effort-sd-"),
    providerConfigs: [entry],
    permissions: { autoApproveAsk: true },
  });
  const session = await runtime.createSession({
    model: `${entry.id}/${model}`,
    reasoningEffort: level,
  });
  const events: RuntimeEvent[] = [];
  session.subscribe((e) => events.push(e));
  try {
    const reason = await session.submit({ text: "只回复单词 ok。" });
    const done = events.find((e) => e.type === "turn.completed");
    const payload = done?.payload as TurnCompletedPayload | undefined;
    const rt = payload?.usage.reasoningTokens;
    const err = payload?.error;
    return {
      level,
      outcome: reason === "done" ? "done" : (err?.code ?? reason),
      reasoningTokens: rt,
      detail: err?.message ?? "",
    };
  } finally {
    await session.close();
  }
}

function printTable(title: string, rows: Row[]): void {
  const line = (r: Row) =>
    `  ${r.level.padEnd(8)} ${r.outcome.padEnd(28)} reasoning_tokens=${r.reasoningTokens ?? "-"}`;
  console.log(`\n[reasoningEffort 冒烟] ${title}\n${rows.map(line).join("\n")}\n`);
  for (const r of rows) {
    if (r.outcome === "provider_invalid_request") console.log(`  ${r.level} 提示：${r.detail}`);
  }
}

const ALL = ["off", ...REASONING_EFFORT_LEVELS] as const;

describe.skipIf(!oaiConfigured)("reasoningEffort 冒烟：openai 格式（commandcode）", () => {
  it("全档位逐一发送：off 必须成功，invalid_request 必须有档位定向提示", async () => {
    const entry: OpenAICompatibleConfig = {
      id: "smoke-oai",
      type: "openai-compatible",
      baseURL: OAI_BASE ?? "",
      apiKeyEnv: "NOCTURNE_SMOKE_API_KEY",
      models: {
        // 逐模型声明全部六档——服务端是否真接受由响应判定，这是实测的目的
        [OAI_MODEL ?? ""]: {
          capabilities: {
            toolCalls: true,
            parallelToolCalls: true,
            reasoning: "visible",
            imageInput: false,
            promptCache: false,
            editTool: "edit",
            reasoningEffort: [...REASONING_EFFORT_LEVELS],
          },
        },
      },
    };
    const rows: Row[] = [];
    for (const level of ALL) rows.push(await runLevel(entry, OAI_MODEL ?? "", level));
    printTable(`openai 格式 ${OAI_MODEL} @ ${OAI_BASE}`, rows);
    for (const r of rows) {
      if (r.outcome === "provider_invalid_request") {
        expect(r.detail).toContain("可能不支持档位");
        expect(r.detail).toContain("/provider thinking");
      }
    }
    expect(rows.find((r) => r.level === "off")?.outcome).toBe("done");
  }, 300_000);
});

describe.skipIf(!orConfigured)("reasoningEffort 冒烟：openrouter 格式（openrouter.ai）", () => {
  it("全档位逐一发送：接受情况记录；invalid_request 必须有档位定向提示", async () => {
    const entry: OpenAICompatibleConfig = {
      id: "smoke-or",
      type: "openai-compatible",
      baseURL: OR_BASE ?? "",
      apiKeyEnv: "NOCTURNE_SMOKE_ANTHROPIC_API_KEY",
      // openrouter 预设形状：reasoning: { effort }
      thinking: { format: "openrouter" },
      models: {
        [OR_MODEL ?? ""]: {
          capabilities: {
            toolCalls: true,
            parallelToolCalls: true,
            reasoning: "visible",
            imageInput: false,
            promptCache: false,
            editTool: "edit",
            reasoningEffort: [...REASONING_EFFORT_LEVELS],
          },
        },
      },
    };
    const rows: Row[] = [];
    for (const level of ALL) rows.push(await runLevel(entry, OR_MODEL ?? "", level));
    printTable(`openrouter 格式 ${OR_MODEL} @ ${OR_BASE}`, rows);
    for (const r of rows) {
      if (r.outcome === "provider_invalid_request") {
        expect(r.detail).toContain("可能不支持档位");
        expect(r.detail).toContain("/provider thinking");
      }
      // 免费路由不稳定：network/timeout/overloaded/rate_limit 记录不判失败；
      // 但不能出现 unknown/未分类错误（那是映射缺口）
      expect(r.outcome === "done" || r.outcome.startsWith("provider_")).toBe(true);
    }
  }, 300_000);
});
