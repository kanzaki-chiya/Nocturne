import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPairingOffer, generateIdentity } from "@nocturne/remote";
import { expect, it } from "vitest";
import { qrModules } from "../src/RemotePage";

it("原生 ZXing 容量夹具与桌面 qrModules 输出一致（每格 6px）", async () => {
  const fixture = readFileSync(
    resolve(
      import.meta.dirname,
      "../../android/src-tauri/gen/android/app/src/test/resources/pairing-qr.txt",
    ),
    "utf8",
  )
    .trim()
    .split("\n");
  const url = fixture.shift() ?? "";
  const identity = await generateIdentity({ extractable: true });
  const offer = await createPairingOffer(identity, "AAAAAAAAAAAAAAAAAAAAAA");
  expect(url.length).toBe(`https://relay.example/#${offer.fragment}`.length);
  const qr = qrModules(url);
  expect(fixture).toHaveLength(qr.size);
  const pixels = Array.from({ length: qr.size }, () => Array<string>(qr.size).fill("0"));
  for (const match of qr.path.matchAll(/M(\d+),(\d+)h1v1h-1z/g)) {
    const row = pixels[Number(match[2])];
    if (!row) throw new Error("QR coordinate outside matrix");
    row[Number(match[1])] = "1";
  }
  expect(pixels.map((row) => row.join(""))).toEqual(fixture);
  expect(url).toMatch(
    /^https:\/\/relay.example\/#pair=[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/,
  );
});
