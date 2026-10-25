// Magpie Agent 插件：把 Nocturne（nctrn）接入 Magpie 网关。
//
// Magpie 只改 `config` 指向的这一个文件，并在断开时把它写过的键还原或删除。
// Nocturne 的其他配置（config.json、providers.json、settings.json、凭据）从不被触碰：
// Nocturne 启动时把这份文件当作只读的「Magpie 接入层」读取（docs/architecture/magpie.md）。
//
// 运行在 Magpie 进程内的 moejs 中：没有 Node API，只能导入插件目录内的文件。

export const agent = {
  id: "nctrn",
  name: "Nocturne",
  bin: "nctrn",
  dir: "~/.nocturne",
  // 与 Nocturne 默认数据目录 <NOCTURNE_HOME> 一致；自定义 NOCTURNE_HOME 见 README
  config: "~/.nocturne/magpie.json",
  format: "json",
  // 默认模型写成 "magpie/<网关返回的完整模型 id>"；id 内的斜杠（provider/model）原样保留，
  // Nocturne 只按第一个斜杠切分服务商与模型
  model: "model",
  prefix: "magpie/",
  // Nocturne 的 User-Agent 以 nocturne/<version> 开头
  ua: ["nocturne"],
  notice:
    "Nocturne reads this when it starts: restart nctrn to use the new model. Nocturne 启动时读取，重启 nctrn 后生效。",
  icon: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231f2340'/%3E%3Cpath d='M40 14a19 19 0 1 0 10 35A16 16 0 0 1 40 14z' fill='%23f2d98c'/%3E%3C/svg%3E",
};

// 网关价格是 USD/token 的十进制字符串；Nocturne 用 USD/百万 token 的数字。
const PRICE_KEYS = {
  prompt: "input",
  completion: "output",
  input_cache_read: "cacheRead",
  input_cache_write: "cacheWrite",
};

function perMillion(text) {
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Number((n * 1e6).toPrecision(10));
}

function pricing(raw) {
  const out = {};
  for (const key of Object.keys(PRICE_KEYS)) {
    const value = raw && raw[key] !== undefined ? perMillion(raw[key]) : undefined;
    if (value !== undefined) out[PRICE_KEYS[key]] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// 未知字段省略，不写 0 或空值（Magpie 约定）：Nocturne 会回落到 models.dev 与默认值。
function describe(m) {
  const out = { id: m.id };
  if (m.name) out.name = m.name;
  if (m.context > 0) out.context = m.context;
  if (m.output > 0) out.output = m.output;
  if (typeof m.images === "boolean") out.images = m.images;
  if (Array.isArray(m.efforts) && m.efforts.length > 0) out.efforts = m.efforts;
  if (Array.isArray(m.native_endpoints) && m.native_endpoints.length > 0) {
    out.endpoints = m.native_endpoints;
  }
  const price = pricing(m.pricing);
  if (price) out.pricing = price;
  return out;
}

export function connect({ gateway, models }) {
  return {
    "magpie.baseURL": gateway.v1,
    // 这是 Magpie 为 Nocturne 签发的本机网关 key，不是任何上游服务商的凭据
    "magpie.key": gateway.key,
    "magpie.models": (models || []).map(describe),
  };
}
