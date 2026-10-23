/**
 * 「文件」标签的只读代码查看器（ADR-0060 第 3 节）：CodeMirror 6，行号、语法高亮、
 * 定位并高亮指定行、Ctrl+F 搜索。整个模块经动态 import 按需加载，语言包再按扩展名
 * 各自按需加载；选择理由与体积见 docs/apps/desktop.md「右侧面板」。
 */
import { EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { tags } from "@lezer/highlight";

type LanguageLoader = () => Promise<LanguageSupport>;

const LANGUAGES: Record<string, LanguageLoader> = {
  js: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  mjs: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  cjs: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  jsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  ts: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
  mts: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
  cts: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
  tsx: () =>
    import("@codemirror/lang-javascript").then((m) =>
      m.javascript({ typescript: true, jsx: true }),
    ),
  css: () => import("@codemirror/lang-css").then((m) => m.css()),
  scss: () => import("@codemirror/lang-css").then((m) => m.css()),
  html: () => import("@codemirror/lang-html").then((m) => m.html()),
  htm: () => import("@codemirror/lang-html").then((m) => m.html()),
  vue: () => import("@codemirror/lang-html").then((m) => m.html()),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  jsonc: () => import("@codemirror/lang-json").then((m) => m.json()),
  md: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  markdown: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  py: () => import("@codemirror/lang-python").then((m) => m.python()),
  rs: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  yaml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  yml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  xml: () => import("@codemirror/lang-xml").then((m) => m.xml()),
  svg: () => import("@codemirror/lang-xml").then((m) => m.xml()),
};

/** 扩展名对应的语言包；未知扩展名按纯文本显示 */
export function languageFor(path: string): LanguageLoader | undefined {
  const ext = /\.([^.\\/]+)$/.exec(path)?.[1]?.toLowerCase();
  return ext === undefined ? undefined : LANGUAGES[ext];
}

// 颜色取主题变量：深浅主题切换不用重建编辑器
const highlight = HighlightStyle.define([
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: "var(--cm-comment)",
    fontStyle: "italic",
  },
  {
    tag: [tags.keyword, tags.modifier, tags.controlKeyword, tags.operatorKeyword],
    color: "var(--cm-keyword)",
  },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--cm-string)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.color], color: "var(--cm-number)" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--cm-function)",
  },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: "var(--cm-type)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--cm-property)" },
  { tag: [tags.heading], color: "var(--cm-keyword)", fontWeight: "600" },
  { tag: [tags.link, tags.url], color: "var(--cm-string)", textDecoration: "underline" },
  { tag: [tags.meta, tags.processingInstruction], color: "var(--cm-comment)" },
  { tag: tags.invalid, color: "var(--a-error)" },
]);

const theme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "var(--fs-2)",
    backgroundColor: "transparent",
    color: "var(--a-text)",
  },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--a-faint)",
    border: "none",
    paddingLeft: "6px",
  },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "32px", paddingRight: "12px" },
  ".cm-activeLine": { backgroundColor: "var(--cm-active-line)" },
  ".cm-target-line": { backgroundColor: "var(--cm-target-line)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--cm-selection) !important",
  },
  ".cm-cursor": { borderLeftColor: "var(--a-text)" },
  ".cm-searchMatch": { backgroundColor: "var(--cm-search)", outline: "none" },
  ".cm-searchMatch-selected": { backgroundColor: "var(--cm-search-current)" },
  ".cm-panels": {
    backgroundColor: "var(--a-panel)",
    color: "var(--a-text)",
    borderColor: "var(--a-border)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--a-border)" },
  ".cm-panel.cm-search": { fontFamily: "inherit", fontSize: "var(--fs-1)", padding: "6px 8px" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": { fontSize: "var(--fs-1)" },
  ".cm-textfield": {
    backgroundColor: "var(--a-bg)",
    border: "1px solid var(--a-border)",
    borderRadius: "5px",
    color: "var(--a-text)",
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--a-raised)",
    border: "1px solid var(--a-border)",
    borderRadius: "5px",
    color: "var(--a-text)",
  },
});

const PHRASES = {
  Find: "查找",
  Replace: "替换",
  next: "下一个",
  previous: "上一个",
  all: "全部",
  "match case": "区分大小写",
  regexp: "正则",
  "by word": "全词",
  close: "关闭",
  "current match": "当前匹配",
  "on line": "第",
  "Go to line": "跳到行",
  go: "跳转",
};

function targetLines(state: EditorState, line: number, endLine: number): Extension {
  const builder = new RangeSetBuilder<Decoration>();
  const mark = Decoration.line({ class: "cm-target-line" });
  const last = Math.min(endLine, state.doc.lines);
  for (let n = Math.max(1, line); n <= last; n++) {
    const at = state.doc.line(n).from;
    builder.add(at, at, mark);
  }
  return EditorView.decorations.of(builder.finish());
}

export interface CodeViewer {
  /** 定位并高亮行范围（1 起，含 endLine）；undefined 清除高亮 */
  reveal(line: number | undefined, endLine?: number): void;
  destroy(): void;
}

export async function mountCodeViewer(
  parent: HTMLElement,
  options: { text: string; path: string; line?: number | undefined; endLine?: number | undefined },
): Promise<CodeViewer> {
  const language = await languageFor(options.path)?.().catch(() => undefined);
  const base: Extension[] = [
    lineNumbers(),
    drawSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of(searchKeymap),
    syntaxHighlighting(highlight),
    EditorState.readOnly.of(true),
    EditorState.phrases.of(PHRASES),
    theme,
    ...(language !== undefined ? [language] : []),
  ];
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: options.text, extensions: base }),
  });
  let decorations: Extension = [];
  const reconfigure = () => {
    view.setState(EditorState.create({ doc: view.state.doc, extensions: [...base, decorations] }));
  };
  const viewer: CodeViewer = {
    reveal(line, endLine) {
      decorations = line === undefined ? [] : targetLines(view.state, line, endLine ?? line);
      reconfigure();
      if (line === undefined) return;
      const target = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
      view.dispatch({
        selection: { anchor: target.from },
        effects: EditorView.scrollIntoView(target.from, { y: "center" }),
      });
    },
    destroy() {
      view.destroy();
    },
  };
  viewer.reveal(options.line, options.endLine);
  return viewer;
}
