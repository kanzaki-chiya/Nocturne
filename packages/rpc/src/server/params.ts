/** 请求参数的最小形状校验：类型不对一律 invalid_params，不把脏数据交给 Runtime */

export class InvalidParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidParamsError";
  }
}

export type Params = Record<string, unknown>;

/** 参数必须是对象；缺省视为空对象 */
export function asParams(value: unknown): Params {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidParamsError("params 必须是对象");
  }
  return value as Params;
}

export function reqString(p: Params, key: string): string {
  const v = p[key];
  if (typeof v !== "string") throw new InvalidParamsError(`参数 ${key} 必须是字符串`);
  return v;
}

export function optString(p: Params, key: string): string | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new InvalidParamsError(`参数 ${key} 必须是字符串`);
  return v;
}

export function optBool(p: Params, key: string): boolean | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new InvalidParamsError(`参数 ${key} 必须是布尔值`);
  return v;
}

export function reqInt(p: Params, key: string): number {
  const v = p[key];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new InvalidParamsError(`参数 ${key} 必须是整数`);
  }
  return v;
}

export function optInt(p: Params, key: string): number | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  return reqInt(p, key);
}

export function reqObject(p: Params, key: string): Params {
  const v = p[key];
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new InvalidParamsError(`参数 ${key} 必须是对象`);
  }
  return v as Params;
}

/** model 参数：字符串 "provider/model" 或 { provider, model } */
export function reqModel(p: Params, key: string): string | { provider: string; model: string } {
  const v = p[key];
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    const o = v as Params;
    if (typeof o.provider === "string" && typeof o.model === "string") {
      return { provider: o.provider, model: o.model };
    }
  }
  throw new InvalidParamsError(`参数 ${key} 必须是 "provider/model" 字符串或 { provider, model }`);
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** 严格 base64 解码（Buffer 默认会悄悄忽略非法字符） */
export function decodeBase64(value: string, label: string): Uint8Array {
  if (value.length % 4 !== 0 || !BASE64.test(value)) {
    throw new InvalidParamsError(`${label} 不是合法的 base64`);
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}
