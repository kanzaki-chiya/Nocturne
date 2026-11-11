export const SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; frame-ancestors 'self'; sandbox allow-scripts";

export function staticCsp(publicOrigin: string): string {
  const websocket = new URL(publicOrigin);
  websocket.protocol = websocket.protocol === "https:" ? "wss:" : "ws:";
  return `default-src 'self'; script-src 'self'; connect-src 'self' ${websocket.origin}; worker-src 'self'; manifest-src 'self'; style-src 'self'; img-src 'self' data: blob:; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`;
}
