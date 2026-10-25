import {
  decodeDurableEvent,
  estimateCost,
  firstUserText,
  generationMs,
  performanceGranularity,
  MIN_GENERATION_MS,
  PERFORMANCE_MAX_BUCKETS,
  type AssistantTiming,
  type DailyModelUsage,
  type PerformanceGranularity,
  type PerformancePoint,
  type ModelRef,
  type Usage,
  type UsageStats,
  type UsageTotals,
  type ModelUsageStats,
  type DailyUsageStats,
  type ModelPricing,
  type PricingSource,
} from "../protocol/index.js";
import { fsErrorCode, type Platform } from "../platform/index.js";
import { SKILL_TOOL_NAME } from "../tools/builtin/skill.js";

interface RequestRecord {
  time: number;
  model: ModelRef;
  usage: Usage;
  turnId?: string | undefined;
}
/** 带 timing 的 message.assistant（不要求有 usage） */
interface TimingRecord {
  time: number;
  model: ModelRef;
  timing: AssistantTiming;
  outputTokens?: number | undefined;
}
interface TurnRecord {
  time: number;
  durationMs?: number | undefined;
  model: ModelRef;
  id: string;
}
interface NamedRecord {
  time: number;
  name: string;
}
interface FileAggregate {
  title: string;
  child: boolean;
  forkTime?: number | undefined;
  requests: RequestRecord[];
  timings: TimingRecord[];
  turns: TurnRecord[];
  tools: NamedRecord[];
  skills: NamedRecord[];
}
const dateKey = (time: number): string => {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** 本地时间的桶起点（毫秒）：小时、自然日或周一 0 点 */
export function bucketStart(time: number, granularity: PerformanceGranularity): number {
  const d = new Date(time);
  if (granularity === "hour") {
    d.setMinutes(0, 0, 0);
    return d.getTime();
  }
  d.setHours(0, 0, 0, 0);
  if (granularity === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}
/** 延迟与速度的累加器：Tokens/s 按合计相除，不对逐条速度求平均 */
interface LatencyAccumulator {
  samples: number;
  durationMs: number;
  ttftSamples: number;
  ttftMs: number;
  speedSamples: number;
  outputTokens: number;
  generationMs: number;
}
const latencyAccumulator = (): LatencyAccumulator => ({
  samples: 0,
  durationMs: 0,
  ttftSamples: 0,
  ttftMs: 0,
  speedSamples: 0,
  outputTokens: 0,
  generationMs: 0,
});
function addTiming(acc: LatencyAccumulator, r: TimingRecord): void {
  acc.samples++;
  acc.durationMs += r.timing.durationMs;
  if (r.timing.ttftMs !== undefined) {
    acc.ttftSamples++;
    acc.ttftMs += r.timing.ttftMs;
  }
  const generation = generationMs(r.timing);
  if (r.outputTokens !== undefined && generation !== undefined && generation >= MIN_GENERATION_MS) {
    acc.speedSamples++;
    acc.outputTokens += r.outputTokens;
    acc.generationMs += generation;
  }
}
const tokensPerSecond = (acc: LatencyAccumulator) =>
  acc.speedSamples > 0 ? acc.outputTokens / (acc.generationMs / 1000) : undefined;
const avgTtft = (acc: LatencyAccumulator) =>
  acc.ttftSamples > 0 ? acc.ttftMs / acc.ttftSamples : undefined;
const modelKey = (model: ModelRef): string => `${model.provider}/${model.model}`;
const modelRef = (value: string): ModelRef => {
  const slash = value.indexOf("/");
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
};
const empty = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
});
function parse(text: string): FileAggregate {
  const result: FileAggregate = {
    title: "",
    child: false,
    requests: [],
    timings: [],
    turns: [],
    tools: [],
    skills: [],
  };
  const starts = new Map<string, TurnRecord>();
  let current: ModelRef | undefined;
  let forkId: string | undefined;
  let seq = 0;
  if (!text.endsWith("\n")) throw new Error("unterminated log");
  for (const line of text.trimEnd().split("\n")) {
    const e = decodeDurableEvent(line);
    if (e.seq !== ++seq) throw new Error("invalid sequence");
    const time = Date.parse(e.time);
    if (!Number.isFinite(time)) throw new Error("invalid time");
    if (seq === 1 && e.type !== "session.created") throw new Error("missing session.created");
    if (seq === 1 && e.type === "session.created" && e.payload.forkedFrom) {
      forkId = e.sessionId;
      result.forkTime = time;
    }
    if (forkId !== undefined && e.sessionId !== forkId) {
      // 继承的模型配置仍决定分叉的新 Turn；复制的消耗与活动不计入。
      if (e.type === "session.config_changed") current = e.payload.model ?? current;
      continue;
    }
    switch (e.type) {
      case "session.created":
        current = e.payload.model;
        result.child = e.payload.parent !== undefined;
        break;
      case "session.config_changed":
        current = e.payload.model ?? current;
        break;
      case "message.user":
        if (!result.title) result.title = firstUserText(e.payload) ?? "";
        if (e.payload.skill) result.skills.push({ time, name: e.payload.skill.name });
        break;
      case "session.titled":
        result.title = e.payload.title;
        if (e.payload.usage)
          result.requests.push({ time, usage: e.payload.usage, model: modelRef(e.payload.model) });
        break;
      case "attachment.described":
        if (e.payload.usage)
          result.requests.push({
            time,
            usage: e.payload.usage,
            model: modelRef(e.payload.model),
            turnId: e.turnId,
          });
        break;
      case "message.assistant":
        if (e.payload.timing)
          result.timings.push({
            time,
            model: e.payload.model,
            timing: e.payload.timing,
            outputTokens: e.payload.usage?.outputTokens,
          });
        if (e.payload.usage)
          result.requests.push({
            time,
            usage: e.payload.usage,
            model: e.payload.model,
            turnId: e.turnId,
          });
        break;
      case "context.compacted":
        if (e.payload.usage && e.payload.model)
          result.requests.push({
            time,
            usage: e.payload.usage,
            model: e.payload.model,
            turnId: e.turnId,
          });
        break;
      case "permission.reviewed":
        if (!e.payload.cached && e.payload.usage && e.payload.model)
          result.requests.push({
            time,
            usage: e.payload.usage,
            model: e.payload.model,
            turnId: e.turnId,
          });
        break;
      case "turn.started": {
        if (!current || !e.turnId) break;
        const turn = { time, model: current, id: e.turnId };
        starts.set(e.turnId, turn);
        result.turns.push(turn);
        break;
      }
      case "turn.completed": {
        const start = starts.get(e.turnId ?? "");
        if (start) start.durationMs = Math.max(0, time - start.time);
        break;
      }
      case "tool.started":
        result.tools.push({ time, name: e.payload.target?.name ?? e.payload.name });
        if (e.payload.name === SKILL_TOOL_NAME) {
          const input = e.payload.input as { name?: unknown } | null;
          if (typeof input?.name === "string") result.skills.push({ time, name: input.name });
        }
        break;
    }
  }
  return result;
}

/** 只读扫描；缓存用量而不是费用，当前价格变更立即重新计价。 */
export function createUsageStats(deps: {
  platform: Platform;
  sessionsDir: string;
  pricing: (
    model: ModelRef,
  ) =>
    { pricing?: ModelPricing | undefined; pricingSource?: PricingSource | undefined } | undefined;
  /** 墙钟（毫秒），决定 days 的起点；测试注入 */
  now?: (() => number) | undefined;
}) {
  const cache = new Map<
    string,
    { size: number; mtimeMs: number; aggregate?: FileAggregate | undefined }
  >();
  return async (input: { days?: number } = {}): Promise<UsageStats> => {
    if (input.days !== undefined && (!Number.isInteger(input.days) || input.days <= 0))
      throw new Error("days 必须是正整数");
    const since = new Date(deps.now?.() ?? Date.now());
    since.setHours(0, 0, 0, 0);
    if (input.days !== undefined) since.setDate(since.getDate() - input.days + 1);
    const cutoff = input.days === undefined ? -Infinity : since.getTime();
    const stats: UsageStats = {
      totals: empty(),
      sessions: 0,
      turns: 0,
      subagentTurns: 0,
      daily: [],
      models: [],
      performanceGranularity: performanceGranularity(input.days),
      tools: [],
      skills: [],
      unpricedModels: [],
      skippedFiles: 0,
    };
    const granularity = stats.performanceGranularity;
    const models = new Map<string, ModelUsageStats>();
    /** 每个模型的延迟、性能桶、缓存节省与首末时间；结束时折叠进 ModelUsageStats */
    const extra = new Map<
      string,
      {
        latency: LatencyAccumulator;
        buckets: Map<number, LatencyAccumulator>;
        fullInputCost: number;
        actualInputCost: number;
        first: number;
        last: number;
      }
    >();
    const extraFor = (ref: ModelRef) => {
      const key = modelKey(ref);
      let x = extra.get(key);
      if (!x) {
        x = {
          latency: latencyAccumulator(),
          buckets: new Map(),
          fullInputCost: 0,
          actualInputCost: 0,
          first: Infinity,
          last: -Infinity,
        };
        extra.set(key, x);
      }
      return x;
    };
    const dailyModels = new Map<string, Map<string, DailyModelUsage>>();
    const days = new Map<string, DailyUsageStats>();
    const tools = new Map<string, number>();
    const skills = new Map<string, number>();
    const live = new Set<string>();
    const priceTable = new Map<string, ReturnType<typeof deps.pricing>>();
    const pricingFor = (ref: ModelRef) => {
      const key = modelKey(ref);
      if (!priceTable.has(key)) priceTable.set(key, deps.pricing(ref));
      return priceTable.get(key);
    };
    const day = (time: number) => {
      const date = dateKey(time);
      let d = days.get(date);
      if (!d) {
        d = { date, tokens: 0, cost: 0, turns: 0 };
        days.set(date, d);
      }
      return d;
    };
    const model = (ref: ModelRef) => {
      const key = modelKey(ref);
      let m = models.get(key);
      if (!m) {
        m = {
          ...empty(),
          model: ref,
          turns: 0,
          requests: 0,
          cacheHitRate: 0,
          performance: [],
          ...pricingFor(ref),
        };
        models.set(key, m);
      }
      return m;
    };
    let entries;
    try {
      entries = await deps.platform.fs.readdir(deps.sessionsDir);
    } catch (e) {
      if (fsErrorCode(e) === "ENOENT") return stats;
      throw e;
    }
    for (const entry of entries) {
      if (entry.type !== "file" || !entry.name.endsWith(".jsonl")) continue;
      live.add(entry.path);
      let aggregate: FileAggregate | undefined;
      try {
        const stat = await deps.platform.fs.stat(entry.path);
        const hit = cache.get(entry.path);
        if (hit?.size === stat.size && hit.mtimeMs === stat.mtimeMs) aggregate = hit.aggregate;
        else {
          try {
            aggregate = parse(await deps.platform.fs.readTextFile(entry.path));
          } catch {
            aggregate = undefined;
          }
          cache.set(entry.path, { size: stat.size, mtimeMs: stat.mtimeMs, aggregate });
        }
      } catch {
        aggregate = undefined;
      }
      if (!aggregate) {
        stats.skippedFiles++;
        continue;
      }
      let included = aggregate.forkTime !== undefined && aggregate.forkTime >= cutoff;
      for (const r of aggregate.requests) {
        const prices = pricingFor(r.model)?.pricing;
        const cost = estimateCost(r.usage, prices);
        const d = day(r.time);
        d.tokens += r.usage.inputTokens + r.usage.outputTokens;
        d.cost += cost?.total ?? 0;
        if (r.time < cutoff) continue;
        included = true;
        const m = model(r.model);
        m.requests++;
        d.requests = (d.requests ?? 0) + 1;
        const key = modelKey(r.model);
        let perDay = dailyModels.get(d.date);
        if (!perDay) dailyModels.set(d.date, (perDay = new Map<string, DailyModelUsage>()));
        let dm = perDay.get(key);
        if (!dm) perDay.set(key, (dm = { model: r.model, tokens: 0, requests: 0 }));
        dm.tokens += r.usage.inputTokens + r.usage.outputTokens;
        dm.requests++;
        const x = extraFor(r.model);
        x.first = Math.min(x.first, r.time);
        x.last = Math.max(x.last, r.time);
        if (cost && prices) {
          // 缓存节省：全部输入按输入价（同一档位规则）对比实际输入侧费用
          const full = estimateCost({ inputTokens: r.usage.inputTokens, outputTokens: 0 }, prices);
          x.fullInputCost += full?.input ?? 0;
          x.actualInputCost += cost.input + cost.cacheRead + cost.cacheWrite;
        }
        for (const total of [m, stats.totals]) {
          total.inputTokens += r.usage.inputTokens;
          total.outputTokens += r.usage.outputTokens;
          total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (r.usage.cacheReadTokens ?? 0);
          total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + (r.usage.cacheWriteTokens ?? 0);
          if (cost)
            for (const key of ["input", "cacheRead", "cacheWrite", "output", "total"] as const)
              total.cost[key] += cost[key];
        }
      }
      for (const r of aggregate.timings) {
        if (r.time < cutoff) continue;
        const x = extraFor(r.model);
        addTiming(x.latency, r);
        const start = bucketStart(r.time, granularity);
        let bucket = x.buckets.get(start);
        if (!bucket) x.buckets.set(start, (bucket = latencyAccumulator()));
        addTiming(bucket, r);
      }
      for (const t of aggregate.turns) {
        day(t.time).turns++;
        if (t.time < cutoff) continue;
        included = true;
        stats.turns++;
        if (aggregate.child) stats.subagentTurns++;
        model(t.model).turns++;
        if (t.durationMs !== undefined && t.durationMs > (stats.longestTurn?.durationMs ?? -1))
          stats.longestTurn = {
            durationMs: t.durationMs,
            date: dateKey(t.time),
            sessionTitle: aggregate.title,
          };
      }
      for (const [records, counts] of [
        [aggregate.tools, tools],
        [aggregate.skills, skills],
      ] as const) {
        for (const record of records)
          if (record.time >= cutoff) {
            included = true;
            counts.set(record.name, (counts.get(record.name) ?? 0) + 1);
          }
      }
      if (included) stats.sessions++;
    }
    for (const path of cache.keys()) if (!live.has(path)) cache.delete(path);
    stats.models = [...models.values()];
    for (const m of stats.models) {
      m.cacheHitRate = m.inputTokens ? (m.cacheReadTokens ?? 0) / m.inputTokens : 0;
      if (!m.pricing) stats.unpricedModels.push(m.model);
      const x = extra.get(modelKey(m.model));
      if (!x) continue;
      if (x.fullInputCost > 0)
        m.cacheSavings = (x.fullInputCost - x.actualInputCost) / x.fullInputCost;
      if (Number.isFinite(x.first)) {
        m.firstUsedAt = new Date(x.first).toISOString();
        m.lastUsedAt = new Date(x.last).toISOString();
      }
      const l = x.latency;
      const tps = tokensPerSecond(l);
      const ttft = avgTtft(l);
      if (l.samples > 0)
        m.latency = {
          samples: l.samples,
          avgDurationMs: l.durationMs / l.samples,
          ...(ttft !== undefined ? { avgTtftMs: ttft } : {}),
          ...(tps !== undefined ? { tokensPerSecond: tps } : {}),
          speedSamples: l.speedSamples,
        };
      m.performance = [...x.buckets]
        .sort(([a], [b]) => a - b)
        .slice(-PERFORMANCE_MAX_BUCKETS)
        .map(([start, b]): PerformancePoint => {
          const bucketTps = tokensPerSecond(b);
          const bucketTtft = avgTtft(b);
          return {
            start: new Date(start).toISOString(),
            samples: b.samples,
            ...(bucketTps !== undefined ? { tokensPerSecond: bucketTps } : {}),
            ...(bucketTtft !== undefined ? { avgTtftMs: bucketTtft } : {}),
          };
        });
    }
    for (const [date, perDay] of dailyModels) {
      const d = days.get(date);
      if (d) d.models = [...perDay.values()].sort((a, b) => b.tokens - a.tokens);
    }
    stats.daily = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
    const counts = (map: Map<string, number>) =>
      [...map]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    stats.tools = counts(tools);
    stats.skills = counts(skills);
    return stats;
  };
}
