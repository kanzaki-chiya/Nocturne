import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RelayConfig } from "./config.js";
import type { DeviceRecord } from "./store.js";

export class PushService {
  publicKey = "";
  privateKey = "";
  constructor(private readonly config: RelayConfig) {}
  async open(): Promise<void> {
    const file = join(this.config.dataDir, "vapid.json");
    try {
      const data = JSON.parse(await readFile(file, "utf8")) as {
        publicKey: string;
        privateKey: string;
      };
      this.publicKey = data.publicKey;
      this.privateKey = data.privateKey;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const jwk = pair.publicKey.export({ format: "jwk" });
      if (!jwk.x || !jwk.y) throw new Error("VAPID 密钥生成失败");
      this.publicKey = Buffer.concat([
        Buffer.from([4]),
        Buffer.from(jwk.x, "base64url"),
        Buffer.from(jwk.y, "base64url"),
      ]).toString("base64url");
      this.privateKey = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
      await writeFile(
        file,
        JSON.stringify({ publicKey: this.publicKey, privateKey: this.privateKey }),
        { mode: 0o600, flag: "wx" },
      );
    }
  }
  allowed(endpoint: string): boolean {
    try {
      const url = new URL(endpoint);
      return (
        !url.username &&
        !url.password &&
        (url.protocol === "https:" ||
          (this.config.allowInsecurePush && url.protocol === "http:")) &&
        this.config.pushHosts.some(
          (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
        )
      );
    } catch {
      return false;
    }
  }
  async send(device: DeviceRecord): Promise<boolean> {
    const sub = device.push;
    if (!sub || !this.allowed(sub.endpoint)) return false;
    const encode = (value: object): string =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const head = encode({ typ: "JWT", alg: "ES256" });
    const claims = encode({
      aud: new URL(sub.endpoint).origin,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: this.config.vapidSubject,
    });
    const input = `${head}.${claims}`;
    const signature = sign("sha256", Buffer.from(input), {
      key: createPrivateKey(this.privateKey),
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    try {
      const response = await fetch(sub.endpoint, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
        headers: {
          "Content-Length": "0",
          TTL: "86400",
          Urgency: "high",
          Authorization: `vapid t=${input}.${signature}, k=${this.publicKey}`,
        },
      });
      await response.body?.cancel();
      if (response.status === 404 || response.status === 410) delete device.push;
    } catch {
      /* 请求失败不暴露 endpoint，由调用方记录 push 事件。 */
    }
    return true;
  }
}
