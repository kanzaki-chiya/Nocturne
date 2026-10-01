import { Box, Text, useInput, type DOMElement } from "ink";
import { useEffect, useRef, useState } from "react";
import stringWidth from "string-width";
import type {
  SecurityReviewerConfig,
  PermissionPresetName,
  Runtime,
  RuntimeSession,
  SettingItem,
  SettingsPatch,
} from "@nocturne/core";
import { useTheme, type ThemeId } from "../theme.js";
import { DialogFrame } from "./dialog/dialog-frame.js";
import { Segmented, segmentedLines } from "./dialog/segmented.js";
import { Buttons } from "./dialog/buttons.js";
import { ConfirmDiscard } from "./dialog/confirm-discard.js";
import { moveFocus } from "./dialog/focus.js";
import { screenRect, type DialogMouseFrame } from "./dialog/mouse.js";
import { PickList } from "./pick-list.js";
import { ReviewerDialog } from "./reviewer-dialog.js";
import { ThemePage } from "./theme-page.js";
import { CompactionThresholdDialog } from "./compaction-threshold-dialog.js";

const SOURCES: Record<SettingItem["source"], string> = {
  default: "默认",
  setup: "向导",
  settings: "设置",
  user: "config.json",
  project: "项目配置",
  env: "环境变量",
  cli: "命令行",
};
const PRESETS = ["read-only", "default", "auto-edit", "guarded", "smart", "bypass"] as const;
const ORDER = ["preset", "reviewer", "theme", "shell", "threshold", "cancel", "save"];

export function SettingsPage({
  runtime,
  session,
  width,
  height,
  onClose,
  onThemeChange,
  onMouseFrame,
}: {
  runtime: Runtime;
  session: RuntimeSession;
  width: number;
  height: number;
  onClose: () => void;
  onThemeChange?: ((id: ThemeId) => void) | undefined;
  onMouseFrame?: ((frame: DialogMouseFrame | undefined) => void) | undefined;
}): React.JSX.Element {
  const palette = useTheme();
  const [initial] = useState(() => ({
    items: runtime.describeSettings(),
    theme: palette.id,
    shell: session.shellInfo().selected,
  }));
  const item = (key: SettingItem["key"]) => initial.items.find((entry) => entry.key === key);
  const [preset, setPreset] = useState(item("permissions.preset")?.saved ?? "");
  const legacyReviewer = (value: string | undefined): SecurityReviewerConfig | undefined => {
    if (!value) return undefined;
    if (value === "off") return { backend: "off" };
    const slash = value.indexOf("/");
    return slash > 0
      ? {
          backend: "model",
          model: { provider: value.slice(0, slash), model: value.slice(slash + 1) },
        }
      : undefined;
  };
  const savedReviewer =
    item("permission.reviewer")?.reviewer?.saved ??
    legacyReviewer(item("permission.reviewer")?.saved);
  const [reviewer, setReviewer] = useState(savedReviewer);
  const [reviewerKey, setReviewerKey] = useState<string>();
  const [disclosureAccepted, setDisclosureAccepted] = useState(false);
  const effectiveReviewer =
    reviewer ??
    item("permission.reviewer")?.reviewer?.effective ??
    legacyReviewer(item("permission.reviewer")?.effective);
  const [theme, setTheme] = useState(initial.theme);
  const [shell, setShell] = useState(initial.shell);
  const [threshold, setThreshold] = useState(item("compaction.threshold")?.saved);
  const [focus, setFocus] = useState("preset");
  const [nested, setNested] = useState<"theme" | "shell" | "reviewer" | "threshold" | undefined>();
  const [confirm, setConfirm] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const boxes = useRef(new Map<string, DOMElement>());
  // 默认模型与档位成对只读显示，修改去 /model 页「设为默认」（ADR-0034 修订）
  const model = item("defaultModel")?.effective;
  const effort = item("reasoningEffort")?.effective ?? "off";
  const choices: Record<string, readonly string[]> = {
    preset: ["", ...PRESETS],
    theme: ["dark", "light"],
  };
  const values: Record<string, string> = { preset, theme };
  const labels = (id: string) =>
    (choices[id] ?? []).map((value) =>
      id === "theme" ? (value === "dark" ? "深色" : "浅色") : value || "跟随默认",
    );
  const dirty =
    preset !== (item("permissions.preset")?.saved ?? "") ||
    JSON.stringify(reviewer) !== JSON.stringify(savedReviewer) ||
    reviewerKey !== undefined ||
    threshold !== item("compaction.threshold")?.saved ||
    theme !== initial.theme ||
    shell !== initial.shell;
  const cancel = () => {
    onThemeChange?.(initial.theme);
    onClose();
  };
  const requestCancel = () => {
    if (dirty) setConfirm(true);
    else cancel();
  };
  const preview = (id: ThemeId) => {
    setTheme(id);
    onThemeChange?.(id);
  };
  const change = (key: string, value: string) => {
    if (key === "preset") setPreset(value);
    if (key === "theme") preview(value as ThemeId);
  };
  const save = async () => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(undefined);
    try {
      const patch: SettingsPatch = {};
      if (threshold !== item("compaction.threshold")?.saved)
        patch["compaction.threshold"] = threshold ?? null;
      if (preset !== (item("permissions.preset")?.saved ?? ""))
        patch["permissions.preset"] = (preset || null) as PermissionPresetName | null;
      if (JSON.stringify(reviewer) !== JSON.stringify(savedReviewer) || reviewerKey !== undefined)
        patch["permission.reviewer"] = reviewer ?? null;
      if (Object.keys(patch).length > 0) {
        if (reviewerKey === undefined) await runtime.updateSettings(patch);
        else await runtime.updateSettings(patch, { reviewerKey });
      }
      if (disclosureAccepted) await runtime.setPreference("jevDisclosureAccepted", "yes");
      if (shell !== initial.shell) await session.setShell(shell);
      if (theme !== initial.theme) await runtime.setPreference("theme", theme);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  const activate = (id: string) => {
    if (busy.current) return;
    if (id === "save") void save();
    else if (id === "cancel") requestCancel();
    else if (id === "theme" || id === "shell" || id === "reviewer" || id === "threshold")
      setNested(id);
  };
  useInput(
    (input, key) => {
      if (busy.current) return;
      if (confirm) {
        if (key.escape) setConfirm(false);
        else if (key.leftArrow || key.rightArrow || key.tab) setDiscard(!discard);
        else if (key.return) {
          if (discard) cancel();
          else setConfirm(false);
        }
        return;
      }
      if (key.escape || (key.ctrl && (input === "c" || input === "d"))) {
        requestCancel();
        return;
      }
      if (key.tab || key.upArrow || key.downArrow) {
        setFocus(
          moveFocus(
            ORDER,
            focus,
            key.tab ? (key.shift ? "shiftTab" : "tab") : key.upArrow ? "up" : "down",
          ),
        );
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        const options = choices[focus];
        if (options)
          change(
            focus,
            options[
              (Math.max(0, options.indexOf(values[focus] ?? "")) +
                (key.leftArrow ? options.length - 1 : 1)) %
                options.length
            ] ?? "",
          );
        else setFocus(moveFocus(ORDER, focus, key.leftArrow ? "left" : "right"));
      }
      if (key.return || input === " ") activate(focus);
    },
    { isActive: nested === undefined },
  );
  useEffect(() => {
    if (!onMouseFrame || nested) return;
    const hits = [...boxes.current].flatMap(([id, node]) => {
      const rect = screenRect(node);
      if (confirm && id !== "discard" && id !== "continue") return [];
      if (choices[id]) {
        const options = choices[id];
        const selected = Math.max(0, options.indexOf(values[id] ?? ""));
        const line = segmentedLines(labels(id), selected, Math.max(1, width - 6), 1)[0] ?? "";
        let offset = 2;
        return (
          line.startsWith("<") ? [line.split(" / ")[0] ?? ""] : (line.match(/\[[^\]]*\]/g) ?? [])
        ).map((token, index) => {
          const hit = {
            id: `${id}:${line.startsWith("<") ? "next" : index}`,
            row: rect.row,
            colStart: rect.col + offset,
            colEnd: rect.col + offset + stringWidth(token) - 1,
          };
          offset += stringWidth(token) + 1;
          return hit;
        });
      }
      return Array.from({ length: rect.height }, (_, row) => ({
        id,
        row: rect.row + row,
        colStart: rect.col,
        colEnd: rect.col + rect.width - 1,
      }));
    });
    onMouseFrame({
      layer: confirm ? "settings-discard" : "settings",
      boxes: hits.filter((hit) => hit.row > 2 && hit.row < height),
      click: (id) => {
        if (confirm) {
          if (id === "discard") cancel();
          else if (id === "continue") setConfirm(false);
          return;
        }
        const [field = "", index] = id.split(":");
        setFocus(field);
        const options = choices[field];
        if (options)
          change(
            field,
            options[
              index === "next"
                ? (Math.max(0, options.indexOf(values[field] ?? "")) + 1) % options.length
                : Number(index)
            ] ?? "",
          );
        else activate(id);
      },
      wheel: () => undefined,
    });
    return () => {
      onMouseFrame(undefined);
    };
  });
  const onBox = (id: string, node: DOMElement | null) => {
    if (node) boxes.current.set(id, node);
    else boxes.current.delete(id);
  };
  if (nested === "theme")
    return (
      <ThemePage
        width={width}
        height={height}
        active
        onCancel={() => {
          setNested(undefined);
        }}
        onSave={(id) => {
          preview(id);
          setNested(undefined);
          return Promise.resolve();
        }}
      />
    );
  if (nested === "threshold")
    return (
      <CompactionThresholdDialog
        initial={threshold ?? item("compaction.threshold")?.effective ?? "90%"}
        width={width}
        height={height}
        onMouseFrame={onMouseFrame}
        onCancel={() => {
          setNested(undefined);
        }}
        onApply={(value) => {
          setThreshold(value);
          setNested(undefined);
        }}
      />
    );
  if (nested === "reviewer")
    return (
      <ReviewerDialog
        runtime={runtime}
        initial={effectiveReviewer}
        initialKey={reviewerKey}
        disclosureAccepted={disclosureAccepted}
        width={width}
        height={height}
        onCancel={() => {
          setNested(undefined);
        }}
        onMouseFrame={onMouseFrame}
        onApply={(selected, key, accepted) => {
          setReviewer(selected);
          setReviewerKey(key);
          setDisclosureAccepted(accepted ?? false);
          setNested(undefined);
        }}
      />
    );
  if (nested === "shell")
    return (
      <DialogFrame title="/settings · Shell" width={width} height={height} framed>
        <PickList
          title="选择 shell"
          width={width - 4}
          active
          initialValue={shell}
          items={[
            { label: "auto", value: "auto" },
            ...session.listShells().map((entry) => ({
              label: entry.available ? `${entry.kind} ${entry.name}` : `${entry.kind}（未安装）`,
              value: entry.kind,
              disabled: !entry.available,
            })),
          ]}
          onCancel={() => {
            setNested(undefined);
          }}
          onPick={(kind) => {
            setShell(kind);
            setNested(undefined);
          }}
        />
      </DialogFrame>
    );
  const source = (key: SettingItem["key"]) => {
    const entry = item(key);
    return entry
      ? entry.overridden
        ? `已保存，但被 ${SOURCES[entry.source]} 覆盖`
        : SOURCES[entry.source]
      : "默认";
  };
  const field = (id: string, label: string, key?: SettingItem["key"]) => (
    <Box flexDirection="column" flexShrink={0} key={id}>
      <Text wrap="truncate">
        {label} ·{" "}
        {key
          ? `${item(key)?.effective ?? "未设置"} · ${source(key)}`
          : `${theme} · ${runtime.getPreference("theme") === undefined ? "默认" : "设置"}`}
      </Text>
      <Box
        ref={(node) => {
          onBox(id, node);
        }}
      >
        <Segmented
          options={labels(id)}
          selected={Math.max(0, (choices[id] ?? []).indexOf(values[id] ?? ""))}
          focused={focus === id}
          width={Math.max(1, width - 6)}
          maxLines={1}
        />
      </Box>
    </Box>
  );
  return (
    <DialogFrame title="/settings 设置" width={width} height={height} framed>
      <Text wrap="truncate" color={palette.muted}>
        默认值对新会话生效；当前会话用 Alt+M 切换权限、Shift+Tab 切换思考档位
      </Text>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <Box
          flexDirection="column"
          flexShrink={0}
          marginTop={
            -Math.max(
              0,
              ((
                { preset: 2, reviewer: 4, theme: 7, shell: 9, threshold: 10 } as Record<
                  string,
                  number
                >
              )[focus] ?? 8) - Math.max(1, height - 8),
            )
          }
        >
          <Text bold>会话默认</Text>
          {field("preset", "默认权限预设", "permissions.preset")}
          <Box
            ref={(node) => {
              onBox("reviewer", node);
            }}
          >
            <Text wrap="truncate" color={focus === "reviewer" ? palette.selected : palette.text}>
              {focus === "reviewer" ? "> " : "  "}安全审查：
              {!effectiveReviewer || effectiveReviewer.backend === "off"
                ? "关闭"
                : effectiveReviewer.backend === "jev"
                  ? `Jev · ${effectiveReviewer.endpoint} · ${effectiveReviewer.model}`
                  : `小模型 · ${effectiveReviewer.model.provider}/${effectiveReviewer.model.model}`}{" "}
              · {source("permission.reviewer")} · Enter 选择
            </Text>
          </Box>
          <Text wrap="truncate">
            默认模型与档位 · {model ?? "未设置"} · 档位 {effort} · {source("defaultModel")} · 在
            /model 页设置
          </Text>
          <Text bold>界面</Text>
          {field("theme", "主题（Enter 预览）")}
          <Text bold>执行</Text>
          <Box
            ref={(node) => {
              onBox("shell", node);
            }}
          >
            <Text wrap="truncate" color={focus === "shell" ? palette.selected : palette.text}>
              {focus === "shell" ? "> " : "  "}Shell ·{" "}
              {shell === initial.shell ? (item("shell")?.effective ?? shell) : shell} ·{" "}
              {source("shell")} · Enter 选择
            </Text>
          </Box>
          <Box
            ref={(node) => {
              onBox("threshold", node);
            }}
          >
            <Text wrap="truncate" color={focus === "threshold" ? palette.selected : palette.text}>
              {focus === "threshold" ? "> " : "  "}压缩阈值 ·{" "}
              {threshold ?? item("compaction.threshold")?.effective ?? "90%"} ·{" "}
              {source("compaction.threshold")} · Enter 设置
            </Text>
          </Box>
        </Box>
      </Box>
      <Text wrap="truncate" color={error ? palette.error : palette.muted}>
        {error
          ? `保存失败：${error}`
          : saving
            ? "正在保存…"
            : focus === "threshold"
              ? "压缩阈值对下一 Turn 生效 · Enter 设置 · Esc 取消"
              : "↑↓/Tab 移动 · ←→ 选择 · Enter 确认 · Esc 取消"}
      </Text>
      {confirm ? (
        <ConfirmDiscard discard={discard} onBox={onBox} />
      ) : (
        <Buttons focused={focus} readonly={false} width={width - 4} onBox={onBox} />
      )}
    </DialogFrame>
  );
}
