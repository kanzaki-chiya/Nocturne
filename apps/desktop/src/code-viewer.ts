/**
 * 「文件」标签的只读代码查看器（ADR-0060 第 3 节）：CodeMirror 6，行号、语法高亮、
 * 定位并高亮指定行、Ctrl+F 搜索。整个模块经动态 import 按需加载，语言包再按扩展名
 * 各自按需加载；选择理由与体积见 docs/apps/desktop.md「右侧面板」。
 */
import { Compartment, EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { codeHighlighter } from "./code-tags";
import "./code-colors.css";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";

import { languageFor } from "./code-language";

export { languageFor } from "./code-language";

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
  /** 切换自动换行：只重配这一项，不重建编辑器（滚动、选区、搜索面板保持） */
  setWrap(wrap: boolean): void;
  destroy(): void;
}

export async function mountCodeViewer(
  parent: HTMLElement,
  options: {
    text: string;
    path: string;
    line?: number | undefined;
    endLine?: number | undefined;
    /** 缺省换行（手机侧栏不传，始终换行） */
    wrap?: boolean | undefined;
  },
): Promise<CodeViewer> {
  const language = await languageFor(options.path)?.().catch(() => undefined);
  const wrapping = new Compartment();
  const targets = new Compartment();
  let wrap = options.wrap !== false;
  const base: Extension[] = [
    lineNumbers(),
    wrapping.of(wrap ? EditorView.lineWrapping : []),
    targets.of([]),
    drawSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of(searchKeymap),
    syntaxHighlighting(codeHighlighter),
    EditorState.readOnly.of(true),
    EditorState.phrases.of(PHRASES),
    theme,
    ...(language !== undefined ? [language] : []),
  ];
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: options.text, extensions: base }),
  });
  const viewer: CodeViewer = {
    reveal(line, endLine) {
      const marks = line === undefined ? [] : targetLines(view.state, line, endLine ?? line);
      if (line === undefined) {
        view.dispatch({ effects: targets.reconfigure(marks) });
        return;
      }
      const target = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
      view.dispatch({
        selection: { anchor: target.from },
        effects: [
          targets.reconfigure(marks),
          EditorView.scrollIntoView(target.from, { y: "center" }),
        ],
      });
    },
    setWrap(next) {
      if (next === wrap) return;
      wrap = next;
      // 换行前后同一行的位置会变：记下视口顶端那一行，重排后滚回去
      const top = view.lineBlockAtHeight(
        view.scrollDOM.getBoundingClientRect().top - view.documentTop,
      );
      view.dispatch({
        effects: [
          wrapping.reconfigure(next ? EditorView.lineWrapping : []),
          EditorView.scrollIntoView(top.from, { y: "start" }),
        ],
      });
    },
    destroy() {
      view.destroy();
    },
  };
  viewer.reveal(options.line, options.endLine);
  return viewer;
}
