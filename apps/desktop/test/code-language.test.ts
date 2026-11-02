import { describe, expect, it } from "vitest";
import { highlightTree } from "@lezer/highlight";
import { classHighlighter } from "@lezer/highlight";
import { languageDescription, languageFor } from "../src/code-language";

describe("按文件名按需加载语言", () => {
  it.each([
    ["Main.kt", "Kotlin", 'fun main() { println("hello") }'],
    ["build.kts", "Kotlin", 'val name = "hello"'],
    ["Main.java", "Java", "public class Main {}"],
    ["main.go", "Go", "package main\nfunc main() {}"],
    ["main.c", "C", "int main() { return 0; }"],
    ["main.cpp", "C++", "class Main {};"],
    ["Main.cs", "C#", "public class Main {}"],
    ["main.sh", "Shell", 'echo "$HOME"'],
    ["main.ps1", "PowerShell", 'Write-Host "hello"'],
    ["main.sql", "SQL", "SELECT * FROM users;"],
    ["config.toml", "TOML", '[project]\nname = "demo"'],
    ["Dockerfile", "Dockerfile", "FROM node:24\nRUN echo hello"],
    ["a.js", "JavaScript", 'const a = "x";'],
    ["a.mjs", "JavaScript", 'const a = "x";'],
    ["a.cjs", "JavaScript", 'const a = "x";'],
    ["a.ts", "TypeScript", "const a: number = 1;"],
    ["a.mts", "TypeScript", "const a: number = 1;"],
    ["a.cts", "TypeScript", "const a: number = 1;"],
    ["a.tsx", "TSX", 'const a = <div title="hello"/>;'],
    ["a.jsx", "JSX", 'const a = <div title="hello"/>;'],
    ["a.vue", "Vue", '<template><div title="hello"/></template>'],
    ["a.svg", "XML", '<svg width="10"/>'],
    ["a.xml", "XML", '<root value="10"/>'],
    ["a.css", "CSS", "body { color: red; }"],
    ["a.scss", "SCSS", "$color: red; body { color: $color; }"],
    ["a.html", "HTML", '<div title="hello"/>'],
    ["a.htm", "HTML", '<div title="hello"/>'],
    ["a.json", "JSON", '{"name": "hello"}'],
    ["a.jsonc", "JSON", '{"name": "hello"}'],
    ["a.md", "Markdown", "# hello"],
    ["a.markdown", "Markdown", "# hello"],
    ["a.py", "Python", 'print("hello")'],
    ["a.rs", "Rust", "fn main() {}"],
    ["a.yaml", "YAML", "name: hello"],
    ["a.yml", "YAML", "name: hello"],
  ])("%s 使用 %s 且产生高亮", async (filename, name, text) => {
    expect(languageDescription(`C:\\demo\\${filename}`)?.name).toBe(name);
    const support = await languageFor(filename)?.();
    if (support === undefined) throw new Error("expected language support");
    const spans: string[] = [];
    highlightTree(support.language.parser.parse(text), classHighlighter, (_from, _to, cls) => {
      spans.push(cls);
    });
    expect(spans.length).toBeGreaterThan(0);
  });

  it("Makefile 与未知文件如实保持纯文本", () => {
    expect(languageFor("Makefile")).toBeUndefined();
    expect(languageFor("unknown.nocturne")).toBeUndefined();
  });
});
