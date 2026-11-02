import { tagHighlighter, tags } from "@lezer/highlight";

/** 只改变颜色，避免异步着色改变文字度量或换行。查看器与工具输出共用。 */
export const codeHighlighter = tagHighlighter([
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.meta, tags.processingInstruction],
    class: "syntax-comment",
  },
  {
    tag: [tags.keyword, tags.modifier, tags.controlKeyword, tags.operatorKeyword, tags.heading],
    class: "syntax-keyword",
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp, tags.link, tags.url],
    class: "syntax-string",
  },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.color], class: "syntax-number" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    class: "syntax-function",
  },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], class: "syntax-type" },
  { tag: [tags.propertyName, tags.attributeName], class: "syntax-property" },
  { tag: tags.invalid, class: "syntax-invalid" },
]);
