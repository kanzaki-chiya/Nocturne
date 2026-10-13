/**
 * settings.json —— 程序维护的设置层（ADR-0034）。
 *
 * <NOCTURNE_HOME>/settings.json 由程序原子写入、只写自己的文件；与手写
 * config.json 分层合并时手写优先。白名单设置与通用字符串偏好
 * 共用此文件；读入保留未知字段原样写回。
 */
import { inferShellKindFromPath, isShellKind, type ShellSpec } from "../platform/index.js";
import type { Platform } from "../platform/index.js";
import { enqueueConfigWrite, writeJsonAtomic } from "./files.js";
import { parseConfigFile } from "./schema.js";
import type { ConfigFile, SettingsPatch } from "./types.js";
import { MODEL_ROLES } from "./types.js";
import type { ReasoningEffort } from "../protocol/index.js";

/** settings.json 的原始 JSON 对象（未知字段保留） */
type SettingsData = Record<string, unknown>;

export interface SettingsStore {
  disabledSkills(): string[];
  setSkillEnabled(name: string, enabled: boolean): Promise<void>;
  /** ADR-0054：settings.json 顶层的服务商/模型停用集合（用户级专用读写） */
  disabledProviders(): string[];
  disabledModels(): string[];
  setProviderEnabled(provider: string, enabled: boolean): Promise<void>;
  setModelsEnabled(provider: string, models: readonly string[], enabled: boolean): Promise<void>;
  /** 删除向导服务商时清除其在两个停用列表里的条目（ADR-0054 §2） */
  clearProviderToggles(provider: string): Promise<void>;
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

const reservedFields = new Set([
  "skills",
  "model",
  "modelRoles",
  "reasoningEffort",
  "permissions",
  "permission",
  "shell",
  "shellPath",
  "compaction",
  "notifications",
  "disabledProviders",
  "disabledModels",
]);

/** settings.json 顶层的字符串数组字段（缺失或类型不符时为空） */
function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function validateSettingsPatch(input: unknown): asserts input is SettingsPatch {
  const NOTIFY_KEYS = [
    "notifications.enabled",
    "notifications.events.attention",
    "notifications.events.error",
    "notifications.events.done",
    "notifications.doneAfterSeconds",
    "notifications.sound",
  ];
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) =>
        key !== "permissions.preset" &&
        key !== "permission.reviewer" &&
        key !== "permission.reviewerRules" &&
        !MODEL_ROLES.some((role) => key === `modelRoles.${role}`) &&
        key !== "compaction.threshold" &&
        !NOTIFY_KEYS.includes(key),
    )
  ) {
    throw new TypeError(
      "仅支持 permissions.preset、permission.reviewer、permission.reviewerRules、compaction.threshold、modelRoles.* 与 notifications.*；默认档位随默认模型经 setDefaultModel 保存",
    );
  }
  const patch = input as SettingsPatch;
  const preset = patch["permissions.preset"];
  const attention = patch["notifications.events.attention"];
  const error = patch["notifications.events.error"];
  const done = patch["notifications.events.done"];
  parseConfigFile(
    {
      modelRoles: Object.fromEntries(
        MODEL_ROLES.flatMap((role) => {
          const ref = patch[`modelRoles.${role}`];
          return ref != null ? [[role, ref]] : [];
        }),
      ),
      ...(patch["compaction.threshold"] != null
        ? { compaction: { threshold: patch["compaction.threshold"] } }
        : {}),
      ...(preset !== null && preset !== undefined ? { permissions: { preset } } : {}),
      ...(patch["permission.reviewer"] != null || patch["permission.reviewerRules"] != null
        ? {
            permission: {
              ...(patch["permission.reviewer"] != null
                ? { reviewer: patch["permission.reviewer"] }
                : {}),
              ...(patch["permission.reviewerRules"] != null
                ? { reviewerRules: patch["permission.reviewerRules"] }
                : {}),
            },
          }
        : {}),
      ...(patch["notifications.enabled"] != null ||
      attention != null ||
      error != null ||
      done != null ||
      patch["notifications.doneAfterSeconds"] != null ||
      patch["notifications.sound"] != null
        ? {
            notifications: {
              ...(patch["notifications.enabled"] != null
                ? { enabled: patch["notifications.enabled"] }
                : {}),
              ...(attention != null || error != null || done != null
                ? {
                    events: {
                      ...(attention != null ? { attention } : {}),
                      ...(error != null ? { error } : {}),
                      ...(done != null ? { done } : {}),
                    },
                  }
                : {}),
              ...(patch["notifications.doneAfterSeconds"] != null
                ? { doneAfterSeconds: patch["notifications.doneAfterSeconds"] }
                : {}),
              ...(patch["notifications.sound"] != null
                ? { sound: patch["notifications.sound"] }
                : {}),
            },
          }
        : {}),
    },
    "settings.json",
  );
}

function configFields(data: SettingsData, warn?: (message: string) => void): ConfigFile {
  let result: ConfigFile = {};
  for (const key of [
    "model",
    "modelRoles",
    "reasoningEffort",
    "shell",
    "shellPath",
    "permissions",
    "compaction",
  ] as const) {
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
  // permission 的两个字段各自校验：追加规则写坏不能连累已配置的审查器
  if (Object.hasOwn(data, "permission")) {
    const permission = data.permission;
    if (typeof permission !== "object" || permission === null || Array.isArray(permission)) {
      warn?.("settings.json 的 permission 无效，已忽略");
    } else {
      for (const key of ["reviewer", "reviewerRules"] as const) {
        const value = (permission as Record<string, unknown>)[key];
        if (value === undefined) continue;
        try {
          const parsed = parseConfigFile({ permission: { [key]: value } }, "settings.json");
          result = {
            ...result,
            permission: { ...result.permission, ...parsed.permission },
          };
        } catch {
          warn?.(`settings.json 的 permission.${key} 无效，已忽略`);
        }
      }
    }
  }
  if (Object.hasOwn(data, "notifications")) {
    const notification = data.notifications;
    if (typeof notification !== "object" || notification === null || Array.isArray(notification)) {
      warn?.("settings.json 的 notifications 无效，已忽略");
    } else {
      const fields = notification as Record<string, unknown>;
      for (const key of ["enabled", "doneAfterSeconds", "sound"] as const) {
        if (!Object.hasOwn(fields, key)) continue;
        try {
          const parsed = parseConfigFile(
            { notifications: { [key]: fields[key] } },
            "settings.json",
          );
          result.notifications = { ...result.notifications, ...parsed.notifications };
        } catch {
          warn?.(`settings.json 的 notifications.${key} 无效，已忽略`);
        }
      }
      if (Object.hasOwn(fields, "events")) {
        const events = fields.events;
        if (typeof events !== "object" || events === null || Array.isArray(events)) {
          warn?.("settings.json 的 notifications.events 无效，已忽略");
        } else {
          const eventFields = events as Record<string, unknown>;
          for (const key of ["attention", "error", "done"] as const) {
            if (!Object.hasOwn(eventFields, key)) continue;
            try {
              const parsed = parseConfigFile(
                { notifications: { events: { [key]: eventFields[key] } } },
                "settings.json",
              );
              result.notifications = {
                ...result.notifications,
                events: { ...result.notifications?.events, ...parsed.notifications?.events },
              };
            } catch {
              warn?.(`settings.json 的 notifications.events.${key} 无效，已忽略`);
            }
          }
        }
      }
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
    const operation = pending.then(() =>
      enqueueConfigWrite(fs, async () => {
        const next = { ...data };
        update(next);
        await writeJsonAtomic(fs, platform.paths, settingsPath, next);
        data = next;
      }),
    );
    pending = operation.catch(() => undefined);
    return operation;
  }

  return {
    warning,
    store: {
      disabledSkills: () => {
        const value = (data.skills as { disabled?: unknown } | undefined)?.disabled;
        return Array.isArray(value)
          ? value.filter((name): name is string => typeof name === "string")
          : [];
      },
      async setSkillEnabled(name, enabled) {
        if (typeof name !== "string" || !name.trim() || typeof enabled !== "boolean")
          throw new TypeError("无效的技能开关");
        await write((next) => {
          const skills =
            typeof next.skills === "object" && next.skills !== null && !Array.isArray(next.skills)
              ? { ...(next.skills as Record<string, unknown>) }
              : {};
          const disabled = Array.isArray(skills.disabled)
            ? skills.disabled.filter(
                (item): item is string =>
                  typeof item === "string" && item.toLowerCase() !== name.toLowerCase(),
              )
            : [];
          if (!enabled) disabled.push(name);
          next.skills = { ...skills, disabled };
        });
      },
      disabledProviders: () => stringList(data.disabledProviders),
      disabledModels: () => stringList(data.disabledModels),
      async setProviderEnabled(provider, enabled) {
        if (typeof provider !== "string" || !provider.trim() || typeof enabled !== "boolean")
          throw new TypeError("无效的服务商开关");
        const id = provider.trim();
        await write((next) => {
          const kept = stringList(next.disabledProviders).filter((item) => item !== id);
          next.disabledProviders = enabled ? kept : [...kept, id];
        });
      },
      async setModelsEnabled(provider, models, enabled) {
        const list: unknown = models;
        if (
          typeof provider !== "string" ||
          !provider.trim() ||
          !Array.isArray(list) ||
          list.some((model: unknown) => typeof model !== "string" || model.trim() === "") ||
          typeof enabled !== "boolean"
        )
          throw new TypeError("无效的模型开关");
        const keys = new Set(
          (list as string[]).map((model) => `${provider.trim()}/${model.trim()}`),
        );
        await write((next) => {
          const kept = stringList(next.disabledModels).filter((item) => !keys.has(item));
          next.disabledModels = enabled ? kept : [...kept, ...keys];
        });
      },
      async clearProviderToggles(provider) {
        const id = provider.trim();
        const prefix = `${id}/`;
        await write((next) => {
          next.disabledProviders = stringList(next.disabledProviders).filter((item) => item !== id);
          next.disabledModels = stringList(next.disabledModels).filter(
            (item) => !item.startsWith(prefix),
          );
        });
      },
      fields: () => configFields(data),
      async update(patch) {
        validateSettingsPatch(patch);
        const preset = patch["permissions.preset"];
        await write((next) => {
          const roles = { ...(next.modelRoles as Record<string, unknown> | undefined) };
          for (const role of MODEL_ROLES) {
            const ref = patch[`modelRoles.${role}`];
            if (ref === undefined) continue;
            if (ref === null) Reflect.deleteProperty(roles, role);
            else roles[role] = ref;
            next.modelRoles = roles;
          }
          const threshold = patch["compaction.threshold"];
          if (threshold !== undefined) {
            const compaction =
              typeof next.compaction === "object" &&
              next.compaction !== null &&
              !Array.isArray(next.compaction)
                ? { ...(next.compaction as Record<string, unknown>) }
                : {};
            if (threshold === null) delete compaction.threshold;
            else compaction.threshold = threshold;
            next.compaction = compaction;
          }
          const reviewer = patch["permission.reviewer"];
          if (reviewer !== undefined) {
            const permission =
              typeof next.permission === "object" &&
              next.permission !== null &&
              !Array.isArray(next.permission)
                ? { ...(next.permission as Record<string, unknown>) }
                : {};
            if (reviewer === null) delete permission.reviewer;
            else permission.reviewer = reviewer;
            next.permission = permission;
          }
          const reviewerRules = patch["permission.reviewerRules"];
          if (reviewerRules !== undefined) {
            const permission =
              typeof next.permission === "object" &&
              next.permission !== null &&
              !Array.isArray(next.permission)
                ? { ...(next.permission as Record<string, unknown>) }
                : {};
            // 整段替换；空串视为删除该段，两段都空则删除 reviewerRules
            const rules: Record<string, string> = {};
            for (const field of ["ask", "allow"] as const) {
              const text = reviewerRules?.[field];
              if (text !== undefined && text.trim() !== "") rules[field] = text;
            }
            if (Object.keys(rules).length === 0) delete permission.reviewerRules;
            else permission.reviewerRules = rules;
            if (Object.keys(permission).length > 0) next.permission = permission;
            else delete next.permission;
          }
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
          const notifyEnabled = patch["notifications.enabled"];
          const notifyAttention = patch["notifications.events.attention"];
          const notifyError = patch["notifications.events.error"];
          const notifyDone = patch["notifications.events.done"];
          const notifyAfter = patch["notifications.doneAfterSeconds"];
          const notifySound = patch["notifications.sound"];
          if (
            notifyEnabled !== undefined ||
            notifyAttention !== undefined ||
            notifyError !== undefined ||
            notifyDone !== undefined ||
            notifyAfter !== undefined ||
            notifySound !== undefined
          ) {
            const raw = next.notifications;
            const notifications: Record<string, unknown> =
              typeof raw === "object" && raw !== null && !Array.isArray(raw)
                ? { ...(raw as Record<string, unknown>) }
                : {};
            const rawEvents = notifications.events;
            const events: Record<string, unknown> =
              typeof rawEvents === "object" && rawEvents !== null && !Array.isArray(rawEvents)
                ? { ...(rawEvents as Record<string, unknown>) }
                : {};
            if (notifyEnabled === null) delete notifications.enabled;
            else if (notifyEnabled !== undefined) notifications.enabled = notifyEnabled;
            if (notifyAttention === null) delete events.attention;
            else if (notifyAttention !== undefined) events.attention = notifyAttention;
            if (notifyError === null) delete events.error;
            else if (notifyError !== undefined) events.error = notifyError;
            if (notifyDone === null) delete events.done;
            else if (notifyDone !== undefined) events.done = notifyDone;
            if (Object.keys(events).length > 0) notifications.events = events;
            else delete notifications.events;
            if (notifyAfter === null) delete notifications.doneAfterSeconds;
            else if (notifyAfter !== undefined) notifications.doneAfterSeconds = notifyAfter;
            if (notifySound === null) delete notifications.sound;
            else if (notifySound !== undefined) notifications.sound = notifySound;
            if (Object.keys(notifications).length > 0) next.notifications = notifications;
            else delete next.notifications;
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
