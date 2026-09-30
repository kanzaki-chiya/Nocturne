/**
 * settings.json —— 程序维护的设置层（ADR-0034）。
 *
 * <NOCTURNE_HOME>/settings.json 由程序原子写入、只写自己的文件；与手写
 * config.json 分层合并时手写优先。白名单设置与通用字符串偏好
 * 共用此文件；读入保留未知字段原样写回。
 */
import { inferShellKindFromPath, isShellKind, type ShellSpec } from "../platform/index.js";
import type { Platform } from "../platform/index.js";
import { writeJsonAtomic } from "./files.js";
import { parseConfigFile } from "./schema.js";
import type { ConfigFile, SettingsPatch } from "./types.js";
import type { ReasoningEffort } from "../protocol/index.js";

/** settings.json 的原始 JSON 对象（未知字段保留） */
type SettingsData = Record<string, unknown>;

export interface SettingsStore {
  fields(): ConfigFile;
  update(patch: SettingsPatch): Promise<void>;
  setDefaultModel(model: string, effort: ReasoningEffort | null): Promise<void>;
  /** 当前 shell 层值原文；未设置或字段无效时为 undefined */
  shellFields(): { shell?: string | undefined; shellPath?: string | undefined } | undefined;
  /** shell 层值 → ShellSpec（kind+path）；无值时 undefined */
  shellSpec(): ShellSpec | undefined;
  /** /shell 写入端：原子重写文件并更新内存态（live getter 立即可见） */
  setShell(kind: string, path?: string): Promise<void>;
  getPreference(key: string): string | undefined;
  setPreference(key: string, value: string | undefined): Promise<void>;
}

const reservedFields = new Set(["model", "reasoningEffort", "permissions", "shell", "shellPath"]);

export function validateSettingsPatch(input: unknown): asserts input is SettingsPatch {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== "permissions.preset")
  ) {
    throw new TypeError("仅支持 permissions.preset；默认档位随默认模型经 setDefaultModel 保存");
  }
  const patch = input as SettingsPatch;
  const preset = patch["permissions.preset"];
  parseConfigFile(
    {
      ...(preset !== null && preset !== undefined ? { permissions: { preset } } : {}),
    },
    "settings.json",
  );
}

function configFields(data: SettingsData, warn?: (message: string) => void): ConfigFile {
  let result: ConfigFile = {};
  for (const key of ["model", "reasoningEffort", "shell", "shellPath", "permissions"] as const) {
    if (!Object.hasOwn(data, key)) continue;
    const value =
      key === "permissions" &&
      typeof data.permissions === "object" &&
      data.permissions !== null &&
      !Array.isArray(data.permissions)
        ? { preset: (data.permissions as { preset?: unknown }).preset }
        : data[key];
    try {
      result = { ...result, ...parseConfigFile({ [key]: value }, "settings.json") };
    } catch {
      warn?.(`settings.json 的 ${key} 无效，已忽略`);
    }
  }
  if (
    result.shell === undefined &&
    result.shellPath !== undefined &&
    inferShellKindFromPath(result.shellPath) === undefined
  ) {
    delete result.shellPath;
  }
  return result;
}

function readShellFields(data: SettingsData):
  | {
      shell?: string | undefined;
      shellPath?: string | undefined;
    }
  | undefined {
  const shell = typeof data.shell === "string" ? data.shell : undefined;
  const shellPath = typeof data.shellPath === "string" ? data.shellPath : undefined;
  if (shell === undefined && shellPath === undefined) return undefined;
  return { shell, shellPath };
}

function toSpec(fields: {
  shell?: string | undefined;
  shellPath?: string | undefined;
}): ShellSpec | undefined {
  if (fields.shell !== undefined) {
    const lower = fields.shell.toLowerCase();
    if (lower === "auto") return { kind: "auto" };
    if (isShellKind(lower)) {
      return {
        kind: lower,
        ...(fields.shellPath !== undefined ? { path: fields.shellPath } : {}),
      };
    }
    // 无效种类名：忽略整个字段（加载时已警告），回退由上层/自动决定
    return undefined;
  }
  // 只有 shellPath：按文件名推断种类（与 specFromConfigFields 同一规则）
  if (fields.shellPath !== undefined) {
    const stem = inferShellKindFromPath(fields.shellPath);
    if (stem !== undefined) return { kind: stem, path: fields.shellPath };
  }
  return undefined;
}

/**
 * 加载 settings.json：文件不存在 → 空设置；损坏 → 忽略并给警告
 * （设置层降级不阻塞启动，与项目配置损坏同一处理）。
 */
export async function loadSettingsStore(
  platform: Platform,
  settingsPath: string,
): Promise<{ store: SettingsStore; warning?: string | undefined }> {
  const { fs } = platform;
  let data: SettingsData = {};
  let warning: string | undefined;
  if (await fs.exists(settingsPath)) {
    try {
      const raw: unknown = JSON.parse(await fs.readTextFile(settingsPath));
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        data = { ...(raw as SettingsData) };
      } else {
        warning = `settings.json 不是 JSON 对象，设置已忽略（${settingsPath}）`;
      }
    } catch (e) {
      warning = `settings.json 无法解析（${e instanceof Error ? e.message : String(e)}），设置已忽略`;
    }
  }
  configFields(data, (message) => {
    warning = warning ? `${warning}\n${message}` : message;
  });
  const fields = readShellFields(data);
  if (
    fields?.shell !== undefined &&
    fields.shell.toLowerCase() !== "auto" &&
    !isShellKind(fields.shell.toLowerCase())
  ) {
    warning =
      (warning !== undefined ? `${warning}\n` : "") +
      `settings.json 的 shell="${fields.shell}" 无法识别（可选：auto | pwsh | powershell | bash | cmd | sh），已忽略`;
  }
  // shellPath 单独存在而文件名识别不出种类：不是有效声明，忽略并警告
  // （ADR-0022：shellPath 的语义是给指定种类换可执行文件；文件名推断
  // 只是兼容写法，识别不了不能静默回退自动）
  if (
    fields?.shell === undefined &&
    fields?.shellPath !== undefined &&
    inferShellKindFromPath(fields.shellPath) === undefined
  ) {
    warning =
      (warning !== undefined ? `${warning}\n` : "") +
      `settings.json 的 shellPath="${fields.shellPath}" 无法识别为支持的 shell 可执行文件，已忽略`;
  }

  let pending = Promise.resolve();
  function write(update: (next: SettingsData) => void): Promise<void> {
    const operation = pending.then(async () => {
      const next = { ...data };
      update(next);
      await writeJsonAtomic(fs, platform.paths, settingsPath, next);
      data = next;
    });
    pending = operation.catch(() => undefined);
    return operation;
  }

  return {
    warning,
    store: {
      fields: () => configFields(data),
      async update(patch) {
        validateSettingsPatch(patch);
        const preset = patch["permissions.preset"];
        await write((next) => {
          if (preset !== undefined) {
            const permissions =
              typeof next.permissions === "object" &&
              next.permissions !== null &&
              !Array.isArray(next.permissions)
                ? { ...(next.permissions as Record<string, unknown>) }
                : {};
            if (preset === null) delete permissions.preset;
            else permissions.preset = preset;
            next.permissions = permissions;
          }
        });
      },
      async setDefaultModel(model, effort) {
        parseConfigFile(
          { model, ...(effort !== null ? { reasoningEffort: effort } : {}) },
          settingsPath,
        );
        await write((next) => {
          next.model = model;
          if (effort === null) delete next.reasoningEffort;
          else next.reasoningEffort = effort;
        });
      },
      shellFields: () => readShellFields(data),
      shellSpec: () => {
        const f = readShellFields(data);
        return f === undefined ? undefined : toSpec(f);
      },
      async setShell(kind, path) {
        await write((next) => {
          if (kind === "auto") {
            delete next.shell;
            delete next.shellPath;
          } else {
            next.shell = kind;
            if (path !== undefined) next.shellPath = path;
            else delete next.shellPath;
          }
        });
      },
      getPreference: (key) => {
        const value = Object.hasOwn(data, key) ? data[key] : undefined;
        return typeof value === "string" ? value : undefined;
      },
      async setPreference(key, value) {
        if (
          typeof key !== "string" ||
          !/^[a-z][a-z\d_-]*$/iu.test(key) ||
          reservedFields.has(key)
        ) {
          throw new TypeError(`不能写入保留或无效的偏好字段：${key}`);
        }
        if (value !== undefined && typeof value !== "string") {
          throw new TypeError(`偏好 ${key} 的值必须是字符串或 undefined`);
        }
        await write((next) => {
          if (value === undefined) Reflect.deleteProperty(next, key);
          else next[key] = value;
        });
      },
    },
  };
}
