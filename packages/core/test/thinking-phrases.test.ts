import { expect, it } from "vitest";
import {
  THINKING_PHRASES,
  THINKING_PHRASE_INTERVAL_MS,
  thinkingPhrase,
} from "../src/protocol/index.js";

it("开头与 startedMs 未定义时返回第 1 条「思考中」", () => {
  expect(THINKING_PHRASES[0]).toBe("思考中");
  expect(THINKING_PHRASES).toHaveLength(12);
  expect(thinkingPhrase(undefined, 0)).toBe("思考中");
  expect(thinkingPhrase(undefined, 99_999)).toBe("思考中");
  expect(thinkingPhrase(1000, 1000)).toBe("思考中");
  expect(thinkingPhrase(1000, 1000 + THINKING_PHRASE_INTERVAL_MS - 1)).toBe("思考中");
  expect(thinkingPhrase(5000, 3000)).toBe("思考中");
});

it("按间隔依次轮换，循环时跳过第 1 条", () => {
  const started = 10_000;
  for (let i = 1; i < THINKING_PHRASES.length; i += 1) {
    expect(thinkingPhrase(started, started + i * THINKING_PHRASE_INTERVAL_MS)).toBe(
      THINKING_PHRASES[i],
    );
  }
  const wrappedStep = THINKING_PHRASES.length;
  expect(thinkingPhrase(started, started + wrappedStep * THINKING_PHRASE_INTERVAL_MS)).toBe(
    THINKING_PHRASES[1],
  );
  expect(thinkingPhrase(started, started + (wrappedStep + 1) * THINKING_PHRASE_INTERVAL_MS)).toBe(
    THINKING_PHRASES[2],
  );
});
