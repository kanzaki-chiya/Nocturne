import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

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
