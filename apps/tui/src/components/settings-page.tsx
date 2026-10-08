/**
 * /settings 设置页（ADR-0045 第 7 节、ADR-0034）：用 PageShell 画双栏，逐项保存。
 * 单值项（默认权限预设、主题）←→ 立即写入；复合项 Enter 打开对话框或选择页，
 * 对话框里的「保存」就是落盘，取消不写任何东西。写入失败时值回到原样，错误显示在说明区。
 */
import { Box } from "ink";
import { useRef, useState } from "react";
import type {
  ModelRole,
  PermissionPresetName,
  Runtime,
  RuntimeSession,
  SecurityReviewerConfig,
  SettingItem,
  SettingsPatch,
} from "@nocturne/core";

import { useTheme, THEME_LABELS, type ThemeId } from "../theme.js";
import { DialogFrame } from "./dialog/dialog-frame.js";
import type { DialogMouseFrame } from "./dialog/mouse.js";
import { CompactionThresholdDialog } from "./compaction-threshold-dialog.js";
import { ModelPicker } from "./model-picker.js";
import { PickList } from "./pick-list.js";
import { PageShell, type ShellNotice, type ShellRow, type ShellSpan } from "./page/page-shell.js";
import { ReviewerDialog } from "./reviewer-dialog.js";
import { ThemePage } from "./theme-page.js";

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
const ROLES = ["task", "vision", "smol"] as const;
const ROLE_LABELS = { task: "子代理模型", vision: "看图模型", smol: "标题模型" };
const GROUPS = [
  { id: "session", label: "会话默认" },
  { id: "ui", label: "界面" },
  { id: "exec", label: "执行" },
  { id: "roles", label: "模型角色" },
];
const SUBTITLE = "默认值对新会话生效；当前会话用 Alt+M 切换权限、Shift+Tab 切换思考档位";

/** 每一项的一句话说明，显示在说明区（TUI 侧维护，不进 Core） */
const EXPLAIN: Record<string, string> = {
  preset: "新会话的权限预设；规则拦下的操作按预设直接执行、先交审查器判断或询问你",
  reviewer: "smart 预设下由审查器判断待确认的操作，可选 Jev 或本地小模型；Enter 打开设置",
  defaultModel: "新会话使用的模型与思考档位，成对保存；到 /model 页选「设为默认」修改",
  theme: "界面深浅配色；←→ 立即切换，Enter 打开预览页",
  shell: "shell 工具使用的命令行；auto 按探测结果选择，Enter 选择",
  threshold: "上下文占用达到该值时自动压缩，支持百分比或 token 数；100% 停止预防性压缩",
  task: "子代理使用的模型；未设置时跟随当前模型，Enter 选择",
  vision: "当前模型不能看图时，由它先描述图片再发送；只列支持图片输入的模型，Enter 选择",
  smol: "生成会话标题等轻量任务使用的模型；未设置时跟随当前模型，Enter 选择",
};

type Nested = "theme" | "shell" | "reviewer" | "threshold" | ModelRole;
const FULL_PAGE: readonly Nested[] = ["theme", "shell", ...ROLES];

function legacyReviewer(value: string | undefined): SecurityReviewerConfig | undefined {
  if (!value) return undefined;
  if (value === "off") return { backend: "off" };
  const slash = value.indexOf("/");
  return slash > 0
    ? {
        backend: "model",
        model: { provider: value.slice(0, slash), model: value.slice(slash + 1) },
      }
    : undefined;
}

function reviewerText(reviewer: SecurityReviewerConfig | undefined): string {
  if (!reviewer || reviewer.backend === "off") return "关闭";
  return reviewer.backend === "jev"
    ? `Jev · ${reviewer.endpoint} · ${reviewer.model}`
    : `小模型 · ${reviewer.model.provider}/${reviewer.model.model}`;
}

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

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
  const [items, setItems] = useState(() => runtime.describeSettings());
  const [pending, setPending] = useState<{ preset?: string }>({});
  const pendingRef = useRef<{ preset?: string }>({});
  const [themeSaved, setThemeSaved] = useState(() => runtime.getPreference("theme") !== undefined);
  const [nested, setNested] = useState<Nested | undefined>();
  const [notice, setNotice] = useState<ShellNotice>();
  const item = (key: SettingItem["key"]) => items.find((entry) => entry.key === key);
  const fail = (text: string) => {
    setNotice({ text: `保存失败：${text}`, tone: "error" });
  };

  const source = (key: SettingItem["key"]): string => {
    const entry = item(key);
    if (!entry) return "默认";
    return entry.overridden ? `已保存，被 ${SOURCES[entry.source]} 覆盖` : SOURCES[entry.source];
  };
  const trail = (key: SettingItem["key"]) => ({
    text: source(key),
    tone: item(key)?.overridden ? ("warning" as const) : ("muted" as const),
  });

  const commit = async (
    patch: SettingsPatch,
    options?: { reviewerKey: string },
  ): Promise<string | undefined> => {
    try {
      const next =
        options === undefined
          ? await runtime.updateSettings(patch)
          : await runtime.updateSettings(patch, options);
      setItems(next.length > 0 ? next : runtime.describeSettings());
      return undefined;
    } catch (cause) {
      return message(cause);
    }
  };

  const presetValue = (): string => pending.preset ?? item("permissions.preset")?.saved ?? "";
  const adjustPreset = (dir: -1 | 1) => {
    const options = ["", ...PRESETS];
    const current = pendingRef.current.preset ?? item("permissions.preset")?.saved ?? "";
    const next =
      options[(Math.max(0, options.indexOf(current)) + dir + options.length) % options.length] ??
      "";
    pendingRef.current = { preset: next };
    setPending(pendingRef.current);
    setNotice(undefined);
    void commit({ "permissions.preset": (next || null) as PermissionPresetName | null }).then(
      (failure) => {
        pendingRef.current = {};
        setPending({});
        if (failure !== undefined) fail(failure);
      },
    );
  };
  const adjustTheme = (dir: -1 | 1) => {
    const options: ThemeId[] = ["dark", "light"];
    const previous = palette.id;
    const next = options[(options.indexOf(previous) + dir + options.length) % options.length];
    if (next === undefined) return;
    setNotice(undefined);
    onThemeChange?.(next);
    void runtime.setPreference("theme", next).then(
      () => {
        setThemeSaved(true);
      },
      (cause: unknown) => {
        onThemeChange?.(previous);
        fail(message(cause));
      },
    );
  };

  const pickShell = (kind: string) => {
    setNested(undefined);
    void session.setShell(kind).then(
      () => {
        setItems(runtime.describeSettings());
      },
      (cause: unknown) => {
        fail(message(cause));
      },
    );
  };
  const pickRole = (role: ModelRole, ref: string) => {
    setNested(undefined);
    if (
      role === "vision" &&
      ref !== "" &&
      !runtime
        .listModels()
        .some((m) => `${m.ref.provider}/${m.ref.model}` === ref && m.capabilities.imageInput)
    ) {
      fail("看图模型必须支持图片，请重新选择或清除");
      return;
    }
    setNotice(undefined);
    void commit({ [`modelRoles.${role}`]: ref === "" ? null : ref }).then((failure) => {
      if (failure !== undefined) fail(failure);
    });
  };

  const effectiveReviewer =
    item("permission.reviewer")?.reviewer?.effective ??
    legacyReviewer(item("permission.reviewer")?.effective);
  const model = item("defaultModel")?.effective;
  const effort = item("reasoningEffort")?.effective ?? "off";
  const themeLabel = THEME_LABELS[palette.id];

  const rows: ShellRow[] = [
    {
      id: "preset",
      group: "session",
      cells: [{ text: "默认权限预设" }, { text: presetValue() || "跟随默认", arrows: true }],
      trail: [trail("permissions.preset")],
      search: `默认权限预设 ${EXPLAIN.preset}`,
    },
    {
      id: "reviewer",
      group: "session",
      cells: [{ text: "安全审查" }, { text: reviewerText(effectiveReviewer) }],
      trail: [trail("permission.reviewer")],
      search: `安全审查 ${EXPLAIN.reviewer}`,
    },
    {
      id: "defaultModel",
      group: "session",
      cells: [
        { text: "默认模型与档位" },
        { text: `${model ?? "未设置"} · ${effort}`, tone: "muted" },
      ],
      trail: [{ text: "在 /model 设置", tone: "muted" }],
      search: `默认模型与档位 ${EXPLAIN.defaultModel}`,
    },
    {
      id: "theme",
      group: "ui",
      cells: [{ text: "主题" }, { text: themeLabel, arrows: true }],
      trail: [{ text: themeSaved ? "设置" : "默认", tone: "muted" }],
      search: `主题 ${EXPLAIN.theme}`,
    },
    {
      id: "shell",
      group: "exec",
      cells: [{ text: "Shell" }, { text: item("shell")?.effective ?? "auto" }],
      trail: [trail("shell")],
      search: `Shell ${EXPLAIN.shell}`,
    },
    {
      id: "threshold",
      group: "exec",
      cells: [{ text: "压缩阈值" }, { text: item("compaction.threshold")?.effective ?? "90%" }],
      trail: [trail("compaction.threshold")],
      search: `压缩阈值 ${EXPLAIN.threshold}`,
    },
    ...ROLES.map((role): ShellRow => {
      const key = `modelRoles.${role}` as const;
      const value = item(key)?.effective;
      return {
        id: role,
        group: "roles",
        cells: [
          { text: ROLE_LABELS[role] },
          {
            text: value ?? (role === "vision" ? "未设置" : "跟随当前模型"),
            ...(value === undefined ? { tone: "muted" as const } : {}),
          },
        ],
        trail: [trail(key)],
        search: `${ROLE_LABELS[role]} ${EXPLAIN[role]}`,
      };
    }),
  ];

  const labelOf = (id: string): string =>
    id === "preset"
      ? "默认权限预设"
      : id === "reviewer"
        ? "安全审查"
        : id === "defaultModel"
          ? "默认模型与档位"
          : id === "theme"
            ? "主题"
            : id === "shell"
              ? "Shell"
              : id === "threshold"
                ? "压缩阈值"
                : ROLE_LABELS[id as ModelRole];
  const keyOf = (id: string): SettingItem["key"] | undefined =>
    id === "preset"
      ? "permissions.preset"
      : id === "reviewer"
        ? "permission.reviewer"
        : id === "defaultModel"
          ? "defaultModel"
          : id === "shell"
            ? "shell"
            : id === "threshold"
              ? "compaction.threshold"
              : ROLES.includes(id as ModelRole)
                ? (`modelRoles.${id}` as SettingItem["key"])
                : undefined;

  const describe = (row: ShellRow | undefined): ShellSpan[][] => {
    if (row === undefined) return [];
    const first: ShellSpan[] = [
      { text: labelOf(row.id), tone: "secondary" },
      { text: `  ${EXPLAIN[row.id] ?? ""}`, tone: "muted" },
    ];
    const key = keyOf(row.id);
    const entry = key === undefined ? undefined : item(key);
    if (row.id === "theme") return [first, [{ text: "保存在偏好设置，立即生效", tone: "muted" }]];
    if (entry === undefined) return [first];
    if (entry.overridden)
      return [
        first,
        [
          {
            text: `已保存「${entry.saved ?? ""}」，但被 ${SOURCES[entry.source]} 覆盖，实际生效「${entry.effective ?? ""}」`,
            tone: "warning",
          },
        ],
      ];
    if (row.id === "defaultModel")
      return [first, [{ text: `来源：${SOURCES[entry.source]}`, tone: "muted" }]];
    return [
      first,
      [
        {
          text:
            entry.saved === undefined && entry.source === "default"
              ? "未设置，使用默认值"
              : `来源：${SOURCES[entry.source]}${row.id === "preset" ? " · 当前会话用 Alt+M 临时切换" : ""}`,
          tone: "muted",
        },
      ],
    ];
  };

  const fullPage = nested !== undefined && FULL_PAGE.includes(nested);
  const narrow = width < 72;
  const role =
    nested !== undefined && ROLES.includes(nested as ModelRole) ? (nested as ModelRole) : undefined;
  const roleRef = role === undefined ? undefined : item(`modelRoles.${role}`)?.effective;
  const slash = roleRef?.indexOf("/") ?? -1;

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box
        display={fullPage ? "none" : "flex"}
        flexDirection="column"
        width={width}
        height={height}
      >
        <PageShell
          title={["设置"]}
          subtitle={SUBTITLE}
          rows={rows}
          groups={GROUPS}
          sidebar={{ items: GROUPS, mode: "jump" }}
          arrows="adjust"
          describe={describe}
          notice={notice}
          hints={({ focus }) =>
            focus === "side"
              ? [
                  ["↑↓", "移动"],
                  ["Enter", "跳转"],
                  ["Tab", narrow ? "切换分组" : "切换栏"],
                  ["Esc", "返回"],
                ]
              : [
                  ["↑↓", "移动"],
                  ["←→", "修改"],
                  ["Enter", "打开"],
                  ["Tab", narrow ? "切换分组" : "切换栏"],
                  ["Esc", "返回"],
                ]
          }
          width={width}
          height={height}
          active={nested === undefined}
          mouseLayer="settings"
          onMouseFrame={onMouseFrame}
          onSelect={() => {
            setNotice(undefined);
          }}
          onClose={onClose}
          onAdjust={(id, dir) => {
            if (id === "preset") adjustPreset(dir);
            else if (id === "theme") adjustTheme(dir);
          }}
          onActivate={(id) => {
            if (id === "defaultModel")
              setNotice({ text: "默认模型与档位请在 /model 页选「设为默认」", tone: "muted" });
            else if (id === "preset")
              setNotice({ text: "用 ←→ 修改，立即保存到 settings.json", tone: "muted" });
            else setNested(id as Nested);
          }}
        />
      </Box>
      {nested === "threshold" || nested === "reviewer" ? (
        <Box position="absolute" width={width} height={height}>
          {nested === "threshold" ? (
            <CompactionThresholdDialog
              initial={item("compaction.threshold")?.effective ?? "90%"}
              width={width}
              height={height}
              onMouseFrame={onMouseFrame}
              onCancel={() => {
                setNested(undefined);
              }}
              onApply={async (value) => {
                const failure = await commit({ "compaction.threshold": value });
                if (failure === undefined) setNested(undefined);
                return failure;
              }}
            />
          ) : (
            <ReviewerDialog
              runtime={runtime}
              initial={effectiveReviewer}
              width={width}
              height={height}
              onCancel={() => {
                setNested(undefined);
              }}
              onMouseFrame={onMouseFrame}
              onApply={async (selected, key, accepted) => {
                const failure = await commit(
                  { "permission.reviewer": selected },
                  key === undefined ? undefined : { reviewerKey: key },
                );
                if (failure !== undefined) return failure;
                if (accepted === true) {
                  try {
                    await runtime.setPreference("jevDisclosureAccepted", "yes");
                  } catch (cause) {
                    return message(cause);
                  }
                }
                setNested(undefined);
                return undefined;
              }}
            />
          )}
        </Box>
      ) : null}
      {role !== undefined ? (
        <ModelPicker
          models={runtime
            .listModels()
            .filter((m) => role !== "vision" || m.capabilities.imageInput)}
          recents={[]}
          providers={[]}
          presets={[]}
          defaultModel={undefined}
          current={
            roleRef !== undefined && slash > 0
              ? { provider: roleRef.slice(0, slash), model: roleRef.slice(slash + 1) }
              : undefined
          }
          wizard={undefined}
          onStartWizard={() => undefined}
          selectionOnly
          title={["设置", ROLE_LABELS[role]]}
          onMouseFrame={onMouseFrame}
          clearLabel={role === "vision" ? "不使用" : "跟随当前模型"}
          width={width}
          height={height}
          active
          onClose={() => {
            setNested(undefined);
          }}
          onPick={(selected) => {
            pickRole(role, selected);
          }}
        />
      ) : null}
      {nested === "theme" ? (
        <ThemePage
          width={width}
          height={height}
          active
          onCancel={() => {
            setNested(undefined);
          }}
          onSave={async (id) => {
            await runtime.setPreference("theme", id);
            onThemeChange?.(id);
            setThemeSaved(true);
            setNested(undefined);
          }}
        />
      ) : null}
      {nested === "shell" ? (
        <DialogFrame title="设置 › Shell" width={width} height={height} framed>
          <PickList
            title="选择 shell"
            width={width - 4}
            active
            initialValue={session.shellInfo().selected}
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
            onPick={pickShell}
          />
        </DialogFrame>
      ) : null}
    </Box>
  );
}
