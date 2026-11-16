/**
 * 外观自定义主题（全局 settings.json `appearance.customThemes`）。
 * 纯协议类型与校验函数：Core 与客户端共用同一份字段、ID、颜色与码点上限规则。
 */
export interface CustomTheme {
  id: string;
  name: string;
  bg: string;
  text: string;
  accent: string;
}

/** 自定义主题 ID：仅允许 `custom-` 后接小写字母或数字 */
export const CUSTOM_THEME_ID_RE = /^custom-[a-z0-9]+$(?![\s\S])/;
/** 颜色值：严格小写 `#rrggbb` 十六进制 */
export const CUSTOM_THEME_HEX_RE = /^#[0-9a-f]{6}$(?![\s\S])/;
/** 名称在 trim 后允许的最大 Unicode 码点数 */
export const CUSTOM_THEME_NAME_MAX_CODE_POINTS = 24;

const CUSTOM_THEME_FIELDS = ["id", "name", "bg", "text", "accent"] as const;
const CUSTOM_THEME_FIELD_SET = new Set<string>(CUSTOM_THEME_FIELDS);
const CUSTOM_THEME_COLOR_FIELDS = ["bg", "text", "accent"] as const;

export type CustomThemesValidationResult =
  { ok: true; themes: CustomTheme[] } | { ok: false; reason: string };

/**
 * 整组原子校验并规范化 `appearance.customThemes`（保存时将 `name` trim 后写入）。
 * 任一项不合法即整组失败并返回原因。
 */
export function validateCustomThemes(input: unknown): CustomThemesValidationResult {
  if (!Array.isArray(input)) {
    return { ok: false, reason: "appearance.customThemes 必须是数组" };
  }
  const seenIds = new Set<string>();
  const themes: CustomTheme[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const raw: unknown = input[i];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, reason: `appearance.customThemes[${i}] 必须是对象` };
    }
    const record = raw as Record<string, unknown>;
    const extraKeys = Object.keys(record).filter((key) => !CUSTOM_THEME_FIELD_SET.has(key));
    if (extraKeys.length > 0) {
      return {
        ok: false,
        reason: `appearance.customThemes[${i}] 包含多余字段：${extraKeys.join("、")}`,
      };
    }
    for (const field of CUSTOM_THEME_FIELDS) {
      if (!Object.hasOwn(record, field) || record[field] === undefined) {
        return { ok: false, reason: `appearance.customThemes[${i}] 缺少字段 ${field}` };
      }
      if (typeof record[field] !== "string") {
        return { ok: false, reason: `appearance.customThemes[${i}].${field} 必须是字符串` };
      }
    }
    const id = record.id as string;
    if (!CUSTOM_THEME_ID_RE.test(id)) {
      return {
        ok: false,
        reason: `appearance.customThemes[${i}].id 格式无效（须匹配 ^custom-[a-z0-9]+$）`,
      };
    }
    if (seenIds.has(id)) {
      return { ok: false, reason: `appearance.customThemes[${i}].id 重复：${id}` };
    }
    seenIds.add(id);

    const name = (record.name as string).trim();
    if (name.length === 0) {
      return { ok: false, reason: `appearance.customThemes[${i}].name 不能为空` };
    }
    if (Array.from(name).length > CUSTOM_THEME_NAME_MAX_CODE_POINTS) {
      return {
        ok: false,
        reason: `appearance.customThemes[${i}].name 最多 ${CUSTOM_THEME_NAME_MAX_CODE_POINTS} 个 Unicode 码点`,
      };
    }

    for (const colorField of CUSTOM_THEME_COLOR_FIELDS) {
      const color = record[colorField] as string;
      if (!CUSTOM_THEME_HEX_RE.test(color)) {
        return {
          ok: false,
          reason: `appearance.customThemes[${i}].${colorField} 必须是严格小写 #rrggbb 颜色值`,
        };
      }
    }

    themes.push({
      id,
      name,
      bg: record.bg as string,
      text: record.text as string,
      accent: record.accent as string,
    });
  }
  return { ok: true, themes };
}
