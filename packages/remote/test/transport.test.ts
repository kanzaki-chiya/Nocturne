import { describe, expect, it } from "vitest";
import { createMemoryFramePair } from "../src/index.js";
import { until } from "./helpers.js";

describe("内存帧管道", () => {
  it("异步按序交付、复制帧、迟注册缓冲，关闭先交付再通知且幂等", async () => {
    const [a, b] = createMemoryFramePair();
    const first = new Uint8Array([1]);
    const events: string[] = [];
    a.send(first);
    first[0] = 9;
    a.send(new Uint8Array([2]));
    a.close();
    a.close();
    b.onClose(() => events.push("close"));
    expect(events).toEqual([]);
    b.onFrame((frame) => events.push(String(frame[0])));
    expect(events).toEqual([]);
    await until(() => events.length === 3);
    expect(events).toEqual(["1", "2", "close"]);
    a.send(new Uint8Array([3]));
    b.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["1", "2", "close"]);
  });
});
