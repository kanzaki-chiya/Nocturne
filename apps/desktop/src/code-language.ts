import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

const LANGUAGE_ALIASES: Record<string, string> = {
  py: "python",
  python3: "python",
  pyw: "python",
  rs: "rust",
  kt: "kotlin",
  kts: "kotlin",
  md: "markdown",
  mkd: "markdown",
  ps1: "powershell",
  pwsh: "powershell",
  jsonc: "json",
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  cts: "typescript",
  htm: "html",
  svg: "xml",
  golang: "go",
  hs: "haskell",
  fs: "fsharp",
  jl: "julia",
  clj: "clojure",
  cljs: "clojurescript",
  erl: "erlang",
  ml: "ocaml",
  docker: "dockerfile",
};

/** 保留此前支持的 JSONC 扩展名；解析器由上游语言目录按需提供。 */
export function languageDescription(path: string): LanguageDescription | undefined {
  const filename = path.replaceAll("\\", "/").split("/").pop() ?? path;
  return (
    LanguageDescription.matchFilename(languages, filename.replace(/\.jsonc$/i, ".json")) ??
    undefined
  );
}

export function languageFor(path: string) {
  const description = languageDescription(path);
  return description === undefined ? undefined : () => description.load();
}

/** 按 Markdown 围栏语言标记从同一份语言目录精确匹配（禁用模糊匹配以免 text 误命中 LaTeX）。 */
export function languageDescriptionForName(lang: string): LanguageDescription | undefined {
  const token = lang.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (token === "") return undefined;
  const resolved = LANGUAGE_ALIASES[token] ?? token;
  return LanguageDescription.matchLanguageName(languages, resolved, false) ?? undefined;
}

export function languageForName(lang: string) {
  const description = languageDescriptionForName(lang);
  return description === undefined ? undefined : () => description.load();
}
