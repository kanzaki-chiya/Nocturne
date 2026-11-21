import { describe, expect, it } from "vitest";
import type {
  AggregatedPendingPermission,
  EnsembleMemberView,
  EnsemblePostView,
  EnsembleView,
  ToolEntry,
} from "@nocturne/core/protocol";

import {
  currentEnsembleInitKey,
  filterEnsemblePosts,
  formatEnsembleTime,
  groupEnsembleMembers,
  partitionEnsemblePermissions,
  shortModelName,
  splitEnsembleMentions,
  ensembleActivitySummary,
  ensembleAuthorColor,
  ensembleAuthorLabel,
  ensembleMaestroDot,
  ensembleMemberDot,
  ensembleMentionCandidates,
  ensembleMentionLabel,
  ensembleMentionToken,
  ensemblePostRecipients,
  ensemblePostHead,
  ensembleReadFilterParts,
  ensembleReadPostsFromOutput,
  ensembleStatusDot,
  ensembleToolSummary,
} from "../src/ensemble-ui";
import { mcpToolLabel, noteWriteSummary, toolMeta } from "../src/tool-meta";

function makeMember(name: string, overrides: Partial<EnsembleMemberView> = {}): EnsembleMemberView {
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

function makePost(number: number, overrides: Partial<EnsemblePostView> = {}): EnsemblePostView {
  return {
    seq: number,
    time: "2026-11-12T13:31:00.000Z",
    number,
    from: "maestro",
    fromKind: "maestro",
    text: "默认正文",
    mentions: [],
    recipients: [],
    ...overrides,
  };
}

describe("toolMeta Ensemble 工具标签与参数", () => {
  it("七个 Ensemble 工具及留言板/笔记显示规定的标签", () => {
    expect(toolMeta("ensemble_init").label).toBe("合奏");
    expect(toolMeta("ensemble_add_member").label).toBe("添加");
    expect(toolMeta("ensemble_post").label).toBe("发帖");
    expect(toolMeta("ensemble_read").label).toBe("留言板");
    expect(toolMeta("ensemble_change_model").label).toBe("换模型");
    expect(toolMeta("ensemble_remove_member").label).toBe("移除");
    expect(toolMeta("ensemble_end").label).toBe("结束");
    expect(toolMeta("ensemble_checkout").label).toBe("检出");
    expect(toolMeta("note_write").label).toBe("笔记");
  });

  it("保留原有内置工具和 MCP 名称映射", () => {
    expect(toolMeta("shell").label).toBe("命令");
    expect(toolMeta("edit").label).toBe("编辑");
    expect(toolMeta("update_goal").label).toBe("目标");
    expect(toolMeta("finish").label).toBe("提交结果");
    expect(toolMeta("mcp_call").label).toBe("调用 MCP 工具");
    expect(mcpToolLabel("mcp__github__list_prs")).toBe("github/list_prs");
  });

  it("ensembleToolSummary 提取单行参数摘要", () => {
    expect(ensembleToolSummary("ensemble_init", { title: "  API 输入校验\n次行  " })).toBe(
      "API 输入校验",
    );
    expect(ensembleToolSummary("ensemble_add_member", { name: "users", preset: "general" })).toBe(
      "@users",
    );
    expect(ensembleToolSummary("ensemble_post", { text: "\n  第一行任务分配 \n第二行" })).toBe(
      "第一行任务分配",
    );
    expect(
      ensembleToolSummary("ensemble_change_model", {
        name: "verifier",
        model: "openai/gpt-6.1-sol",
      }),
    ).toBe("@verifier gpt-6.1-sol");
    expect(ensembleToolSummary("ensemble_remove_member", { name: "schema" })).toBe("@schema");
    expect(ensembleToolSummary("ensemble_end", {})).toBe("");
    expect(ensembleToolSummary("ensemble_end", { summary: "全部并回\n补充说明" })).toBe("全部并回");
    expect(ensembleToolSummary("ensemble_checkout", { member: "orders" })).toBe("@orders");
    expect(ensembleToolSummary("ensemble_read", { from: "maestro", query: "build" })).toBe(
      "@maestro build",
    );
    expect(ensembleToolSummary("ensemble_read", { from: "@maestro", mention: "@orders" })).toBe(
      "@maestro @orders",
    );
    expect(ensembleToolSummary("ensemble_read", { limit: 20 })).toBe("");
    expect(ensembleReadFilterParts({ from: "maestro", query: "build" })).toEqual({
      primary: "@maestro",
      query: "build",
      text: "@maestro build",
    });
    expect(
      ensembleReadPostsFromOutput({
        posts: [
          { number: 3, from: "maestro", fromKind: "maestro", text: "请看", mentions: ["orders"] },
        ],
        hasMore: false,
      })?.map(ensemblePostHead),
    ).toEqual(["#3 指挥 → @orders"]);
    expect(
      noteWriteSummary({
        name: "note_write",
        status: "ok",
        input: { add: ["第一条", "第二条"] },
        result: {
          status: "ok",
          modelContent: "",
          output: {
            notes: [
              { n: 1, text: "旧笔记" },
              { n: 2, text: "第一条" },
              { n: 3, text: "第二条" },
            ],
          },
          error: undefined,
          truncated: false,
          spillPath: undefined,
          durationMs: 1,
        },
      }),
    ).toEqual({ count: "3 条", note: "第一条", text: "3 条 第一条" });
    expect(
      noteWriteSummary({
        name: "note_write",
        status: "ok",
        input: { remove: [1] },
        result: {
          status: "ok",
          modelContent: "",
          output: { notes: [{ n: 1, text: "保留" }] },
          error: undefined,
          truncated: false,
          spillPath: undefined,
          durationMs: 1,
        },
      }),
    ).toEqual({ count: "1 条", note: "", text: "1 条" });
    expect(ensembleToolSummary("shell", { command: "pnpm test" })).toBeUndefined();
  });
});

describe("EnsembleActivity 活动摘要组词", () => {
  it("按 tool / permission / paused / post / charter / removed 组成界面文字", () => {
    expect(ensembleActivitySummary({ kind: "tool", tool: "shell", detail: "pnpm test" })).toBe(
      "命令 pnpm test",
    );
    expect(ensembleActivitySummary({ kind: "tool", tool: "read" })).toBe("读取");
    expect(ensembleActivitySummary({ kind: "permission", target: "pnpm add zod" })).toBe(
      "等待确认：pnpm add zod",
    );
    expect(ensembleActivitySummary({ kind: "permission" })).toBe("等待确认");
    expect(
      ensembleActivitySummary({
        kind: "paused",
        code: "rate_limit",
        message: "429 Too Many Requests",
      }),
    ).toBe("429 Too Many Requests");
    expect(
      ensembleActivitySummary({
        kind: "paused",
        code: "session_not_found",
        message: "Session not found",
      }),
    ).toBe("找不到这个子代理的日志，可能已被删除");
    expect(
      ensembleActivitySummary({ kind: "post", number: 11, line: "已改：数量为 0 时返回 400" }),
    ).toBe("已改：数量为 0 时返回 400");
    expect(ensembleActivitySummary({ kind: "charter", line: "src/routes/users.ts" })).toBe(
      "src/routes/users.ts",
    );
    expect(ensembleActivitySummary({ kind: "removed", reason: "并回后移除" })).toBe("并回后移除");
    expect(ensembleActivitySummary({ kind: "removed" })).toBe("");
  });
});

describe("作者、提及、筛选、搜索与分组", () => {
  it("作者与提及遵循统一显示规则", () => {
    expect(ensembleAuthorLabel("maestro", "maestro")).toBe("指挥");
    expect(ensembleAuthorLabel("user", "user")).toBe("你");
    expect(ensembleAuthorLabel("runtime", "runtime")).toBe("Runtime");
    expect(ensembleAuthorLabel("orders", "member")).toBe("@orders");

    expect(ensembleMentionLabel("maestro")).toBe("指挥");
    expect(ensembleMentionLabel("all")).toBe("@all");
    expect(ensembleMentionLabel("verifier")).toBe("@verifier");
  });

  it("按成员筛选命中 from 等于该成员或 recipients 含该成员的帖子，并与搜索取交集", () => {
    const posts = [
      makePost(1, {
        from: "maestro",
        fromKind: "maestro",
        mentions: ["users", "orders"],
        recipients: ["users", "orders"],
        text: "请 @users 与 @orders 开始",
      }),
      makePost(2, {
        from: "users",
        fromKind: "member",
        mentions: ["all"],
        recipients: ["maestro", "orders", "verifier"],
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
    expect(filterEnsemblePosts(posts, { member: "users" }).map((p) => p.number)).toEqual([1, 2]);
    expect(filterEnsemblePosts(posts, { member: "verifier" }).map((p) => p.number)).toEqual([2, 3]);
    expect(
      filterEnsemblePosts(posts, { member: "verifier", query: "VALIDATE" }).map((p) => p.number),
    ).toEqual([2]);
    expect(filterEnsemblePosts(posts, { query: "@orders" }).map((p) => p.number)).toEqual([1, 3]);
    expect(filterEnsemblePosts(posts, { query: "已交付" }).map((p) => p.number)).toEqual([3]);
  });

  it("成员分组与状态圆点：进行中区分 work / ask / pause / wait / retired，结束后统一为 wait", () => {
    const mWorking = makeMember("verifier", { status: "working" });
    const mAsk = makeMember("products", {
      status: "working",
      pendingPermissions: [
        { requestId: "r1", callId: "c1", reason: "cmd", subjects: [], options: [] },
      ],
    });
    const mPaused = makeMember("broken", { status: "paused" });
    const mWaiting = makeMember("orders", { status: "waiting" });
    const mRemoved = makeMember("schema", { status: "removed" });
    const members = [mWorking, mAsk, mPaused, mWaiting, mRemoved];
    const groups = groupEnsembleMembers(members);
    expect(groups.working.map((m) => m.name)).toEqual(["verifier", "products"]);
    expect(groups.paused.map((m) => m.name)).toEqual(["broken"]);
    expect(groups.waiting.map((m) => m.name)).toEqual(["orders"]);
    expect(groups.removed.map((m) => m.name)).toEqual(["schema"]);

    expect(ensembleMemberDot(mWorking, "active")).toBe("work");
    expect(ensembleMemberDot(mAsk, "active")).toBe("ask");
    expect(ensembleMemberDot(mPaused, "active")).toBe("pause");
    expect(ensembleMemberDot(mWaiting, "active")).toBe("wait");
    expect(ensembleMemberDot(mRemoved, "active")).toBe("retired");

    expect(ensembleMemberDot(mWorking, "ended")).toBe("wait");
    expect(ensembleMemberDot(mAsk, "ended")).toBe("wait");
    expect(ensembleMemberDot(mRemoved, "ended")).toBe("retired");
  });

  it("状态点区分 ok / warn / 已结束无点", () => {
    const ensemble: EnsembleView = {
      createdSeq: 2,
      title: "API 输入校验",
      status: "active",
      maestro: {
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
    expect(ensembleStatusDot(ensemble)).toBe("ok");
    expect(ensembleStatusDot({ ...ensemble, awaitingPermissionMembers: ["orders"] })).toBe("warn");
    expect(
      ensembleStatusDot({ ...ensemble, status: "ended", awaitingPermissionMembers: ["orders"] }),
    ).toBeUndefined();
    expect(ensembleMaestroDot(ensemble)).toBe("wait");
    expect(
      ensembleMaestroDot({
        ...ensemble,
        maestro: { ...ensemble.maestro, status: "working", awaitingPermission: true },
      }),
    ).toBe("ask");
  });

  it("splitEnsembleMentions 只强调出现在 mentions 里的 @token，忽略不在 mentions 里的词和半截词", () => {
    expect(
      splitEnsembleMentions("请 @users 处理，@unknown 装饰器与 @users-extra 不动，回贴找 @指挥", [
        "users",
        "maestro",
      ]),
    ).toEqual([
      { kind: "text", value: "请 " },
      { kind: "mention", value: "@users" },
      { kind: "text", value: " 处理，@unknown 装饰器与 @users-extra 不动，回贴找 " },
      { kind: "mention", value: "@指挥" },
    ]);
  });

  it("shortModelName 与 formatEnsembleTime 正常格式化", () => {
    expect(shortModelName({ provider: "openai", model: "gpt-6.1-sol" })).toBe("gpt-6.1-sol");
    expect(shortModelName("anthropic/claude-opus-5.5")).toBe("claude-opus-5.5");
    expect(formatEnsembleTime("invalid")).toBe("");
    expect(formatEnsembleTime("2026-11-12T13:05:00.000Z")).toMatch(/^\d{2}:\d{2}$/);
  });

  it("ensembleAuthorColor 按加入顺序轮转 --a-cat1..5，移除后颜色不变，指挥/用户/Runtime 返回 undefined", () => {
    const members = [
      makeMember("m1"),
      makeMember("m2", { status: "removed" }),
      makeMember("m3"),
      makeMember("m4"),
      makeMember("m5"),
      makeMember("m6"),
    ];
    expect(ensembleAuthorColor(members, "m1", "member")).toBe("var(--a-cat1)");
    expect(ensembleAuthorColor(members, "m2", "member")).toBe("var(--a-cat2)");
    expect(ensembleAuthorColor(members, "m3", "member")).toBe("var(--a-cat3)");
    expect(ensembleAuthorColor(members, "m4", "member")).toBe("var(--a-cat4)");
    expect(ensembleAuthorColor(members, "m5", "member")).toBe("var(--a-cat5)");
    expect(ensembleAuthorColor(members, "m6", "member")).toBe("var(--a-cat1)");
    expect(ensembleAuthorColor(members, "maestro", "maestro")).toBeUndefined();
    expect(ensembleAuthorColor(members, "user", "user")).toBeUndefined();
    expect(ensembleAuthorColor(members, "runtime", "runtime")).toBeUndefined();
  });

  it("ensemblePostRecipients 去掉作者自己，指挥去掉 maestro", () => {
    expect(
      ensemblePostRecipients({
        from: "cli-1",
        fromKind: "member",
        mentions: ["maestro", "data-1", "cli-1"],
      }),
    ).toEqual(["maestro", "data-1"]);
    expect(
      ensemblePostRecipients({
        from: "maestro",
        fromKind: "maestro",
        mentions: ["maestro", "api-1"],
      }),
    ).toEqual(["api-1"]);
    expect(
      ensemblePostRecipients({
        from: "maestro",
        fromKind: "maestro",
        mentions: ["maestro"],
      }),
    ).toEqual([]);
  });

  it("ensemblePostRecipients 与 ensemblePostHead 合并任务书帖的 charterOf 且不重复", () => {
    const charterOnly = makePost(1, {
      from: "maestro",
      fromKind: "maestro",
      mentions: [],
      recipients: [],
      charterOf: "impl-1",
    });
    expect(ensemblePostRecipients(charterOnly)).toEqual(["impl-1"]);
    expect(ensemblePostHead(charterOnly)).toBe("#1 指挥 → @impl-1");

    const charterWithSameMention = makePost(2, {
      from: "maestro",
      fromKind: "maestro",
      mentions: ["impl-1"],
      recipients: ["impl-1"],
      charterOf: "impl-1",
    });
    expect(ensemblePostRecipients(charterWithSameMention)).toEqual(["impl-1"]);
    expect(ensemblePostHead(charterWithSameMention)).toBe("#2 指挥 → @impl-1");

    const charterWithOtherMention = makePost(3, {
      from: "maestro",
      fromKind: "maestro",
      mentions: ["review-1"],
      recipients: ["review-1"],
      charterOf: "impl-1",
    });
    expect(ensemblePostRecipients(charterWithOtherMention)).toEqual(["impl-1", "review-1"]);
    expect(ensemblePostHead(charterWithOtherMention)).toBe("#3 指挥 → @impl-1 @review-1");

    const plainPost = makePost(4, {
      from: "maestro",
      fromKind: "maestro",
      mentions: [],
      recipients: [],
    });
    expect(ensemblePostRecipients(plainPost)).toEqual([]);
    expect(ensemblePostHead(plainPost)).toBe("#4 指挥");
  });

  it("filterEnsemblePosts 按成员筛选时包含该成员的任务书帖，不含其他成员的任务书帖", () => {
    const posts = [
      makePost(1, { charterOf: "impl-1", mentions: [], recipients: [] }),
      makePost(2, { charterOf: "review-1", mentions: [], recipients: [] }),
      makePost(3, { mentions: ["impl-1"], recipients: ["impl-1"], text: "@impl-1 开始吧" }),
    ];
    expect(filterEnsemblePosts(posts, { member: "impl-1" }).map((p) => p.number)).toEqual([1, 3]);
    expect(filterEnsemblePosts(posts, { member: "review-1" }).map((p) => p.number)).toEqual([2]);
    expect(filterEnsemblePosts(posts, { member: "" }).map((p) => p.number)).toEqual([1, 2, 3]);
  });

  it("ensembleMentionToken 与 ensembleMentionCandidates：顺序、组提及阈值、移除过滤与前缀匹配", () => {
    expect(ensembleMentionToken("@", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(ensembleMentionToken("请 @d", 4)).toEqual({ start: 2, end: 4, query: "d" });
    expect(ensembleMentionToken("a@b", 3)).toBeNull();
    expect(ensembleMentionToken("@api ", 5)).toBeNull();

    const ensemble: EnsembleView = {
      createdSeq: 1,
      title: "联调",
      status: "active",
      maestro: {
        model: { provider: "anthropic", model: "claude-opus-5.5" },
        status: "waiting",
        awaitingPermission: false,
      },
      members: [
        makeMember("api-1", { profile: "deep" }),
        makeMember("api-2"),
        makeMember("ui-1"),
        makeMember("ui-2", { status: "removed" }),
        makeMember("data-1"),
      ],
      awaitingPermissionMembers: [],
      posts: [],
    };
    const all = ensembleMentionCandidates(ensemble, "");
    expect(all.map((c) => c.insert)).toEqual([
      "maestro",
      "api-1",
      "api-2",
      "ui-1",
      "data-1",
      "api",
      "all",
    ]);
    expect(all[0]).toMatchObject({ label: "指挥", meta: "claude-opus-5.5" });
    expect(all[1]).toMatchObject({ label: "api-1", meta: "deep" });
    expect(all.find((c) => c.insert === "api")).toMatchObject({ kind: "group", label: "@api" });
    expect(all.find((c) => c.insert === "ui")).toBeUndefined();

    expect(ensembleMentionCandidates(ensemble, "指").map((c) => c.insert)).toEqual(["maestro"]);
    expect(ensembleMentionCandidates(ensemble, "ma").map((c) => c.insert)).toEqual(["maestro"]);
    expect(ensembleMentionCandidates(ensemble, "D").map((c) => c.insert)).toEqual(["data-1"]);
    expect(ensembleMentionCandidates(ensemble, "A").map((c) => c.insert)).toEqual([
      "api-1",
      "api-2",
      "api",
      "all",
    ]);
    expect(ensembleMentionCandidates(ensemble, "zzz")).toEqual([]);
  });
});

describe("合奏入口行匹配与成员权限拆分", () => {
  function makeInitTool(
    seq: number,
    completedSeq: number | undefined,
    status: ToolEntry["status"] = "ok",
  ): ToolEntry {
    return {
      kind: "tool",
      key: `t:${seq}`,
      turnId: "turn-1",
      seq,
      ...(completedSeq !== undefined ? { completedSeq } : {}),
      callId: `c-${seq}`,
      name: "ensemble_init",
      status,
      input: { title: `合奏 ${seq}` },
      subjects: [],
      permission: undefined,
      resolution: undefined,
      liveOutput: "",
      result: undefined,
    };
  }

  it("currentEnsembleInitKey 按 createdSeq 精确匹配创建当前合奏的 ensemble_init 行", () => {
    const first = makeInitTool(3, 5, "ok");
    const second = makeInitTool(20, 22, "ok");
    const failed = makeInitTool(30, 31, "error");
    expect(currentEnsembleInitKey([first, second, failed], { createdSeq: 21 })).toBe("t:20");
    expect(currentEnsembleInitKey([first, failed], { createdSeq: 4 })).toBe("t:3");
    expect(currentEnsembleInitKey([first, second], undefined)).toBeUndefined();
    // 未填 completedSeq 时回退取 seq <= createdSeq 且最接近的成功条目
    const syntheticFirst = makeInitTool(3, undefined, "ok");
    const syntheticSecond = makeInitTool(10, undefined, "ok");
    expect(currentEnsembleInitKey([syntheticFirst, syntheticSecond], { createdSeq: 11 })).toBe(
      "t:10",
    );
  });

  it("partitionEnsemblePermissions 只过滤活动合奏成员的转发请求，保留指挥与 task 子代理卡片顺序", () => {
    const impl = makeMember("impl", { childSessionId: "child-impl" });
    const verify = makeMember("verify", {
      childSessionId: "child-verify",
      pendingPermissions: [
        { requestId: "req-v", callId: "c-v", reason: "cmd", subjects: [], options: [] },
      ],
    });
    const removed = makeMember("old", { childSessionId: "child-old", status: "removed" });
    const ensemble: Pick<EnsembleView, "status" | "members"> = {
      status: "active",
      members: [impl, verify, removed],
    };
    const pending: AggregatedPendingPermission[] = [
      {
        kind: "subagent",
        permission: {
          requestId: "req-v",
          callId: "c-v",
          toolName: "shell",
          reason: "cmd",
          subjects: [],
          options: ["allow_once", "deny"],
          childSessionId: "child-verify",
          parentCallId: "ensemble:verify",
          profile: "",
          taskSummary: "verify",
          afterSeq: 10,
          order: 1,
        },
      },
      {
        kind: "subagent",
        permission: {
          requestId: "req-task",
          callId: "c-t",
          toolName: "shell",
          reason: "cmd",
          subjects: [],
          options: ["allow_once", "deny"],
          childSessionId: "child-task",
          parentCallId: "call-task",
          profile: "deep",
          taskSummary: "普通子代理",
          afterSeq: 11,
          order: 2,
        },
      },
      {
        kind: "session",
        permission: {
          requestId: "req-self",
          callId: "c-s",
          toolName: "shell",
          reason: "cmd",
          subjects: [],
          options: ["allow_once", "deny"],
          seq: 12,
        },
      },
    ];

    const active = partitionEnsemblePermissions(pending, ensemble);
    expect(active.cards.map((item) => item.permission.requestId)).toEqual(["req-task", "req-self"]);
    expect(active.awaitingMembers.map((member) => member.name)).toEqual(["verify"]);

    const ended = partitionEnsemblePermissions(pending, { ...ensemble, status: "ended" });
    expect(ended.cards.map((item) => item.permission.requestId)).toEqual([
      "req-v",
      "req-task",
      "req-self",
    ]);
    expect(ended.awaitingMembers).toEqual([]);
  });
});
