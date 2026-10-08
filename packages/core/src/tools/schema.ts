/**
 * JSON Schema 编译（tools.md 第 3 节第 2 步）。按根 `$schema` 选方言：
 * 2020-12 与 2019-09 用对应的 Ajv 类，其余按 draft-07。
 * 未识别的 `$schema`（draft-04/06 等）去掉该字段后按 draft-07 编译，
 * 不因元 schema 未注册而失败。
 */
import { Ajv, type ErrorObject, type Options, type ValidateFunction } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";

type Dialect = "draft-07" | "2019-09" | "2020-12";

export interface SchemaCompiler {
  /** 编译失败（schema 本身不合法、`$ref` 无法解析等）时抛出 */
  compile(schema: object): ValidateFunction;
  errorsText(errors: ErrorObject[] | null | undefined): string;
}

function dialectOf(schema: object): { dialect: Dialect; known: boolean } {
  const uri = (schema as { $schema?: unknown }).$schema;
  if (typeof uri !== "string") return { dialect: "draft-07", known: true };
  if (uri.includes("draft/2020-12")) return { dialect: "2020-12", known: true };
  if (uri.includes("draft/2019-09")) return { dialect: "2019-09", known: true };
  return { dialect: "draft-07", known: uri.includes("draft-07") };
}

export function createSchemaCompiler(options: Options): SchemaCompiler {
  const instances = new Map<Dialect, Ajv>();
  const instance = (dialect: Dialect): Ajv => {
    let ajv = instances.get(dialect);
    if (ajv === undefined) {
      ajv =
        dialect === "2020-12"
          ? new Ajv2020(options)
          : dialect === "2019-09"
            ? new Ajv2019(options)
            : new Ajv(options);
      instances.set(dialect, ajv);
    }
    return ajv;
  };
  return {
    compile(schema) {
      const { dialect, known } = dialectOf(schema);
      if (known) return instance(dialect).compile(schema);
      const { $schema: _unknown, ...rest } = schema as { $schema?: unknown };
      return instance(dialect).compile(rest);
    },
    errorsText(errors) {
      return instance("draft-07").errorsText(errors, { separator: "; " });
    },
  };
}
