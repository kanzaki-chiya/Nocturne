import { cleanup, render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listProviderPresets,
  type AddProviderOptions,
  type ProviderOverview,
  type ProviderPreset,
  type RuntimeConfig,
} from "@nocturne/core";
import { ProviderPage } from "../src/components/provider-page.js";
import { TuiEnvContext } from "../src/env.js";
import { useProviderWizard } from "../src/wizard-io.js";
import { changedFrame, providerMouse, settle } from "./provider-test-utils.js";

afterEach(cleanup);
const entry = (id: string, managed = true): ProviderOverview => ({
  id,
  type: "openai-compatible",
  host: "example.test",
  keySource: "credential",
  origin: "setup",
  overridden: false,
  modelCount: 1,
  managed,
});
// Core 按预设 id 解析描述，向导测试必须用真实预设（DeepSeek：地址写死、API Key 与环境变量两步）
const preset: ProviderPreset = listProviderPresets().find(
  (p) => p.id === "deepseek",
) as ProviderPreset;
async function page(
  options: {
    current?: string;
    readonly?: boolean;
    many?: boolean;
    inline?: boolean;
    ascii?: boolean;
    width?: number;
  } = {},
) {
  const mouse = providerMouse();
  const onOp = vi.fn(),
    onClose = vi.fn(),
    onConfirmRemove = vi.fn();
  const onListModels = vi.fn(async () => []);
  const onReadonlyHint = vi.fn(() => "服务商 alpha 定义在 config.json，请编辑该处配置");
  const setCredential = vi.fn(async () => undefined);
  const saveSetupProvider = vi.fn(async () => undefined);
  const config = {
    credentials: { backend: () => "dpapi" },
    base: { providers: [] },
    setCredential,
    saveSetupProvider,
    refreshModelsDev: async () => undefined,
  } as unknown as RuntimeConfig;
  const deps: AddProviderOptions = {
    fetchModels: async () => [{ id: "offline-model" }],
    env: () => undefined,
  };
  const entries = options.many
    ? Array.from({ length: 40 }, (_, i) => entry(`provider-${String(i).padStart(2, "0")}`))
    : [entry("alpha", !options.readonly), entry("beta")];
  function Harness() {
    const wizard = useProviderWizard(config, deps);
    return (
      <ProviderPage
        presets={options.many ? [] : [preset]}
        entries={entries}
        currentProviderId={options.current}
        wizard={wizard}
        onStartWizard={(presetId) => wizard.start({ kind: "add", presetId }, vi.fn())}
        onOp={(providerId, op) => {
          onOp(providerId, op);
          if (op === "key") wizard.start({ kind: "key", providerId }, vi.fn());
        }}
        onReadonlyHint={onReadonlyHint}
        onConfirmRemove={onConfirmRemove}
        onListModels={onListModels}
        onClose={onClose}
        width={options.width ?? 81}
        height={24}
        stepLabel="第 1 步，共 2 步"
        active
        onMouseFrame={options.inline ? undefined : mouse.report}
      />
    );
  }
  const ui = render(
    createElement(
      TuiEnvContext.Provider,
      { value: { ascii: options.ascii ?? false, animated: false } },
      createElement(Harness),
    ),
  );
  await settle(() => ui.lastFrame()?.includes("可添加") === true);
  return {
    ...ui,
    mouse,
    onOp,
    onClose,
    onConfirmRemove,
    onListModels,
    onReadonlyHint,
    setCredential,
    saveSetupProvider,
  };
}
async function configured(ui: Awaited<ReturnType<typeof page>>) {
  await changedFrame(ui, () => ui.stdin.write("\r"));
  expect(ui.lastFrame()).toContain("服务商 alpha");
}

describe("服务商四个对话框与页内鼠标（ADR-0039 §2）", () => {
  it("操作竖排，Tab/方向键选择，刷新、编辑模型与 Esc 均保留列表过滤", async () => {
    const ui = await page();
    await changedFrame(ui, () => ui.stdin.write("alpha"));
    await changedFrame(ui, () => ui.stdin.write("\r"));
    const frame = ui.lastFrame() ?? "";
    for (const label of ["换密钥", "刷新模型列表", "编辑模型", "删除", "取消"])
      expect(frame).toContain(`[ ${label} ]`);
    const rows = frame.split("\n");
    expect(rows.findIndex((line) => line.includes("[ 换密钥 ]"))).toBeLessThan(
      rows.findIndex((line) => line.includes("[ 刷新模型列表 ]")),
    );
    await changedFrame(ui, () => ui.stdin.write("\t"));
    ui.stdin.write("\r");
    await settle(
      () => ui.onOp.mock.calls.length === 1 && ui.mouse.frame?.layer === "provider-list",
    );
    expect(ui.onOp).toHaveBeenCalledWith("alpha", "refresh");
    expect(ui.lastFrame()).toContain("过滤: alpha");
    await changedFrame(ui, () => ui.stdin.write("\r"));
    ui.stdin.write("x"); // 对话框期间不能输入列表过滤
    await changedFrame(ui, () => ui.stdin.write("\x1b[B"));
    await changedFrame(ui, () => ui.stdin.write("\x1b[B"));
    ui.stdin.write("\r");
    await settle(() => ui.onListModels.mock.calls.length === 1);
    expect(ui.onListModels).toHaveBeenCalledWith("alpha");
    await changedFrame(ui, () => ui.stdin.write("\x1b"));
    expect(ui.lastFrame()).toContain("过滤: alpha");
    await changedFrame(ui, () => ui.stdin.write("\r"));
    await changedFrame(ui, () => ui.stdin.write("\x1b"));
    expect(ui.onClose).not.toHaveBeenCalled();
    expect(ui.mouse.frame?.layer).toBe("provider-list");
  });
  it("删除确认默认取消，Delete 与操作对话框入口一致，右箭头确认后才删除", async () => {
    const ui = await page();
    await changedFrame(ui, () => ui.stdin.write("\x1b[3~"));
    expect(ui.lastFrame()).toContain("删除 alpha 的配置与已保存的密钥");
    expect(ui.lastFrame()).toContain("> [ 取消 ]");
    await changedFrame(ui, () => ui.stdin.write("\r"));
    expect(ui.onConfirmRemove).not.toHaveBeenCalled();
    await changedFrame(ui, () => ui.stdin.write("\r"));
    for (let i = 0; i < 3; i++) await changedFrame(ui, () => ui.stdin.write("\x1b[B"));
    await changedFrame(ui, () => ui.stdin.write("\r"));
    expect(ui.mouse.frame?.layer).toBe("provider-remove");
    await changedFrame(ui, () => ui.stdin.write("\x1b[C"));
    ui.stdin.write("\r");
    await settle(() => ui.onConfirmRemove.mock.calls.length === 1);
    expect(ui.onConfirmRemove).toHaveBeenCalledWith("alpha");
  });
  it("当前服务商删除灰显，没有鼠标命中框，键盘跳过删除", async () => {
    const ui = await page({ current: "alpha" });
    await configured(ui);
    expect(ui.lastFrame()).toContain("[ 删除 ]（不可用）");
    expect(ui.lastFrame()).toContain("当前会话正在使用，先用 /model 切换");
    expect(ui.mouse.frame?.boxes.some((box) => box.id === "remove")).toBe(false);
    for (let i = 0; i < 3; i++) await changedFrame(ui, () => ui.stdin.write("\t"));
    expect(ui.lastFrame()).toContain("> [ 重新登录 ]");
    for (let i = 0; i < 2; i++) await changedFrame(ui, () => ui.stdin.write("\t"));
    expect(ui.lastFrame()).toContain("> [ 取消 ]");
    await changedFrame(ui, () => ui.stdin.write("\r"));
    await changedFrame(ui, () => ui.stdin.write("\x1b[3~"));
    expect(ui.lastFrame()).toContain("先 /model 切换");
    expect(ui.mouse.frame?.layer).toBe("provider-list");
    expect(ui.onConfirmRemove).not.toHaveBeenCalled();
  });
  it("换密钥覆盖保留列表和首次配置步骤标记，回车提交给凭据后端", async () => {
    const ui = await page();
    await configured(ui);
    await changedFrame(ui, () => ui.stdin.write("\r"));
    expect(ui.lastFrame()).toContain("换密钥 alpha");
    expect(ui.lastFrame()).toContain("第 1 步，共 2 步");
    expect(ui.lastFrame()).toContain("服务商");
    expect(ui.mouse.frame?.layer).toBe("provider-wizard");
    await changedFrame(ui, () => ui.stdin.write("offline-key"));
    ui.stdin.write("\r");
    await settle(
      () => ui.setCredential.mock.calls.length === 1 && ui.mouse.frame?.layer === "provider-list",
    );
    expect(ui.setCredential).toHaveBeenCalledWith("alpha", "offline-key");
  });
  it("配置向导保留下层列表、步骤标记，空 API Key 回车仍进入环境变量步骤，Esc 取消", async () => {
    const ui = await page();
    for (let i = 0; i < 2; i++) await changedFrame(ui, () => ui.stdin.write("\x1b[B")); // alpha → beta → DeepSeek
    await changedFrame(ui, () => ui.stdin.write("\r"));
    expect(ui.lastFrame()).toContain("配置 DeepSeek");
    expect(ui.lastFrame()).toContain("第 1 步，共 2 步");
    expect(ui.lastFrame()).toContain("服务商");
    expect(ui.lastFrame()).toContain("[ 下一步 ]");
    ui.stdin.write("\r");
    await settle(() => ui.lastFrame()?.includes("凭据环境变量名") === true);
    ui.stdin.write("\x1b");
    await settle(() => ui.mouse.frame?.layer === "provider-list");
    expect(ui.saveSetupProvider).not.toHaveBeenCalled();
    expect(ui.setCredential).not.toHaveBeenCalled();
    expect(ui.onClose).not.toHaveBeenCalled();
  });
  it("列表单击选中，再次单击打开；操作和删除按钮单击可执行", async () => {
    const ui = await page();
    await changedFrame(ui, () => ui.mouse.click("row:2")); // beta 未选中：只选中
    expect(ui.mouse.frame?.layer).toBe("provider-list");
    await changedFrame(ui, () => ui.mouse.click("row:1")); // 选中 alpha
    expect(ui.mouse.frame?.layer).toBe("provider-list");
    await changedFrame(ui, () => ui.mouse.click("row:1"));
    expect(ui.mouse.frame?.layer).toBe("provider-actions");
    ui.mouse.click("refresh");
    await settle(
      () => ui.onOp.mock.calls.length === 1 && ui.mouse.frame?.layer === "provider-list",
    );
    expect(ui.onOp).toHaveBeenCalledWith("alpha", "refresh");
    await changedFrame(ui, () => ui.mouse.click("row:1"));
    await changedFrame(ui, () => ui.mouse.click("remove"));
    expect(ui.lastFrame()).toContain("> [ 取消 ]");
    await changedFrame(ui, () => ui.mouse.click("cancel"));
    expect(ui.onConfirmRemove).not.toHaveBeenCalled();
    await changedFrame(ui, () => ui.mouse.click("row:1"));
    await changedFrame(ui, () => ui.mouse.click("remove"));
    ui.mouse.click("remove");
    await settle(() => ui.onConfirmRemove.mock.calls.length === 1);
  });
  it("滚轮只在列表区域滚动，对话框期间冻结，关闭后选择不变", async () => {
    const ui = await page({ many: true });
    const first = ui.lastFrame();
    ui.mouse.feed({ type: "wheel", dir: "down", x: 1, y: 1 }); // 页头不滚
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ui.lastFrame()).toBe(first);
    for (let i = 0; i < 10; i++) {
      const box = ui.mouse.frame?.boxes.find((b) => b.id.startsWith("row:"));
      if (!box) throw new Error("missing provider rows");
      await changedFrame(ui, () =>
        ui.mouse.feed({ type: "wheel", dir: "down", x: box.colStart, y: box.row }),
      );
    }
    expect(ui.lastFrame()).not.toContain("provider-00");
    expect(ui.lastFrame()).toContain("provider-30");
    const list = ui.lastFrame();
    await changedFrame(ui, () => ui.stdin.write("\r"));
    expect(ui.lastFrame()).toContain("服务商 provider-30");
    ui.mouse.feed({ type: "wheel", dir: "down", x: 2, y: 8 });
    ui.stdin.write("ignored-filter");
    await changedFrame(ui, () => ui.stdin.write("\x1b"));
    expect(ui.lastFrame()).toBe(list);
  });
  it("拖动经过控件再返回松开也不触发动作、选中或向导", async () => {
    const ui = await page();
    const box = ui.mouse.at("row:1");
    const original = ui.lastFrame();
    ui.mouse.feed({ type: "press", button: 0, x: box.colStart, y: box.row });
    ui.mouse.feed({ type: "drag", button: 0, x: box.colStart + 2, y: box.row });
    ui.mouse.feed({ type: "release", button: 0, x: box.colStart, y: box.row });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ui.lastFrame()).toBe(original);
    await changedFrame(ui, () => ui.stdin.write("\x1b[B"));
    await changedFrame(ui, () => ui.stdin.write("\r"));
    const button = ui.mouse.at("remove");
    ui.mouse.feed({ type: "press", button: 0, x: button.colStart, y: button.row });
    ui.mouse.feed({ type: "drag", button: 0, x: button.colStart + 1, y: button.row });
    ui.mouse.feed({ type: "release", button: 0, x: button.colStart, y: button.row });
    await changedFrame(ui, () => ui.stdin.write("\x1b"));
    expect(ui.onConfirmRemove).not.toHaveBeenCalled();
    expect(ui.onOp).not.toHaveBeenCalled();
    expect(ui.mouse.frame?.layer).toBe("provider-list");
  });
  it("只读条目仍给配置文件提示并打开只读模型列表，Delete 不开删除对话框", async () => {
    const ui = await page({ readonly: true });
    await changedFrame(ui, () => ui.stdin.write("\x1b[3~"));
    expect(ui.lastFrame()).toContain("请编辑该处配置");
    await changedFrame(ui, () => ui.stdin.write("\r"));
    await settle(() => ui.onListModels.mock.calls.length === 1);
    expect(ui.onReadonlyHint).toHaveBeenCalled();
    expect(ui.lastFrame()).toContain("config.json");
    expect(ui.onConfirmRemove).not.toHaveBeenCalled();
    expect(ui.onOp).not.toHaveBeenCalled();
  });
  it("inline 同套对话框键盘可用、不登记鼠标；ASCII 边框和底部提示", async () => {
    const ui = await page({ inline: true, ascii: true });
    expect(ui.lastFrame()).toContain("↑↓ 移动  Enter 操作  Delete 删除  Tab 切换栏  Esc 返回");
    expect(ui.mouse.frame).toBeUndefined();
    await configured(ui);
    expect(ui.lastFrame()).toContain("+");
    expect(ui.mouse.frame).toBeUndefined();
    await changedFrame(ui, () => ui.stdin.write("\x1b"));
    expect(ui.onClose).not.toHaveBeenCalled();
  });
});
