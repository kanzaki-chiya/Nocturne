import { describe, expect, it } from "vitest";

import { abbreviateHome, displayPath, middleTruncate } from "../src/paths";
import { formatDuration } from "../src/Conversation";

describe("displayPath", () => {
  const cwd = "Z:\\proj";

  it("工作区内路径相对化（分隔符与大小写归一）", () => {
    expect(displayPath("Z:/proj/src/a.ts", cwd)).toBe("src/a.ts");
    expect(displayPath("z:\\proj\\src\\a.ts", cwd)).toBe("src/a.ts");
    expect(displayPath("Z:/proj/a.ts", cwd)).toBe("a.ts");
  });

  it("工作区外保持绝对路径", () => {
    expect(displayPath("Z:/other/x.ts", cwd)).toBe("Z:/other/x.ts");
    expect(displayPath("Z:/project2/a.ts", cwd)).toBe("Z:/project2/a.ts"); // 前缀不是目录边界
  });

  it("相对输入归一化（./ 与 \\ → /）", () => {
    expect(displayPath("./src/a.ts", cwd)).toBe("src/a.ts");
    expect(displayPath("src\\a.ts", cwd)).toBe("src/a.ts");
    expect(displayPath("src/a.ts", cwd)).toBe("src/a.ts");
  });
});

describe("abbreviateHome / middleTruncate", () => {
  it("主目录缩写为 ~，其他路径不动", () => {
    expect(abbreviateHome("C:\\Users\\me\\proj", "C:/Users/me")).toBe("~\\proj");
    expect(abbreviateHome("C:/Users/me", "C:/Users/me")).toBe("~");
    expect(abbreviateHome("C:/Other/x", "C:/Users/me")).toBe("C:/Other/x");
    expect(abbreviateHome("C:/Users/me", null)).toBe("C:/Users/me");
  });

  it("超长文本保留首尾、中间省略", () => {
    expect(middleTruncate("short", 10)).toBe("short");
    expect(middleTruncate("a".repeat(60), 10)).toBe(`${"a".repeat(5)}…${"a".repeat(4)}`);
    const long = "Z:/very/long/workspace/path/" + "x".repeat(60);
    const out = middleTruncate(long, 56);
    expect(out.length).toBe(56);
    expect(out.startsWith("Z:/very")).toBe(true);
    expect(out.endsWith("xxx")).toBe(true);
    expect(out).toContain("…");
  });
});

describe("formatDuration", () => {
  it("10 秒以下不显示；秒与分钟格式", () => {
    expect(formatDuration(500)).toBeUndefined();
    expect(formatDuration(9_999)).toBeUndefined();
    expect(formatDuration(10_000)).toBe("10 秒");
    expect(formatDuration(59_500)).toBe("1 分");
    expect(formatDuration(105_000)).toBe("1 分 45 秒");
    expect(formatDuration(3_600_000)).toBe("60 分");
  });
});
