import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { Scrim } from "./ProvidersPage";
import {
  deriveTheme,
  expandCustomTheme,
  PRESETS,
  type CustomTheme,
  type CustomThemeSeed,
  type ThemeMode,
  type ThemeVars,
} from "./theme-presets";
import { Button, Icon, ICON_MD, ICON_SM } from "./ui";

export {
  expandCustomTheme,
  previewThemeVars as resolvePreviewThemeVars,
  type CustomTheme,
  type CustomThemeSeed,
} from "./theme-presets";

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const SEED_FIELDS: readonly (readonly [keyof CustomThemeSeed, string])[] = [
  ["bg", "背景"],
  ["text", "文字"],
  ["accent", "强调"],
];
const MAX_NAME_CODEPOINTS = 24;

/** 获取指定主题在当前模式下的 `{ bg, text, accent }` 初始种子。 */
export function seedForMode(
  id: string,
  mode: ThemeMode,
  customThemes?: readonly CustomTheme[],
): CustomThemeSeed {
  const preset = PRESETS.find((entry) => entry.id === id);
  if (preset) {
    const entry = preset[mode];
    return { bg: entry.bg, text: entry.text, accent: entry.accent };
  }
  const custom = customThemes?.find((entry) => entry.id === id);
  if (custom) {
    const entry = expandCustomTheme(custom)[mode];
    return { bg: entry.bg, text: entry.text, accent: entry.accent };
  }
  const fallback = PRESETS[0][mode];
  return { bg: fallback.bg, text: fallback.text, accent: fallback.accent };
}

export function generateCustomThemeId(existing: readonly CustomTheme[] = []): string {
  const used = new Set(existing.map((item) => item.id));
  for (let i = 0; i < 16; i++) {
    const candidate = `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (!used.has(candidate)) return candidate;
  }
  return `custom-${Date.now().toString(36)}`;
}

export function exportThemeJson(theme: { name: string } & CustomThemeSeed): string {
  return JSON.stringify(
    {
      nocturneTheme: 1,
      name: theme.name,
      bg: theme.bg,
      text: theme.text,
      accent: theme.accent,
    },
    null,
    2,
  );
}

/** 严格校验导入 JSON：`nocturneTheme === 1`、非空且 ≤24 码点 `name`、三色 `#rrggbb`（转小写），忽略其他字段。 */
export function parseImportedTheme(
  text: string,
  existing: readonly CustomTheme[] = [],
): CustomTheme | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.nocturneTheme !== 1) return null;
  if (typeof obj.name !== "string") return null;
  const trimmedName = obj.name.trim();
  const codePointCount = Array.from(trimmedName).length;
  if (codePointCount === 0 || codePointCount > MAX_NAME_CODEPOINTS) return null;
  if (
    typeof obj.bg !== "string" ||
    typeof obj.text !== "string" ||
    typeof obj.accent !== "string"
  ) {
    return null;
  }
  if (!HEX_COLOR.test(obj.bg) || !HEX_COLOR.test(obj.text) || !HEX_COLOR.test(obj.accent)) {
    return null;
  }
  return {
    id: generateCustomThemeId(existing),
    name: trimmedName,
    bg: obj.bg.toLowerCase(),
    text: obj.text.toLowerCase(),
    accent: obj.accent.toLowerCase(),
  };
}

function normalizeThemeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "我的主题";
  return Array.from(trimmed).slice(0, MAX_NAME_CODEPOINTS).join("");
}

function useEscapeClose(active: boolean, onEscape: () => void) {
  const callbackRef = useRef(onEscape);
  callbackRef.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      callbackRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [active]);
}

/** 编辑浮窗右侧迷你应用预览（照抄效果图 big(v)，整块 inert）。 */
function MiniAppPreview({ vars, mode }: { vars: ThemeVars; mode: ThemeMode }) {
  const previewStyle: ThemeVars = {
    ...vars,
    "--a-success": mode === "light" ? "#2a7146" : "#86c69c",
  };
  return (
    <div className="theme-app-pv" style={previewStyle} inert aria-hidden="true">
      <div className="theme-app-pv-tb">
        <span className="theme-app-pv-dot" />
        Nocturne
      </div>
      <div className="theme-app-pv-body">
        <div className="theme-app-pv-side">
          <div className="theme-app-pv-h">项目</div>
          <div>nocturne</div>
          <div className="on">外观主题</div>
          <div>侧栏分批展开</div>
          <div>通知小图标</div>
        </div>
        <div className="theme-app-pv-main">
          <div className="theme-app-pv-user">
            <span>给外观加主题</span>
          </div>
          <div className="theme-app-pv-line">
            <span className="m">读取</span> <code>appearance.ts</code>
          </div>
          <div className="theme-app-pv-line">
            <span className="m">运行</span> <code>vitest run</code>{" "}
            <span className="ok">18 通过</span>
          </div>
          <div className="theme-app-pv-line">
            主题种子色写在 <span className="lk">design/themes</span>，其余推算。
          </div>
          <div className="theme-app-pv-comp">
            <div className="theme-app-pv-ph">输入消息</div>
            <div className="theme-app-pv-bar">
              <span>+</span>
              <span className="chip2">目标</span>
              <span className="r">GPT-6 Astra · high</span>
              <span className="sd" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ExportDialog({ json, onClose }: { json: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEscapeClose(true, onClose);

  const handleCopy = async () => {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard?.writeText) {
      try {
        await clipboard.writeText(json);
        setCopied(true);
        return;
      } catch {
        // 剪贴板写入失败时降级选中文本
      }
    }
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      ta.select();
    }
  };

  return (
    <Scrim onClose={onClose}>
      <div className="dlg theme-dlg-io" role="dialog" aria-label="导出主题">
        <div className="theme-dlg-head">
          <h3>导出主题</h3>
          <button type="button" className="theme-dlg-close" aria-label="关闭" onClick={onClose}>
            <Icon name="close" size={ICON_MD} />
          </button>
        </div>
        <div className="theme-dlg-io-body">
          <textarea ref={textareaRef} className="theme-textarea" readOnly value={json} />
        </div>
        <div className="theme-dlg-foot">
          <span className="sp" />
          <Button variant="primary" onClick={() => void handleCopy()}>
            {copied ? "已复制" : "复制"}
          </Button>
        </div>
      </div>
    </Scrim>
  );
}

export type CustomThemeDialogRequest =
  | { kind: "new"; initialSeed: CustomThemeSeed }
  | { kind: "edit"; theme: CustomTheme }
  | { kind: "import" };

export function CustomThemeDialog({
  request,
  existingThemes,
  onClose,
  onSave,
  onDelete,
  onImport,
}: {
  request: CustomThemeDialogRequest;
  existingThemes: readonly CustomTheme[];
  onClose: () => void;
  onSave: (theme: CustomTheme, isNew: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onImport: (theme: CustomTheme) => Promise<void>;
}) {
  if (request.kind === "import") {
    return (
      <ImportThemeDialog existingThemes={existingThemes} onClose={onClose} onImport={onImport} />
    );
  }
  return (
    <EditThemeDialog
      initialTheme={request.kind === "edit" ? request.theme : undefined}
      initialSeed={request.kind === "new" ? request.initialSeed : request.theme}
      existingThemes={existingThemes}
      onClose={onClose}
      onSave={onSave}
      onDelete={onDelete}
    />
  );
}

function EditThemeDialog({
  initialTheme,
  initialSeed,
  existingThemes,
  onClose,
  onSave,
  onDelete,
}: {
  initialTheme: CustomTheme | undefined;
  initialSeed: CustomThemeSeed;
  existingThemes: readonly CustomTheme[];
  onClose: () => void;
  onSave: (theme: CustomTheme, isNew: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const isEdit = initialTheme !== undefined;
  const nameInputId = useId();
  const nameInputRef = useRef<HTMLInputElement>(null);
  const deleteBtnRef = useRef<HTMLButtonElement>(null);
  const exportBtnRef = useRef<HTMLButtonElement>(null);
  const wasExportOpenRef = useRef(false);

  const [name, setName] = useState(() => (initialTheme ? initialTheme.name : "我的主题"));
  const [seed, setSeed] = useState<CustomThemeSeed>(() => ({
    bg: initialSeed.bg.toLowerCase(),
    text: initialSeed.text.toLowerCase(),
    accent: initialSeed.accent.toLowerCase(),
  }));
  const [hexValues, setHexValues] = useState<CustomThemeSeed>(() => ({
    bg: initialSeed.bg.toLowerCase(),
    text: initialSeed.text.toLowerCase(),
    accent: initialSeed.accent.toLowerCase(),
  }));
  const [badHex, setBadHex] = useState<Record<keyof CustomThemeSeed, boolean>>({
    bg: false,
    text: false,
    accent: false,
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (exportOpen) {
      wasExportOpenRef.current = true;
      return;
    }
    if (wasExportOpenRef.current) {
      wasExportOpenRef.current = false;
      exportBtnRef.current?.focus();
      return;
    }
    const input = nameInputRef.current;
    if (!input) return;
    input.focus();
    if (!isEdit) input.select();
  }, [exportOpen, isEdit]);

  useEscapeClose(!exportOpen, () => {
    if (!busy) onClose();
  });

  const expanded = expandCustomTheme(seed);
  const lightVars = deriveTheme(expanded.light, "light");
  const darkVars = deriveTheme(expanded.dark, "dark");

  const applyValidColor = (key: keyof CustomThemeSeed, value: string, syncHexText: boolean) => {
    const lower = value.toLowerCase();
    setSeed((prev) => ({ ...prev, [key]: lower }));
    if (syncHexText) {
      setHexValues((prev) => ({ ...prev, [key]: lower }));
    }
    setBadHex((prev) => ({ ...prev, [key]: false }));
  };

  const handleHexChange = (key: keyof CustomThemeSeed, rawValue: string) => {
    setHexValues((prev) => ({ ...prev, [key]: rawValue }));
    let normalized = rawValue.trim();
    if (normalized.length > 0 && !normalized.startsWith("#")) {
      normalized = `#${normalized}`;
    }
    if (HEX_COLOR.test(normalized)) {
      applyValidColor(key, normalized, false);
    } else {
      setBadHex((prev) => ({ ...prev, [key]: true }));
    }
  };

  const handleHexBlur = (key: keyof CustomThemeSeed) => {
    setHexValues((prev) => ({ ...prev, [key]: seed[key] }));
    setBadHex((prev) => ({ ...prev, [key]: false }));
  };

  const handleSave = async () => {
    if (busy) return;
    setBusy(true);
    setSubmitError(null);
    const saved: CustomTheme = {
      id: initialTheme ? initialTheme.id : generateCustomThemeId(existingThemes),
      name: normalizeThemeName(name),
      bg: seed.bg,
      text: seed.text,
      accent: seed.accent,
    };
    try {
      await onSave(saved, !isEdit);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteClick = async () => {
    if (!initialTheme || busy) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    setSubmitError(null);
    try {
      await onDelete(initialTheme.id);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (exportOpen) {
    return (
      <ExportDialog
        json={exportThemeJson({
          name: normalizeThemeName(name),
          bg: seed.bg,
          text: seed.text,
          accent: seed.accent,
        })}
        onClose={() => {
          setExportOpen(false);
        }}
      />
    );
  }

  return (
    <Scrim
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="dlg theme-dlg-edit"
        role="dialog"
        aria-label={isEdit ? "编辑主题" : "新建主题"}
        onClickCapture={(event) => {
          if (!confirmDelete) return;
          const target = event.target as Node | null;
          if (target !== null && deleteBtnRef.current?.contains(target)) return;
          setConfirmDelete(false);
        }}
      >
        <div className="theme-dlg-head">
          <h3>{isEdit ? "编辑主题" : "新建主题"}</h3>
          <button
            type="button"
            className="theme-dlg-close"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="close" size={ICON_MD} />
          </button>
        </div>
        <div className="theme-dlg-body">
          <div className="theme-dlg-form">
            <div className="theme-color-row">
              <label className="theme-color-label" htmlFor={nameInputId}>
                名称
              </label>
              <input
                ref={nameInputRef}
                id={nameInputId}
                type="text"
                className="input theme-name-input"
                value={name}
                maxLength={MAX_NAME_CODEPOINTS}
                spellCheck={false}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </div>
            {SEED_FIELDS.map(([key, label]) => (
              <div key={key} className="theme-color-row">
                <span className="theme-color-label">{label}</span>
                <label className="theme-swatch" style={{ backgroundColor: seed[key] }}>
                  <input
                    type="color"
                    aria-label={label}
                    value={seed[key]}
                    onChange={(event) => {
                      applyValidColor(key, event.target.value, true);
                    }}
                  />
                </label>
                <input
                  type="text"
                  className={`input theme-hex${badHex[key] ? " bad" : ""}`}
                  aria-label={label}
                  value={hexValues[key]}
                  maxLength={7}
                  spellCheck={false}
                  onChange={(event) => {
                    handleHexChange(key, event.target.value);
                  }}
                  onBlur={() => {
                    handleHexBlur(key);
                  }}
                />
              </div>
            ))}
            {submitError !== null && (
              <div className="theme-dlg-err" role="alert">
                {submitError}
              </div>
            )}
          </div>
          <div className="theme-dlg-preview">
            <MiniAppPreview vars={lightVars} mode="light" />
            <MiniAppPreview vars={darkVars} mode="dark" />
          </div>
        </div>
        <div className="theme-dlg-foot">
          {isEdit && (
            <>
              <button
                ref={deleteBtnRef}
                type="button"
                className="theme-link-btn danger"
                disabled={busy}
                onClick={() => void handleDeleteClick()}
              >
                {confirmDelete ? "确认删除" : "删除"}
              </button>
              <button
                ref={exportBtnRef}
                type="button"
                className="theme-link-btn"
                disabled={busy}
                onClick={() => {
                  setConfirmDelete(false);
                  setExportOpen(true);
                }}
              >
                导出
              </button>
            </>
          )}
          <span className="sp" />
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void handleSave()}>
            保存
          </Button>
        </div>
      </div>
    </Scrim>
  );
}

function ImportThemeDialog({
  existingThemes,
  onClose,
  onImport,
}: {
  existingThemes: readonly CustomTheme[];
  onClose: () => void;
  onImport: (theme: CustomTheme) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEscapeClose(true, () => {
    if (!busy) onClose();
  });

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setText(typeof reader.result === "string" ? reader.result : "");
      setError(null);
    };
    reader.readAsText(file);
  };

  const handleSubmit = async () => {
    if (busy) return;
    const parsed = parseImportedTheme(text, existingThemes);
    if (!parsed) {
      setError("不是有效的主题文件");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onImport(parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Scrim
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="dlg theme-dlg-io" role="dialog" aria-label="导入主题">
        <div className="theme-dlg-head">
          <h3>导入主题</h3>
          <button
            type="button"
            className="theme-dlg-close"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="close" size={ICON_MD} />
          </button>
        </div>
        <div className="theme-dlg-io-body">
          <textarea
            ref={textareaRef}
            className={`theme-textarea${error !== null ? " bad" : ""}`}
            spellCheck={false}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              if (error !== null) setError(null);
            }}
          />
          {error !== null && (
            <div className="theme-dlg-err" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="theme-dlg-foot">
          <Button
            disabled={busy}
            onClick={() => {
              fileInputRef.current?.click();
            }}
          >
            <Icon name="file" size={ICON_SM} />
            选择文件
          </Button>
          <span className="sp" />
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void handleSubmit()}>
            导入
          </Button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={handleFileChange}
        />
      </div>
    </Scrim>
  );
}
