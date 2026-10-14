export function staticCsp(publicOrigin: string): string {
  const websocket = new URL(publicOrigin);
  websocket.protocol = websocket.protocol === "https:" ? "wss:" : "ws:";
  return `default-src 'self'; script-src 'self'; connect-src 'self' ${websocket.origin}; worker-src 'self'; manifest-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`;
}
