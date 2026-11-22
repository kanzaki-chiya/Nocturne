export const SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'unsafe-inline' https://cdnjs.cloudflare.com; img-src data: blob: https://cdnjs.cloudflare.com; font-src data: https://cdnjs.cloudflare.com; media-src data: blob:; connect-src 'none'; frame-ancestors 'self'; sandbox allow-scripts";

export function staticCsp(publicOrigin: string): string {
  const websocket = new URL(publicOrigin);
  websocket.protocol = websocket.protocol === "https:" ? "wss:" : "ws:";
  return `default-src 'self'; script-src 'self'; connect-src 'self' ${websocket.origin}; worker-src 'self'; manifest-src 'self'; style-src 'self'; img-src 'self' data: blob:; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`;
}
