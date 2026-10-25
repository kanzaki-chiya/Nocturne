/**
 * 五段 cron 表达式（本地时区）：`分 时 日 月 周`。
 * 自己实现的最小子集，不引入依赖（理由见 ADR-0064 实现记录）：
 * - 每段支持 `*`、数字、范围 `a-b`、步长（`*` 或范围或起点后接 `/n`）、逗号列表；
 * - 月份、星期支持三字母英文缩写（`JAN`、`MON`），星期 0 和 7 都是周日；
 * - 日与星期都不是 `*` 时，满足其一即可（标准 cron 行为），否则两者都要满足；
 * - 不支持 `@daily` 之类的别名，也不支持 `?`、`L`、`W`、`#`、秒字段。
 */

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

export interface CronSpec {
  minutes: readonly number[];
  hours: readonly number[];
  /** 日期字段是否以 `*` 开头（决定与星期的 AND/OR 语义） */
  domStar: boolean;
  dayOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  dowStar: boolean;
  /** 0–6，0 = 周日 */
  dayOfWeek: ReadonlySet<number>;
}

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface FieldDef {
  label: string;
  min: number;
  max: number;
  names?: readonly string[] | undefined;
  /** names 数组下标 0 对应的数值 */
  nameBase?: number | undefined;
}

const MINUTE_FIELD: FieldDef = { label: "分钟", min: 0, max: 59 };
const HOUR_FIELD: FieldDef = { label: "小时", min: 0, max: 23 };
const DOM_FIELD: FieldDef = { label: "日", min: 1, max: 31 };
const MONTH_FIELD: FieldDef = { label: "月", min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 };
const DOW_FIELD: FieldDef = { label: "星期", min: 0, max: 7, names: DAY_NAMES, nameBase: 0 };

function parseValue(text: string, def: FieldDef): number {
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (n < def.min || n > def.max)
      throw new CronError(`${def.label}字段的值 ${text} 超出范围 ${def.min}–${def.max}`);
    return n;
  }
  const index = def.names?.indexOf(text.toLowerCase()) ?? -1;
  if (index < 0) throw new CronError(`${def.label}字段里的 “${text}” 无法识别`);
  return index + (def.nameBase ?? 0);
}

function parseField(text: string, def: FieldDef): Set<number> {
  const values = new Set<number>();
  for (const item of text.split(",")) {
    if (item === "") throw new CronError(`${def.label}字段里有空的列表项`);
    const [range, stepText, ...rest] = item.split("/");
    if (rest.length > 0 || range === undefined || range === "")
      throw new CronError(`${def.label}字段 “${item}” 格式不对`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1)
        throw new CronError(`${def.label}字段的步长 “${stepText}” 必须是正整数`);
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (range === "*") {
      from = def.min;
      to = def.max;
    } else if (range.includes("-")) {
      const [a, b, ...more] = range.split("-");
      if (more.length > 0 || a === undefined || b === undefined || a === "" || b === "")
        throw new CronError(`${def.label}字段 “${item}” 格式不对`);
      from = parseValue(a, def);
      to = parseValue(b, def);
      if (from > to) throw new CronError(`${def.label}字段的范围 “${range}” 起点大于终点`);
    } else {
      from = parseValue(range, def);
      to = stepText !== undefined ? def.max : from;
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

/** 解析并校验；不合法时抛 `CronError`，信息可以直接给用户看 */
export function parseCron(expr: string): CronSpec {
  const [minText, hourText, domText, monthText, dowText, ...extra] = expr.trim().split(/\s+/);
  if (
    minText === undefined ||
    hourText === undefined ||
    domText === undefined ||
    monthText === undefined ||
    dowText === undefined ||
    extra.length > 0
  )
    throw new CronError("cron 必须是五段：分 时 日 月 周，例如 0 9 * * 1-5");
  const rawDow = parseField(dowText, DOW_FIELD);
  return {
    minutes: [...parseField(minText, MINUTE_FIELD)].sort((a, b) => a - b),
    hours: [...parseField(hourText, HOUR_FIELD)].sort((a, b) => a - b),
    domStar: domText.startsWith("*"),
    dayOfMonth: parseField(domText, DOM_FIELD),
    months: parseField(monthText, MONTH_FIELD),
    dowStar: dowText.startsWith("*"),
    dayOfWeek: new Set([...rawDow].map((d) => d % 7)),
  };
}

/** 某个本地日期是否满足日/月/星期三段 */
export function cronMatchesDate(
  spec: CronSpec,
  date: { month: number; day: number },
  weekday: number,
): boolean {
  if (!spec.months.has(date.month)) return false;
  const domMatch = spec.dayOfMonth.has(date.day);
  const dowMatch = spec.dayOfWeek.has(weekday);
  return spec.domStar || spec.dowStar ? domMatch && dowMatch : domMatch || dowMatch;
}
