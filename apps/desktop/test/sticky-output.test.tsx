import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useStickyOutput } from "../src/useStickyOutput";

afterEach(cleanup);

function Output({ text }: { text: string }) {
  const ref = useStickyOutput(text);
  return (
    <details open>
      <pre ref={ref} aria-label="输出">
        {text}
      </pre>
    </details>
  );
}

it("在底部追加时跟随，上翻后保留 scrollTop，滚回底部恢复跟随", () => {
  const rendered = render(<Output text="one" />);
  const output = screen.getByLabelText("输出");
  let height = 300;
  Object.defineProperties(output, {
    scrollHeight: { get: () => height },
    clientHeight: { value: 100 },
    scrollTop: { value: 200, writable: true },
  });
  fireEvent.scroll(output);
  height = 400;
  rendered.rerender(<Output text="one\ntwo" />);
  expect(output.scrollTop).toBe(400);
  output.scrollTop = 80;
  fireEvent.scroll(output);
  height = 500;
  rendered.rerender(<Output text="one\ntwo\nthree" />);
  expect(output.scrollTop).toBe(80);
  output.scrollTop = 380;
  fireEvent.scroll(output);
  height = 600;
  rendered.rerender(<Output text="one\ntwo\nthree\nfour" />);
  expect(output.scrollTop).toBe(600);
});

it("重新展开时滚到底部", () => {
  render(<Output text="one" />);
  const output = screen.getByLabelText("输出");
  Object.defineProperties(output, {
    scrollHeight: { value: 300 },
    clientHeight: { value: 100 },
  });
  output.scrollTop = 50;
  fireEvent.scroll(output);
  const details = output.closest("details");
  if (!details) throw new Error("缺少 details");
  fireEvent(details, new Event("toggle"));
  expect(output.scrollTop).toBe(300);
});
