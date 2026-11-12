import { describe, expect, it } from "vitest";
import type { SwarmMemberView, SwarmPostView, SwarmView } from "@nocturne/core/protocol";

import {
  filterSwarmPosts,
  formatSwarmTime,
  groupSwarmMembers,
  shortModelName,
  splitSwarmMentions,
  swarmActivitySummary,
  swarmAuthorLabel,
  swarmCoordinatorDot,
  swarmEntryCounts,
  swarmMemberDot,
  swarmMentionLabel,
  swarmStatusDot,
  swarmToolSummary,
} from "../src/swarm-ui";
import { mcpToolLabel, toolMeta } from "../src/tool-meta";

function makeMember(
  name: string,
  overrides: Partial<SwarmMemberView> = {},
): SwarmMemberView {
  return {
    name,
    childSessionId: `child-${name}`,
    charter: { owns: `${name}.ts`, handsOff: "other", doneWhen: "pass" },
    model: { provider: "anthropic", model: "claude-opus-5.5" },
    preset: "general",
    isolated: false,
    status: "waiting",
    pendingPermissions: [],
    ...overrides,
  };
}

function makePost(
  number: number,
  overrides: Partial<SwarmPostView> = {},
): SwarmPostView {
  return {
    seq: number,
    time: "2026-11-12T13:31:00.000Z",
    number,
    from: "coordinator",
    fromKind: "coordinator",
    text: "默认正文",
    mentions: [],
    recipients: [],
    ...overrides,
  };
}

describe("toolMeta Swarm 工具标签与参数", () => {
  it("七个 Swarm 工具显示规定的标签", () => {
    expect(toolMeta("swarm_init").label).toBe("Swarm");
    expect(toolMeta("swarm_add_member").label).toBe("添加");
    expect(toolMeta("swarm_post").label).toBe("发帖");
    expect(toolMeta("swarm_change_model").label).toBe("换模型");
    expect(toolMeta("swarm_remove_member").label).toBe("移除");
    expect(toolMeta("swarm_end").label).toBe("结束");
    expect(toolMeta("swarm_checkout").label).toBe("检出");
  });

  it("保留原有内置工具和 MCP 名称映射", () => {
    expect(toolMeta("shell").label).toBe("命令");
    expect(toolMeta("edit").label).toBe("编辑");
    expect(mcpToolLabel("mcp__github__list_prs")).toBe("github/list_prs");
  });

  it("swarmToolSummary 提取单行参数摘要", () => {
    expect(swarmToolSummary("swarm_init", { title: "  API 输入校验\n次行  " })).toBe("API 输入校验");
    expect(swarmToolSummary("swarm_add_member", { name: "users", preset: "general" })).toBe(
      "@users",
    );
    expect(swarmToolSummary("swarm_post", { text: "\n  第一行任务分配 \n第二行" })).toBe(
      "第一行任务分配",
    );
    expect(
      swarmToolSummary("swarm_change_model", { name: "verifier", model: "openai/gpt-6.1-sol" }),
    ).toBe("@verifier gpt-6.1-sol");
    expect(swarmToolSummary("swarm_remove_member", { name: "schema" })).toBe("@schema");
    expect(swarmToolSummary("swarm_end", {})).toBe("");
    expect(swarmToolSummary("swarm_end", { summary: "全部并回\n补充说明" })).toBe("全部并回");
    expect(swarmToolSummary("swarm_checkout", { member: "orders" })).toBe("@orders");
    expect(swarmToolSummary("shell", { command: "pnpm test" })).toBeUndefined();
  });
});

describe("SwarmActivity 活动摘要组词", () => {
  it("按 tool / permission / paused / post / charter / removed 组成界面文字", () => {
    expect(swarmActivitySummary({ kind: "tool", tool: "shell", detail: "pnpm test" })).toBe(
      "命令 pnpm test",
    );
    expect(swarmActivitySummary({ kind: "tool", tool: "read" })).toBe("读取");
    expect(swarmActivitySummary({ kind: "permission", target: "pnpm add zod" })).toBe(
      "等待确认：pnpm add zod",
    );
    expect(swarmActivitySummary({ kind: "permission" })).toBe("等待确认");
    expect(
      swarmActivitySummary({ kind: "paused", code: "rate_limit", message: "429 Too Many Requests" }),
    ).toBe("429 Too Many Requests");
    expect(
      swarmActivitySummary({
        kind: "paused",
        code: "session_not_found",
        message: "Session not found",
      }),
    ).toBe("找不到这个子代理的日志，可能已被删除");
    expect(swarmActivitySummary({ kind: "post", number: 11, line: "已改：数量为 0 时返回 400" })).toBe(
      "已改：数量为 0 时返回 400",
    );
    expect(swarmActivitySummary({ kind: "charter", line: "src/routes/users.ts" })).toBe(
      "src/routes/users.ts",
    );
    expect(swarmActivitySummary({ kind: "removed", reason: "并回后移除" })).toBe("并回后移除");
    expect(swarmActivitySummary({ kind: "removed" })).toBe("");
  });
});

describe("作者、提及、筛选、搜索与分组", () => {
  it("作者与提及遵循统一显示规则", () => {
    expect(swarmAuthorLabel("coordinator", "coordinator")).toBe("协调者");
    expect(swarmAuthorLabel("user", "user")).toBe("你");
    expect(swarmAuthorLabel("runtime", "runtime")).toBe("Runtime");
    expect(swarmAuthorLabel("orders", "member")).toBe("@orders");

    expect(swarmMentionLabel("coordinator")).toBe("协调者");
    expect(swarmMentionLabel("all")).toBe("@all");
    expect(swarmMentionLabel("verifier")).toBe("@verifier");
  });

  it("按成员筛选命中 from 等于该成员或 recipients 含该成员的帖子，并与搜索取交集", () => {
    const posts = [
      makePost(1, {
        from: "coordinator",
        fromKind: "coordinator",
        mentions: ["users", "orders"],
        recipients: ["users", "orders"],
        text: "请 @users 与 @orders 开始",
      }),
      makePost(2, {
        from: "users",
        fromKind: "member",
        mentions: ["all"],
        recipients: ["coordinator", "orders", "verifier"],
        text: "共用 validate.ts 我来建",
      }),
      makePost(3, {
        from: "orders",
        fromKind: "member",
        mentions: ["verifier"],
        recipients: ["verifier"],
        text: "已交付 orders.ts",
      }),
    ];
    expect(filterSwarmPosts(posts, { member: "users" }).map((p) => p.number)).toEqual([1, 2]);
    expect(filterSwarmPosts(posts, { member: "verifier" }).map((p) => p.number)).toEqual([2, 3]);
    expect(
      filterSwarmPosts(posts, { member: "verifier", query: "VALIDATE" }).map((p) => p.number),
    ).toEqual([2]);
    expect(filterSwarmPosts(posts, { query: "@orders" }).map((p) => p.number)).toEqual([1, 3]);
    expect(filterSwarmPosts(posts, { query: "已交付" }).map((p) => p.number)).toEqual([3]);
  });

  it("成员分组与状态圆点：进行中区分 work / ask / pause / wait / retired，结束后统一为 wait", () => {
    const members = [
      makeMember("verifier", { status: "working" }),
      makeMember("products", {
        status: "working",
        pendingPermissions: [
          { requestId: "r1", callId: "c1", reason: "cmd", subjects: [], options: [] },
        ],
      }),
      makeMember("broken", { status: "paused" }),
      makeMember("orders", { status: "waiting" }),
      makeMember("schema", { status: "removed" }),
    ];
    const groups = groupSwarmMembers(members);
    expect(groups.working.map((m) => m.name)).toEqual(["verifier", "products"]);
    expect(groups.paused.map((m) => m.name)).toEqual(["broken"]);
    expect(groups.waiting.map((m) => m.name)).toEqual(["orders"]);
    expect(groups.removed.map((m) => m.name)).toEqual(["schema"]);

    expect(swarmMemberDot(members[0]!, "active")).toBe("work");
    expect(swarmMemberDot(members[1]!, "active")).toBe("ask");
    expect(swarmMemberDot(members[2]!, "active")).toBe("pause");
    expect(swarmMemberDot(members[3]!, "active")).toBe("wait");
    expect(swarmMemberDot(members[4]!, "active")).toBe("retired");

    expect(swarmMemberDot(members[0]!, "ended")).toBe("wait");
    expect(swarmMemberDot(members[1]!, "ended")).toBe("wait");
    expect(swarmMemberDot(members[4]!, "ended")).toBe("retired");
  });

  it("入口行计数只计未移除成员，状态点区分 ok / warn / 已结束无点", () => {
    const swarm: SwarmView = {
      createdSeq: 2,
      title: "API 输入校验",
      status: "active",
      coordinator: {
        model: { provider: "a", model: "claude" },
        status: "waiting",
        awaitingPermission: false,
      },
      members: [
        makeMember("users"),
        makeMember("orders"),
        makeMember("schema", { status: "removed" }),
      ],
      awaitingPermissionMembers: [],
      posts: [makePost(1), makePost(2), makePost(3)],
    };
    expect(swarmEntryCounts(swarm)).toBe("2 · 3");
    expect(swarmStatusDot(swarm)).toBe("ok");
    expect(swarmStatusDot({ ...swarm, awaitingPermissionMembers: ["orders"] })).toBe("warn");
    expect(
      swarmStatusDot({ ...swarm, status: "ended", awaitingPermissionMembers: ["orders"] }),
    ).toBeUndefined();
    expect(swarmCoordinatorDot(swarm)).toBe("wait");
    expect(
      swarmCoordinatorDot({
        ...swarm,
        coordinator: { ...swarm.coordinator, status: "working", awaitingPermission: true },
      }),
    ).toBe("ask");
  });

  it("splitSwarmMentions 只强调出现在 mentions 里的 @token，忽略不在 mentions 里的词和半截词", () => {
    expect(
      splitSwarmMentions(
        "请 @users 处理，@unknown 装饰器与 @users-extra 不动，回贴找 @协调者",
        ["users", "coordinator"],
      ),
    ).toEqual([
      { kind: "text", value: "请 " },
      { kind: "mention", value: "@users" },
      { kind: "text", value: " 处理，@unknown 装饰器与 @users-extra 不动，回贴找 " },
      { kind: "mention", value: "@协调者" },
    ]);
  });

  it("shortModelName 与 formatSwarmTime 正常格式化", () => {
    expect(shortModelName({ provider: "openai", model: "gpt-6.1-sol" })).toBe("gpt-6.1-sol");
    expect(shortModelName("anthropic/claude-opus-5.5")).toBe("claude-opus-5.5");
    expect(formatSwarmTime("invalid")).toBe("");
    expect(formatSwarmTime("2026-11-12T13:05:00.000Z")).toMatch(/^\d{2}:\d{2}$/);
  });
});
