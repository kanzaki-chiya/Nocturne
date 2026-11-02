/**
 * 设置 › 外观 › 预览：用对话区的真实组件与类名（.conversation、.u-bubble、Markdown、
 * ToolLine、DiffCounts）渲染一小段固定对话，对话区样式改了这里跟着变，不另写一份样式。
 * 整块 inert：只看不点。
 */
import type { ReactNode } from "react";

import { DiffCounts, Markdown, pathParts, toolMeta, ToolLine } from "./Conversation";

const USER = "把 Markdown 转换器的嵌套列表修好，再跑一遍 unittest";
const ANSWER =
  "修好了。问题出在 `parse_list()` 没有记录缩进层级，第 2 层以后的条目都被当成了同一级。全部 42 项测试通过。";
const CODE = [
  "```python",
  "def parse_list(lines, indent=0):",
  "    # 按缩进拆出下一层列表",
  '    items = [line for line in lines if line.startswith("- ")]',
  "    return items",
  "```",
].join("\n");
/** 18 行新增、6 行删除，行尾计数经 DiffCounts 算出 +18 −6 */
const PATCH = `@@ -1,6 +1,18 @@\n${"+\n".repeat(18)}${"-\n".repeat(6)}`;

const noop = () => undefined;
const openUrl = () => undefined;

function PreviewTool({
  tool,
  arg,
  status,
}: {
  tool: string;
  arg: ReturnType<typeof pathParts>;
  status: ReactNode;
}) {
  return (
    <article className="tool">
      <details className="tool-details">
        <ToolLine
          open={false}
          disabled={false}
          label={toolMeta(tool).label}
          arg={arg}
          status={status}
          onToggle={noop}
        />
      </details>
    </article>
  );
}

export function AppearancePreview() {
  return (
    <div className="conversation appearance-preview" inert data-testid="appearance-preview">
      <div className="conversation-transcript">
        <div className="u">
          <div className="u-body">
            <div className="u-bubble">
              <div className="u-text">{USER}</div>
            </div>
          </div>
        </div>
        <article className="a">
          <Markdown text={ANSWER} openUrl={openUrl} />
        </article>
        <div className="appearance-preview-tools">
          <PreviewTool
            tool="apply_patch"
            arg={pathParts("src/parser/md2html.py")}
            status={<DiffCounts diff={PATCH} />}
          />
          <PreviewTool
            tool="read"
            arg={pathParts("tests/test_lists.py")}
            status={<span className="tool-res">64 行</span>}
          />
          <PreviewTool
            tool="shell"
            arg={{ name: "python -m unittest", dir: "", title: "python -m unittest" }}
            status={<span className="tool-res">完成</span>}
          />
        </div>
        <article className="a">
          <Markdown text={CODE} openUrl={openUrl} />
        </article>
      </div>
    </div>
  );
}
