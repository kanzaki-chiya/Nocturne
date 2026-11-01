import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import { afterEach, expect, it } from "vitest";

if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
      onchange: null,
    }) as MediaQueryList;
}

const SAMPLE = "😀A\r\n中\r\ne\u0301X";

function lineWidths(term: Terminal, row: number, cols: number): number[] {
  const line = term.buffer.active.getLine(row);
  if (line === undefined) throw new Error(`missing line ${row}`);
  const widths: number[] = [];
  for (let i = 0; i < cols; i++) widths.push(line.getCell(i)?.getWidth() ?? -1);
  return widths;
}

async function measure(unicode11: boolean): Promise<number[][]> {
  const term = new Terminal({ allowProposedApi: true, cols: 8, rows: 4, fontSize: 16 });
  if (unicode11) {
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  term.open(host);
  await new Promise<void>((resolve) => {
    term.write(SAMPLE, () => resolve());
  });
  const rows = [0, 1, 2].map((row) => lineWidths(term, row, 4));
  term.dispose();
  host.remove();
  return rows;
}

afterEach(() => {
  document.body.replaceChildren();
});

it("默认 Unicode 6 把 emoji 和组合字符算窄，Unicode 11 把它们算对", async () => {
  const before = await measure(false);
  const after = await measure(true);
  // 😀 在 Unicode 6 是 1 列，A 紧挨着；Unicode 11 是 2 列，A 在第三格
  expect(before[0]?.slice(0, 2)).toEqual([1, 1]);
  expect(after[0]?.slice(0, 3)).toEqual([2, 0, 1]);
  expect(before[1]?.slice(0, 2)).toEqual([2, 0]);
  expect(after[1]?.slice(0, 2)).toEqual([2, 0]);
  expect(before[2]?.slice(0, 3)).toEqual([1, 1, 1]);
  expect(after[2]?.slice(0, 2)).toEqual([1, 1]);
});
