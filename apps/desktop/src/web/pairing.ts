import {
  connectPairRelay,
  createPairingHello,
  finishPairing,
  parsePairingFragment,
  RemoteChannelError,
  type ParsedOffer,
} from "@nocturne/remote";
import { encode, type PairedHost, type PhoneStorage } from "./storage";

export function takePairingFragment(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState">,
): string {
  const fragment = location.hash;
  if (fragment) history.replaceState(null, "", location.pathname + location.search);
  return fragment;
}
export function parsePairingLink(text: string, origin: string): ParsedOffer {
  const input = text.trim();
  if (/^#?pair=/.test(input)) return parsePairingFragment(input);
  const url = new URL(input);
  if (url.origin !== origin) throw new Error("请在配对链接对应的中继网页上打开链接");
  return parsePairingFragment(url.hash);
}
/**
 * App：配对链接必须带中继地址（页面源是 App 自己的固定源，不是中继）。
 * 中继地址只接受 https，或本机开发用的 http://127.0.0.1，与 remote 客户端的限制一致。
 */
export function parsePairingTarget(text: string): { offer: ParsedOffer; origin: string } {
  const input = text.trim();
  if (/^#?pair=/.test(input))
    throw new Error("请粘贴完整的配对链接（含中继地址），不要只粘贴 pair= 部分");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("配对链接格式不对");
  }
  const local = url.protocol === "http:" && url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !local) throw new Error("中继地址必须是 https");
  return { offer: parsePairingFragment(url.hash), origin: url.origin };
}
export function pairingError(error: unknown): string {
  const code = error instanceof RemoteChannelError ? error.code : "";
  const messages: Record<string, string> = {
    fingerprint_mismatch: "电脑指纹不匹配，已停止配对",
    bad_mac: "配对密钥校验失败，已停止配对",
    bad_signature: "电脑签名校验失败，已停止配对",
    closed: "配对槽位无效、已过期或电脑已离线",
    timeout: "配对超时",
    protocol_error: "配对链接或报文无效",
  };
  return `${messages[code] ?? (error instanceof Error ? error.message : "配对失败")}。请在电脑上重新点『配对新手机』`;
}
export async function pairPhone(
  storage: PhoneStorage,
  offer: ParsedOffer,
  origin: string,
  deviceName: string,
  connect = connectPairRelay,
  timeoutMs = 60000,
  rememberOrigin = false,
): Promise<PairedHost> {
  const identity = await storage.identity();
  const transport = await connect({ origin, slot: offer.slot });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const hello = await createPairingHello(identity, offer, deviceName);
    const reply = new Promise<Uint8Array>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new RemoteChannelError("timeout"));
      }, timeoutMs);
      transport.onFrame(resolve);
      transport.onClose(() => {
        reject(new RemoteChannelError("closed"));
      });
    });
    transport.send(hello.message);
    const result = await finishPairing(hello.state, await reply);
    const hosts = await storage.hosts();
    const host: PairedHost = {
      hostId: result.hostId,
      hostPub: encode(result.hostPublicKey),
      name: hosts.find((h) => h.hostId === result.hostId)?.name ?? `电脑 ${hosts.length + 1}`,
      pairedAt: Date.now(),
      ...(rememberOrigin ? { origin } : {}),
    };
    await storage.putHost(host);
    return host;
  } finally {
    clearTimeout(timer);
    transport.close();
  }
}
