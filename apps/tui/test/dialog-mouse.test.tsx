import { createElement, useState } from "react";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanup, render } from "ink-testing-library";
import stringWidth from "string-width";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRuntime,
  FakeProvider,
  type ModelField,
  type ModelSettingsView,
} from "@nocturne/core";
import { runTui } from "../src/index.js";
import { App } from "../src/app.js";
import { ModelEditPane } from "../src/components/model-settings-view.js";
import { ProviderPage } from "../src/components/provider-page.js";
import type { DialogMouseFrame } from "../src/components/dialog/mouse.js";
import { createClickTracker, type HitBox } from "../src/click.js";
import { createMouseParser, type MouseEvent } from "../src/mouse.js";

afterEach(cleanup);
const field = <T,>(value: T): ModelField<T> => ({
  value,
  editable: true,
  source: { kind: "upstream" },
});
const view: ModelSettingsView = {
  providerId: "up",
  modelId: "m1",
  readonly: false,
  fields: {
    displayName: { ...field("中文AB"), userValue: "中文AB" },
    contextWindow: field(100000),
    maxOutputTokens: field(8000),
    imageInput: field(false),
    reasoning: field("visible"),
    reasoningEffort: field(["low", "high"]),
    protocol: field("openai-compatible"),
    editTool: field("edit" as const),
  },
};
function mouseController() {
  let frame: DialogMouseFrame | undefined;
  const tracker = createClickTracker();
  const report = (next: DialogMouseFrame | undefined): void => {
    if (next?.layer !== frame?.layer) tracker.reset();
    frame = next;
  };
  const parser = createMouseParser({
    onFlushText: vi.fn(),
    onEvent: (event) => {
      if (!frame) return;
      if (event.type === "wheel") frame.wheel(event);
      else {
        const id = tracker.feed(event, frame.boxes);
        if (id) frame.click(id, event);
      }
    },
  });
  const at = (id: string): HitBox => {
    const hit = frame?.boxes.find((box) => box.id === id);
    if (!hit) throw new Error(`Missing ${id}: ${JSON.stringify(frame?.boxes)}`);
    return hit;
  };
  const send = (button: number, x: number, y: number, release = false): void => {
    expect(parser.feed(`\x1b[<${button};${x};${y}${release ? "m" : "M"}`)).toBe("");
  };
  const click = (id: string, offset = 0): void => {
    const box = at(id);
    send(0, box.colStart + offset, box.row);
    send(0, box.colStart + offset, box.row, true);
  };
  return {
    report,
    at,
    send,
    click,
    get frame() {
      return frame;
    },
  };
}
async function editor(width = 100, height = 29, extra = {}) {
  const mouse = mouseController();
  const onSave = vi.fn(),
    onBack = vi.fn();
  const props = {
    view,
    active: true,
    width,
    height,
    onSave,
    onBack,
    onMouseFrame: mouse.report,
    ...extra,
  };
  const ui = render(createElement(ModelEditPane, props));
  await waitLong(() => expect(mouse.frame?.boxes.length).toBeGreaterThan(0));
  return { mouse, ui, onSave, onBack, props };
}
/** 全量并发下渲染较慢，vi.waitFor 默认 1 秒不够用 */
function waitLong<T>(fn: () => T): Promise<T> {
  return vi.waitFor(fn, { timeout: 5000 });
}
async function changed(ui: ReturnType<typeof render>, action: () => void) {
  const count = ui.frames.length;
  action();
  await waitLong(() => expect(ui.frames.length).toBeGreaterThan(count));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
function visibleText(ui: ReturnType<typeof render>, box: HitBox): string {
  const line = ui.lastFrame()?.split("\n")[box.row - 1] ?? "";
  let col = 1,
    result = "";
  for (const char of line) {
    if (col >= box.colStart && col <= box.colEnd) result += char;
    col += stringWidth(char);
  }
  return result;
}

async function sessionFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "nct-dialog-mouse-"));
  vi.stubEnv("NOCTURNE_HOME", path.join(root, "home"));
  const runtime = await createRuntime({
    cwd: root,
    sessionsDir: path.join(root, "sessions"),
    providers: [new FakeProvider({ scripts: [] })],
  });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  const save = vi.fn(() => Promise.resolve());
  const provider = {
    config: {
      describeProviders: async () => [
        {
          id: "up",
          type: "openai-compatible",
          host: "example.com",
          keySource: "credential",
          origin: "setup",
          overridden: false,
          modelCount: 1,
          managed: true,
        },
      ],
      listModelSettings: async () => [view],
      saveModelSettings: save,
      credentials: { backend: () => "none" },
      base: { providers: [] },
    } as never,
    reloadConfig: async () => ({}) as never,
    updateProviders: vi.fn(),
    workspaceRoot: undefined,
  };
  return {
    runtime,
    session,
    provider,
    save,
    dispose: async () => {
      await session.close();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function ttyPair() {
  const chunks: string[] = [];
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, {
    columns: 100,
    rows: 30,
    isTTY: true,
    write: (chunk: string) => {
      chunks.push(String(chunk));
      return true;
    },
  });
  const stdin = new EventEmitter() as NodeJS.ReadStream & { write: (text: string) => void };
  let pending: string | null = null;
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: () => stdin,
    setEncoding: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
    read: () => {
      const text = pending;
      pending = null;
      return text;
    },
    write: (text: string) => {
      pending = text;
      stdin.emit("readable");
      stdin.emit("data", text);
    },
  });
  const stderr = new EventEmitter() as NodeJS.WriteStream;
  stderr.write = () => true;
  return { stdin, stdout, stderr, chunks };
}

describe("dialog mouse app routing", () => {
  it("inline provider and model dialog never enable mouse reporting", async () => {
    const fixture = await sessionFixture();
    const io = ttyPair();
    const done = runTui({ session: fixture.session }, fixture.runtime, {
      ...io,
      inline: true,
      provider: fixture.provider,
      patchConsole: false,
    });
    const output = () => io.chunks.join("");
    try {
      await waitLong(() => expect(output()).toContain("Nocturne"));
      io.stdin.write("/provider model up m1");
      await waitLong(() => expect(output()).toContain("/provider model up m1"));
      io.stdin.write("\r");
      await waitLong(() => expect(output()).toContain("编辑档位"));
      expect(output()).toContain("服务商");
      io.stdin.write("\x04");
      await done;
      expect(output()).not.toContain("\x1b[?1000h");
      expect(output()).not.toContain("\x1b[?1002h");
      expect(output()).not.toContain("\x1b[?1006h");
    } finally {
      await fixture.dispose();
    }
  }, 15000);
  it("fullscreen routes SGR clicks only to the dialog and restores the underlying page on close", async () => {
    const fixture = await sessionFixture();
    const listeners = new Set<(event: MouseEvent) => void>();
    const mouse = {
      subscribe: (fn: (event: MouseEvent) => void) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    };
    const parser = createMouseParser({
      onFlushText: vi.fn(),
      onEvent: (event) => {
        for (const fn of listeners) fn(event);
      },
    });
    const ui = render(
      createElement(App, { ...fixture, env: { ascii: false, animated: false }, mouse }),
    );
    const clickText = (token: string) => {
      const lines = ui.lastFrame()?.split("\n") ?? [];
      const row = lines.findIndex((line) => line.includes(token));
      expect(row).toBeGreaterThanOrEqual(0);
      const line = lines[row] ?? "";
      const col = stringWidth(line.slice(0, line.indexOf(token))) + 1;
      parser.feed(`\x1b[<0;${col};${row + 1}M\x1b[<0;${col};${row + 1}m`);
    };
    try {
      await waitLong(() => expect(ui.lastFrame()).toContain("v0.4.0"));
      await changed(ui, () => ui.stdin.write("/provider model up m1"));
      ui.stdin.write("\r");
      await waitLong(() => expect(ui.lastFrame()).toContain("编辑档位"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      const original = ui.lastFrame();
      parser.feed("\x1b[<0;1;1M\x1b[<32;5;5M\x1b[<0;1;1m\x1b[<65;1;1M");
      expect(ui.lastFrame()).toBe(original);
      await changed(ui, () => clickText("[  是]"));
      clickText("[ 保存 ]");
      await waitLong(() =>
        expect(fixture.save).toHaveBeenCalledWith(
          "up",
          "m1",
          { displayName: "中文AB", imageInput: true },
          undefined,
        ),
      );
      await waitLong(() => expect(ui.lastFrame()).toContain("已保存"));
      expect(ui.lastFrame()).not.toContain("编辑档位");
      await changed(ui, () => ui.stdin.write("\x1b"));
      expect(ui.lastFrame()).toContain("已配置");
      // 唯一一行默认已选中，单击即打开操作对话框
      await changed(ui, () => clickText("● up"));
      expect(ui.lastFrame()).toContain("[ 换密钥 ]");
      await changed(ui, () => ui.stdin.write("\x1b"));
      await changed(ui, () => ui.stdin.write("\x1b"));
      expect(ui.lastFrame()).toContain("idle");
    } finally {
      ui.unmount();
      parser.dispose();
      await fixture.dispose();
    }
  }, 15000);
});

describe("model dialog SGR clicks", () => {
  it("uses rendered bracket columns, aligns controls, and positions a Chinese input cursor", async () => {
    const { mouse, ui, onSave } = await editor();
    expect(mouse.at("displayName").colStart).toBe(mouse.at("imageInput:0").colStart);
    expect(visibleText(ui, mouse.at("imageInput:1"))).toBe("[  是]");
    expect(visibleText(ui, mouse.at("displayName"))).toMatch(/^\[ 中文AB\s+\]$/);
    await changed(ui, () => mouse.click("displayName", 4)); // After 中 (two display columns).
    await changed(ui, () => ui.stdin.write("X"));
    mouse.click("save");
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ displayName: "中X文AB" }));
  });
  it("selects each segment without saving and applies effort popup options with keyboard exclusivity", async () => {
    const { mouse, ui, onSave } = await editor();
    await changed(ui, () => mouse.click("imageInput:1"));
    expect(onSave).not.toHaveBeenCalled();
    await changed(ui, () => mouse.click("reasoning:1"));
    await changed(ui, () => mouse.click("protocol:2"));
    await changed(ui, () => mouse.click("reasoningEffort"));
    await changed(ui, () => mouse.click("option:3")); // low
    await changed(ui, () => mouse.click("option:5")); // high
    await changed(ui, () => mouse.click("option:1")); // exclusive unsupported
    expect(ui.lastFrame()).toContain("[x] 不支持思考强度");
    expect(ui.lastFrame()).not.toContain("[x] low");
    await changed(ui, () => mouse.click("option:3"));
    await changed(ui, () => mouse.click("option:5"));
    await changed(ui, () => mouse.click("confirm"));
    mouse.click("save");
    expect(onSave).toHaveBeenCalledWith({
      displayName: "中文AB",
      imageInput: true,
      reasoning: "visible",
      reasoningEffort: ["low", "high"],
      protocol: "anthropic",
    });
  });
  it("popup cancel keeps its original draft; discard confirmation consumes its own buttons", async () => {
    const { mouse, ui, onBack, onSave } = await editor();
    await changed(ui, () => mouse.click("reasoningEffort"));
    await changed(ui, () => mouse.click("option:1"));
    await changed(ui, () => mouse.click("cancel"));
    await changed(ui, () => mouse.click("imageInput:1"));
    await changed(ui, () => mouse.click("cancel"));
    expect(mouse.frame?.boxes.map((box) => box.id)).toEqual(["continue", "discard"]);
    await changed(ui, () => mouse.click("continue"));
    await changed(ui, () => mouse.click("cancel"));
    mouse.click("discard");
    expect(onBack).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });
  it("clean cancel returns, readonly fields have no hit boxes", async () => {
    const { mouse, onBack } = await editor(100, 29, { readonly: true });
    expect(mouse.frame?.boxes.map((box) => box.id)).toEqual(["return"]);
    mouse.click("return");
    expect(onBack).toHaveBeenCalledOnce();
    const clean = await editor();
    clean.mouse.click("cancel");
    expect(clean.onBack).toHaveBeenCalledOnce();
  });
  it("drag out and back, border, empty space, and outside wheel do nothing", async () => {
    const { mouse, ui, onSave, onBack } = await editor();
    const original = ui.lastFrame();
    const box = mouse.at("save");
    mouse.send(0, box.colStart, box.row);
    mouse.send(32, 1, 1);
    mouse.send(32, box.colStart, box.row);
    mouse.send(0, box.colStart, box.row, true);
    for (const [x, y] of [
      [15, 4],
      [16, 5],
      [1, 1],
    ] as const) {
      mouse.send(0, x, y);
      mouse.send(0, x, y, true);
    }
    mouse.send(65, 1, 1);
    expect(ui.lastFrame()).toBe(original);
    expect(onSave).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
  });
  it("recomputes hits after one-row wheels and resize including frameless degradation", async () => {
    const { mouse, ui, props, onSave } = await editor(32, 12);
    const before = mouse.at("displayName").row;
    const box = mouse.at("displayName");
    await changed(ui, () => mouse.send(65, box.colStart, box.row));
    expect(mouse.frame?.boxes.find((hit) => hit.id === "displayName")).toBeUndefined();
    expect(visibleText(ui, mouse.at("contextWindow"))).toMatch(/^\[ /);
    await changed(ui, () => mouse.click("contextWindow", 2));
    await changed(ui, () => ui.stdin.write("42"));
    ui.rerender(createElement(ModelEditPane, { ...props, width: 60, height: 23 }));
    await waitLong(() => expect(mouse.at("contextWindow").row).not.toBe(before));
    expect(visibleText(ui, mouse.at("contextWindow"))).toMatch(/^\[ 42/);
    mouse.click("save");
    expect(onSave).toHaveBeenCalledWith({ displayName: "中文AB", contextWindow: 42 });
  });
  it("save matches Enter, blocks burst clicks while saving, and keeps the draft after failure", async () => {
    const mouse = mouseController(),
      onSave = vi.fn();
    let fail: () => void = vi.fn();
    function Harness() {
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState<string>();
      fail = () => {
        setSaving(false);
        setError("不可写");
      };
      return createElement(ModelEditPane, {
        view,
        active: true,
        width: 100,
        height: 29,
        saving,
        error,
        onBack: vi.fn(),
        onMouseFrame: mouse.report,
        onSave: (patch) => {
          onSave(patch);
          setSaving(true);
        },
      });
    }
    const ui = render(createElement(Harness));
    await waitLong(() => expect(mouse.frame).toBeDefined());
    await changed(ui, () => mouse.click("imageInput:1"));
    mouse.click("save");
    mouse.click("save");
    expect(onSave).toHaveBeenCalledOnce();
    await waitLong(() => expect(ui.lastFrame()).toContain("正在保存"));
    mouse.click("save");
    expect(onSave).toHaveBeenCalledOnce();
    await changed(ui, fail);
    expect(ui.lastFrame()).toContain("保存失败：不可写");
    await changed(ui, () => ui.stdin.write("\r"));
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[0]).toEqual(onSave.mock.calls[1]);
  });
  it("freezes the underlying provider selection and filter and removes mouse routing when closed", async () => {
    const mouse = mouseController();
    const ui = render(
      createElement(ProviderPage, {
        presets: [],
        entries: [
          {
            id: "up",
            type: "openai-compatible",
            host: "example.com",
            keySource: "credential",
            origin: "setup",
            overridden: false,
            modelCount: 1,
            managed: true,
          },
        ],
        wizard: undefined,
        onStartWizard: vi.fn(),
        onOp: vi.fn(),
        onReadonlyHint: () => "",
        onConfirmRemove: vi.fn(),
        onClose: vi.fn(),
        onListModels: async () => [view],
        initialModelTarget: { providerId: "up", modelId: "m1" },
        onMouseFrame: mouse.report,
        width: 100,
        height: 29,
        termRows: 30,
        active: true,
      }),
    );
    await waitLong(() =>
      expect(mouse.frame?.boxes.some((box) => box.id === "displayName")).toBe(true),
    );
    const frame = ui.lastFrame();
    mouse.send(0, 1, 1);
    mouse.send(0, 1, 1, true);
    mouse.send(65, 1, 1);
    expect(ui.lastFrame()).toBe(frame);
    await changed(ui, () => mouse.click("cancel"));
    await waitLong(() => expect(mouse.frame).toBeUndefined());
    expect(ui.lastFrame()).toContain("m1");
    await changed(ui, () => ui.stdin.write("\x1b"));
    expect(ui.lastFrame()).toContain("服务商");
    expect(ui.lastFrame()).toContain("up");
  });
});
