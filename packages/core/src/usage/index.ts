import {
  decodeDurableEvent,
  estimateCost,
  firstUserText,
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
  requests: RequestRecord[];
  turns: TurnRecord[];
  tools: NamedRecord[];
  skills: NamedRecord[];
}
const dateKey = (time: number): string => {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
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
    turns: [],
    tools: [],
    skills: [],
  };
  const starts = new Map<string, TurnRecord>();
  let current: ModelRef | undefined;
  let seq = 0;
  if (!text.endsWith("\n")) throw new Error("unterminated log");
  for (const line of text.trimEnd().split("\n")) {
    const e = decodeDurableEvent(line);
    if (e.seq !== ++seq) throw new Error("invalid sequence");
    const time = Date.parse(e.time);
    if (!Number.isFinite(time)) throw new Error("invalid time");
    if (seq === 1 && e.type !== "session.created") throw new Error("missing session.created");
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
        result.tools.push({ time, name: e.payload.name });
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
}) {
  const cache = new Map<
    string,
    { size: number; mtimeMs: number; aggregate?: FileAggregate | undefined }
  >();
  return async (input: { days?: number } = {}): Promise<UsageStats> => {
    if (input.days !== undefined && (!Number.isInteger(input.days) || input.days <= 0))
      throw new Error("days 必须是正整数");
    const since = new Date();
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
      tools: [],
      skills: [],
      unpricedModels: [],
      skippedFiles: 0,
    };
    const models = new Map<string, ModelUsageStats>();
    const days = new Map<string, DailyUsageStats>();
    const tools = new Map<string, number>();
    const skills = new Map<string, number>();
    const live = new Set<string>();
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
        m = { ...empty(), model: ref, turns: 0, cacheHitRate: 0, ...deps.pricing(ref) };
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
      let included = false;
      for (const r of aggregate.requests) {
        const prices = deps.pricing(r.model)?.pricing;
        const cost = estimateCost(r.usage, prices);
        const d = day(r.time);
        d.tokens += r.usage.inputTokens + r.usage.outputTokens;
        d.cost += cost?.total ?? 0;
        if (r.time < cutoff) continue;
        included = true;
        const m = model(r.model);
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
