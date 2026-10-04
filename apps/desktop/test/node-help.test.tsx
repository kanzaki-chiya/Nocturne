import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeHelp, probeRows } from "../src/NodeHelp";
import type { NodeProbe } from "../src/types";

afterEach(cleanup);

const noop = () => undefined;
const REQUIRED = "24.14.0";

function probe(partial: Partial<NodeProbe>): NodeProbe {
  return { required: REQUIRED, steps: [], selected: null, ok: false, ...partial };
}

const tooOld = probe({
  steps: [
    { source: "env", status: "unset", path: null },
    { source: "bundled", status: "not-bundled", path: "R:\\node\\node.exe" },
    { source: "path", status: "found", path: "C:\\Program Files\\nodejs\\node.exe" },
  ],
  selected: {
    source: "path",
    path: "C:\\Program Files\\nodejs\\node.exe",
    version: "v22.11.0",
    error: null,
  },
});

const notFound = probe({
  steps: [
    { source: "env", status: "unset", path: null },
    { source: "bundled", status: "not-bundled", path: "R:\\node\\node.exe" },
    { source: "path", status: "missing", path: null },
  ],
});

const envMissing = probe({
  steps: [
    { source: "env", status: "missing", path: "C:\\x\\node.exe" },
    { source: "bundled", status: "skipped", path: null },
    { source: "path", status: "skipped", path: null },
  ],
});

describe("probeRows", () => {
  it("版本过低：四行文案与 bad/dim 类", () => {
    const rows = probeRows(tooOld);
    expect(rows).toEqual([
      { label: "NOCTURNE_NODE", text: "未设置", cls: "dim" },
      { label: "随附 Node", text: "此版本不随附", cls: "dim" },
      { label: "PATH", text: "C:\\Program Files\\nodejs\\node.exe", cls: undefined },
      { label: "版本", text: "v22.11.0，需要 ≥ 24.14.0", cls: "bad" },
    ]);
  });

  it("未找到：PATH 未找到、版本 —", () => {
    const rows = probeRows(notFound);
    expect(rows[2]).toEqual({ label: "PATH", text: "未找到", cls: "dim" });
    expect(rows[3]).toEqual({ label: "版本", text: "—", cls: "dim" });
  });

  it("NOCTURNE_NODE 指向不存在文件：missing 标 bad，后续未检查", () => {
    const rows = probeRows(envMissing);
    expect(rows[0]).toEqual({
      label: "NOCTURNE_NODE",
      text: "C:\\x\\node.exe（文件不存在）",
      cls: "bad",
    });
    expect(rows[1]).toEqual({ label: "随附 Node", text: "未检查", cls: "dim" });
    expect(rows[2]).toEqual({ label: "PATH", text: "未检查", cls: "dim" });
    expect(rows[3]).toEqual({ label: "版本", text: "—", cls: "dim" });
  });
});

describe("NodeHelp", () => {
  it("版本过低的页面文案", () => {
    render(<NodeHelp probe={tooOld} checking={false} onProbe={noop} openUrl={noop} />);
    expect(screen.getByText("需要 Node.js 24.14 或更高版本")).toBeTruthy();
    expect(screen.getByText(/当前找到的版本太旧/)).toBeTruthy();
    expect(screen.getByText("v22.11.0，需要 ≥ 24.14.0")).toBeTruthy();
  });

  it("未找到的页面文案", () => {
    render(<NodeHelp probe={notFound} checking={false} onProbe={noop} openUrl={noop} />);
    expect(screen.getByText(/没有找到 Node\.js/)).toBeTruthy();
  });

  it("运行出错的页面文案", () => {
    const broken = probe({
      steps: [
        { source: "env", status: "unset", path: null },
        { source: "bundled", status: "not-bundled", path: null },
        { source: "path", status: "found", path: "C:\\nodejs\\node.exe" },
      ],
      selected: { source: "path", path: "C:\\nodejs\\node.exe", version: null, error: "无法启动" },
    });
    render(<NodeHelp probe={broken} checking={false} onProbe={noop} openUrl={noop} />);
    expect(screen.getByText(/无法运行找到的 Node\.js/)).toBeTruthy();
  });

  it("点「打开 nodejs.org」调用 openUrl", () => {
    const openUrl = vi.fn();
    render(<NodeHelp probe={tooOld} checking={false} onProbe={noop} openUrl={openUrl} />);
    fireEvent.click(screen.getByText("打开 nodejs.org"));
    expect(openUrl).toHaveBeenCalledWith("https://nodejs.org/");
  });

  it("点「重新检测」调用回调；检测中禁用", () => {
    const onProbe = vi.fn();
    const { rerender } = render(
      <NodeHelp probe={tooOld} checking={false} onProbe={onProbe} openUrl={noop} />,
    );
    fireEvent.click(screen.getByText("重新检测"));
    expect(onProbe).toHaveBeenCalledTimes(1);
    rerender(<NodeHelp probe={tooOld} checking={true} onProbe={onProbe} openUrl={noop} />);
    expect((screen.getByText("重新检测") as HTMLButtonElement).disabled).toBe(true);
  });
});
