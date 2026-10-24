/**
 * 服务商 / 模型启停 UI（ADR-0054 §5）：服务商页 Space、○ 已停用、N / 总数、
 * 停用前页内 y/n 确认；模型页 `[x]`/`[ ]`、Space 切换、a/n 批量（有搜索时
 * 只作用于筛选结果）。组件级渲染（ink-testing-library），启停桥注入 stub，
 * 断言的 disabled/enabled 数据一律来自 Core 视图形状（TUI 不自行判断停用）。
 */
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it, vi, type Mock } from "vitest";

import type { ModelField, ModelSettingsView, ProviderOverview, ToggleImpact } from "@nocturne/core";

import { ProviderPage, type ProviderToggleBridge } from "../src/components/provider-page.js";

const ENTER = "\r";
const SPACE = " ";
function pause(ms = 40): Promise<undefined> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(() => resolve(undefined), ms);
  return promise;
}
async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("waitFor 超时");
    await pause(20);
  }
}
/** 等 React 跑完 useInput 订阅/退订：帧写出不代表按键路由已切换。 */
async function flushInput(): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    const { promise, resolve } = Promise.withResolvers<undefined>();
    setImmediate(() => resolve(undefined));
    await promise;
  }
}

const field = <T,>(
  value: T | undefined,
  source: ModelSettingsView["fields"]["displayName"]["source"],
): ModelField<T> => ({ value, source, editable: true });

const view = (modelId: string): ModelSettingsView => ({
  providerId: "up",
  modelId,
  readonly: false,
  fields: {
    displayName: field<string | undefined>(undefined, { kind: "upstream" }),
    contextWindow: field<number | undefined>(100_000, { kind: "upstream" }),
    maxOutputTokens: field<number | undefined>(8_000, { kind: "upstream" }),
    reasoning: field<"none" | "hidden" | "visible">("visible", { kind: "upstream" }),
    imageInput: field<boolean | undefined>(false, { kind: "default" }),
    reasoningEffort: field<("low" | "high")[] | undefined>(["low", "high"], { kind: "derived" }),
    protocol: field<"openai-compatible" | "anthropic" | undefined>("openai-compatible", {
      kind: "entryType",
    }),
    editTool: field<"edit" | "apply_patch">("edit", { kind: "default" }),
    baseURL: field("https://api.test/v1", { kind: "default" }),
  } as ModelSettingsView["fields"],
});

const views = [view("m1"), view("m2")];

const entry = (over?: Partial<ProviderOverview>): ProviderOverview => ({
  id: "up",
  type: "openai-compatible",
  host: "api.example.com",
  keySource: "credential",
  authKind: "apiKey",
  origin: "setup",
  overridden: false,
  modelCount: 2,
  enabledModelCount: 2,
  managed: true,
  enabled: true,
  ...over,
});

const NO_IMPACT: ToggleImpact = { affectedSessions: 0, defaultModel: false, roles: [] };

interface Bridge {
  toggle: ProviderToggleBridge;
  setProviderEnabled: Mock<ProviderToggleBridge["setProviderEnabled"]>;
  setModelsEnabled: Mock<ProviderToggleBridge["setModelsEnabled"]>;
  impact: Mock<ProviderToggleBridge["impact"]>;
  disabledModels: Mock<ProviderToggleBridge["disabledModels"]>;
}

function bridge(over?: Partial<ProviderToggleBridge>): Bridge {
  const setProviderEnabled = vi.fn(async () => undefined);
  const setModelsEnabled = vi.fn(async () => undefined);
  const impact = vi.fn(() => NO_IMPACT);
  const disabledModels = vi.fn(() => [] as string[]);
  return {
    toggle: { disabledModels, impact, setProviderEnabled, setModelsEnabled, ...over },
    setProviderEnabled,
    setModelsEnabled,
    impact,
    disabledModels,
  };
}

function pageProps(over?: Record<string, unknown>) {
  return {
    presets: [],
    entries: [entry()],
    wizard: undefined,
    onStartWizard: vi.fn(),
    onOp: vi.fn(),
    onReadonlyHint: () => "只读",
    onConfirmRemove: vi.fn(),
    onListModels: async () => views,
    onClose: vi.fn(),
    width: 100,
    height: 29,
    termRows: 30,
    active: true,
    ...over,
  };
}

describe("服务商页启停（ADR-0054 §5）", () => {
  it("停用的服务商显示 ○ / 已停用 / 0 / 总数；部分停用显示 N / 总数", async () => {
    const { toggle } = bridge();
    const ui = render(
      createElement(
        ProviderPage,
        pageProps({
          entries: [
            entry({ id: "off", enabled: false, enabledModelCount: 0, modelCount: 3 }),
            entry({ id: "part", enabled: true, enabledModelCount: 1, modelCount: 3 }),
            entry({ id: "full", enabled: true, enabledModelCount: 3, modelCount: 3 }),
          ],
          toggle,
        }),
      ),
    );
    await waitFor(() => (ui.lastFrame() ?? "").includes("已停用"));
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("已停用");
    expect(frame).toContain("0 / 3");
    expect(frame).toContain("1 / 3");
    expect(frame).toContain("3 个模型");
    expect(frame).toContain("○ off");
    ui.unmount();
  });

  it("Space 停用无影响的选中服务商：直接调用 setProviderEnabled(false)", async () => {
    const { toggle, setProviderEnabled } = bridge();
    const ui = render(createElement(ProviderPage, pageProps({ toggle })));
    await waitFor(() => (ui.lastFrame() ?? "").includes("已配置"));
    await flushInput();
    ui.stdin.write(SPACE);
    await waitFor(() => setProviderEnabled.mock.calls.length > 0);
    expect(setProviderEnabled).toHaveBeenCalledWith("up", false);
    ui.unmount();
  });

  it("Space 启用已停用的服务商：直接调用 setProviderEnabled(true)", async () => {
    const { toggle, setProviderEnabled } = bridge();
    const ui = render(
      createElement(ProviderPage, pageProps({ entries: [entry({ enabled: false })], toggle })),
    );
    await waitFor(() => (ui.lastFrame() ?? "").includes("已停用"));
    await flushInput();
    ui.stdin.write(SPACE);
    await waitFor(() => setProviderEnabled.mock.calls.length > 0);
    expect(setProviderEnabled).toHaveBeenCalledWith("up", true);
    ui.unmount();
  });

  it("停用正被使用的服务商：先页内 y/n 确认，n 取消、y 执行", async () => {
    const impact = vi.fn((): ToggleImpact => ({
      affectedSessions: 2,
      defaultModel: true,
      roles: ["task"],
    }));
    const { toggle, setProviderEnabled } = bridge({ impact });
    const ui = render(createElement(ProviderPage, pageProps({ toggle })));
    await waitFor(() => (ui.lastFrame() ?? "").includes("已配置"));
    await flushInput();
    ui.stdin.write(SPACE);
    await waitFor(() => (ui.lastFrame() ?? "").includes("y 确认"));
    const prompt = ui.lastFrame() ?? "";
    expect(prompt).toContain("2 个打开的会话");
    expect(prompt).toContain("默认模型");
    expect(prompt).toContain("default 档位模型");
    expect(setProviderEnabled).not.toHaveBeenCalled();

    ui.stdin.write("n");
    await waitFor(() => (ui.lastFrame() ?? "").includes("已取消"));
    expect(setProviderEnabled).not.toHaveBeenCalled();

    await flushInput();
    ui.stdin.write(SPACE);
    await waitFor(() => (ui.lastFrame() ?? "").includes("y 确认"));
    ui.stdin.write("y");
    await waitFor(() => setProviderEnabled.mock.calls.length > 0);
    expect(setProviderEnabled).toHaveBeenCalledWith("up", false);
    ui.unmount();
  });
});

describe("模型页启停（ADR-0054 §5）", () => {
  it("[x]/[ ]、已启用 N / 总数、Space 切换、a/n 批量（有搜索只作用于筛选结果）", async () => {
    const disabledModels = vi.fn(() => ["m2"]);
    const { toggle, setModelsEnabled } = bridge({ disabledModels });
    const ui = render(
      createElement(ProviderPage, pageProps({ toggle, initialModelTarget: { providerId: "up" } })),
    );
    await waitFor(() => (ui.lastFrame() ?? "").includes("服务商 up › 模型（2）"));
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("已启用 1 / 2");
    expect(frame).toContain("[x] m1");
    expect(frame).toContain("[ ] m2");
    expect(frame).toContain("Space 启停");

    // Space：光标在 m1（启用）→ 停用
    await flushInput();
    ui.stdin.write(SPACE);
    await waitFor(() => setModelsEnabled.mock.calls.length > 0);
    expect(setModelsEnabled).toHaveBeenLastCalledWith("up", ["m1"], false);

    // n：无搜索 → 停用全部
    await flushInput();
    ui.stdin.write("n");
    await waitFor(() => setModelsEnabled.mock.calls.length > 1);
    expect(setModelsEnabled).toHaveBeenLastCalledWith("up", ["m1", "m2"], false);

    // a：无搜索 → 启用全部
    await flushInput();
    ui.stdin.write("a");
    await waitFor(() => setModelsEnabled.mock.calls.length > 2);
    expect(setModelsEnabled).toHaveBeenLastCalledWith("up", ["m1", "m2"], true);

    // / 进搜索、Enter 应用后 n 只作用于筛选结果
    await flushInput();
    ui.stdin.write("/m1");
    await waitFor(() => (ui.lastFrame() ?? "").includes("搜索: m1"));
    ui.stdin.write(ENTER);
    await waitFor(() => (ui.lastFrame() ?? "").includes("过滤: m1"));
    await flushInput();
    ui.stdin.write("n");
    await waitFor(() => setModelsEnabled.mock.calls.length > 3);
    expect(setModelsEnabled).toHaveBeenLastCalledWith("up", ["m1"], false);
    ui.unmount();
  });

  it("搜索模式：a/n 是普通搜索字符（不再触发批量），Enter 应用、Esc 清除", async () => {
    const disabledModels = vi.fn(() => ["m2"]);
    const { toggle, setModelsEnabled } = bridge({ disabledModels });
    const ui = render(
      createElement(
        ProviderPage,
        pageProps({
          toggle,
          onListModels: async () => [view("an-model"), view("m2")],
          entries: [entry({ modelCount: 2 })],
          initialModelTarget: { providerId: "up" },
        }),
      ),
    );
    await waitFor(() => (ui.lastFrame() ?? "").includes("服务商 up › 模型（2）"));
    await flushInput();
    // 搜索词含 a、n：只写进过滤，不触发批量
    ui.stdin.write("/an");
    await waitFor(() => (ui.lastFrame() ?? "").includes("搜索: an"));
    expect(setModelsEnabled).not.toHaveBeenCalled();
    // Enter 应用：筛选出 an-model
    ui.stdin.write(ENTER);
    await waitFor(() => (ui.lastFrame() ?? "").includes("过滤: an"));
    expect(ui.lastFrame() ?? "").toContain("[x] an-model");
    expect(ui.lastFrame() ?? "").not.toContain("[ ] m2");
    // 应用后 n 只作用于筛选结果 → an-model
    await flushInput();
    ui.stdin.write("n");
    await waitFor(() => setModelsEnabled.mock.calls.length > 0);
    expect(setModelsEnabled).toHaveBeenLastCalledWith("up", ["an-model"], false);
    // Esc 清除搜索词，回到全部模型
    await flushInput();
    ui.stdin.write("/");
    await waitFor(() => (ui.lastFrame() ?? "").includes("搜索: an"));
    ui.stdin.write("\u001b");
    await waitFor(() => {
      const row = (ui.lastFrame() ?? "").split("\n").find((l) => l.includes("过滤:")) ?? "";
      return row.trim() === "过滤:";
    });
    expect(ui.lastFrame() ?? "").toContain("[ ] m2");
    ui.unmount();
  });

  it("服务商停用：模型开关保留逐个设置（不从 Core 另判），Space 拒绝", async () => {
    const disabledModels = vi.fn(() => ["m2"]);
    const { toggle, setModelsEnabled, setProviderEnabled } = bridge({ disabledModels });
    const ui = render(
      createElement(
        ProviderPage,
        pageProps({
          toggle,
          entries: [entry({ enabled: false, enabledModelCount: 0 })],
          initialModelTarget: { providerId: "up" },
        }),
      ),
    );
    await waitFor(() => (ui.lastFrame() ?? "").includes("服务商 up › 模型（2）"));
    const frame = ui.lastFrame() ?? "";
    // 逐个状态保留：m1 仍 [x]，m2 仍 [ ]
    expect(frame).toContain("服务商已停用 · 逐个设置保留 1 / 2");
    expect(frame).toContain("[x] m1");
    expect(frame).toContain("[ ] m2");
    await flushInput();
    ui.stdin.write(SPACE);
    await waitFor(() => (ui.lastFrame() ?? "").includes("先启用服务商"));
    expect(setModelsEnabled).not.toHaveBeenCalled();
    expect(setProviderEnabled).not.toHaveBeenCalled();
    ui.unmount();
  });

  it("停用正被使用的模型：页内 y/n 确认", async () => {
    const impact = vi.fn((): ToggleImpact => ({
      affectedSessions: 1,
      defaultModel: false,
      roles: [],
    }));
    const { toggle, setModelsEnabled } = bridge({ impact });
    const ui = render(
      createElement(ProviderPage, pageProps({ toggle, initialModelTarget: { providerId: "up" } })),
    );
    await waitFor(() => (ui.lastFrame() ?? "").includes("[x] m1"));
    await flushInput();
    ui.stdin.write(SPACE);
    await waitFor(() => (ui.lastFrame() ?? "").includes("y 确认"));
    expect(setModelsEnabled).not.toHaveBeenCalled();
    expect(ui.lastFrame() ?? "").toContain("1 个打开的会话");
    ui.stdin.write("y");
    await waitFor(() => setModelsEnabled.mock.calls.length > 0);
    expect(setModelsEnabled).toHaveBeenLastCalledWith("up", ["m1"], false);
    ui.unmount();
  });

  it("服务商停用时模型开关拒绝并提示先启用服务商", async () => {
    const { toggle, setModelsEnabled } = bridge();
    const ui = render(
      createElement(
        ProviderPage,
        pageProps({
          toggle,
          entries: [entry({ enabled: false, enabledModelCount: 0 })],
          initialModelTarget: { providerId: "up" },
        }),
      ),
    );
    await waitFor(() => (ui.lastFrame() ?? "").includes("服务商 up › 模型（2）"));
    await flushInput();
    ui.stdin.write(SPACE);
    await waitFor(() => (ui.lastFrame() ?? "").includes("先启用服务商"));
    expect(setModelsEnabled).not.toHaveBeenCalled();
    ui.unmount();
  });

  it("Enter 仍进模型编辑页（Space 不抢占编辑入口）", async () => {
    const { toggle } = bridge();
    const ui = render(
      createElement(ProviderPage, pageProps({ toggle, initialModelTarget: { providerId: "up" } })),
    );
    await waitFor(() => (ui.lastFrame() ?? "").includes("服务商 up › 模型（2）"));
    await flushInput();
    ui.stdin.write(ENTER);
    await waitFor(() => (ui.lastFrame() ?? "").includes("[ 保存 ]"));
    ui.unmount();
  });

  it("手写服务商（managed: false）：编辑只读但启停可用（ADR-0054 §2）", async () => {
    const readonlyViews = views.map((v) => ({
      ...v,
      readonly: true,
      readonlyHint: "手写在 config.json，编辑请改文件",
    }));
    const disabledModels = vi.fn(() => ["m2"]);
    const { toggle, setModelsEnabled } = bridge({ disabledModels });
    const ui = render(
      createElement(
        ProviderPage,
        pageProps({
          toggle,
          entries: [entry({ managed: false, origin: "user" })],
          onListModels: async () => readonlyViews,
          initialModelTarget: { providerId: "up" },
        }),
      ),
    );
    await waitFor(() => (ui.lastFrame() ?? "").includes("服务商 up › 模型（2）"));
    const frame = ui.lastFrame() ?? "";
    // 启停可用：行首开关、页头计数与底栏文案保持一致（只读前缀 + Space 启停）
    expect(frame).toContain("[x] m1");
    expect(frame).toContain("[ ] m2");
    expect(frame).toContain("已启用 1 / 2");
    expect(frame).toContain("只读");
    expect(frame).toContain("Space 启停");
    await flushInput();
    ui.stdin.write(SPACE);
    await waitFor(() => setModelsEnabled.mock.calls.length > 0);
    expect(setModelsEnabled).toHaveBeenLastCalledWith("up", ["m1"], false);
    ui.unmount();
  });
});
