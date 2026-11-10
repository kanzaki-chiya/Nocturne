use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, SocketAddrV4, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, State, Url};

/// 与 `@nocturne/remote` 的 `MAX_FRAME` 一致（1 MiB）。
const MAX_FRAME_BYTES: usize = 1_048_576;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(2_000);
const HANDSHAKE_READ_TIMEOUT: Duration = Duration::from_millis(5_000);
const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const B64_TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

enum Outbound {
    Binary(Vec<u8>),
    Pong(Vec<u8>),
    Close,
}

struct ActiveSocket {
    tx: mpsc::SyncSender<Outbound>,
    stream: TcpStream,
}

#[derive(Default)]
struct LanWsState {
    next_id: AtomicU64,
    sockets: Mutex<HashMap<u64, ActiveSocket>>,
}

fn is_allowed_lan_ipv4(ip: Ipv4Addr) -> bool {
    ip.is_private() || ip.is_loopback() || ip.is_link_local()
}

fn parse_lan_ws_target(raw: &str) -> Result<(SocketAddrV4, String), String> {
    let url = Url::parse(raw).map_err(|_| "无效的直连地址".to_string())?;
    if url.scheme() != "ws" {
        return Err("直连仅允许 ws:// 协议".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("直连地址不允许凭据".into());
    }
    let ip = match url.host_str().and_then(|h| h.parse::<Ipv4Addr>().ok()) {
        Some(ipv4) if is_allowed_lan_ipv4(ipv4) => ipv4,
        _ => return Err("直连地址仅允许私有网段 IPv4".into()),
    };
    let port = url
        .port()
        .filter(|p| *p > 0)
        .ok_or_else(|| "直连地址缺少端口".to_string())?;
    let mut path = url.path().to_string();
    if path.is_empty() {
        path.push('/');
    }
    if let Some(q) = url.query() {
        path.push('?');
        path.push_str(q);
    }
    Ok((SocketAddrV4::new(ip, port), path))
}

fn fill_random(buf: &mut [u8]) {
    #[cfg(unix)]
    {
        if let Ok(mut file) = std::fs::File::open("/dev/urandom") {
            if file.read_exact(buf).is_ok() {
                return;
            }
        }
    }
    let mut offset = 0;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut counter = 0u64;
    while offset < buf.len() {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(nanos.wrapping_add(counter));
        counter = counter.wrapping_add(1);
        let bytes = hasher.finish().to_le_bytes();
        let take = (buf.len() - offset).min(bytes.len());
        buf[offset..offset + take].copy_from_slice(&bytes[..take]);
        offset += take;
    }
}

fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h0: u32 = 0x67452301;
    let mut h1: u32 = 0xEFCDAB89;
    let mut h2: u32 = 0x98BADCFE;
    let mut h3: u32 = 0x10325476;
    let mut h4: u32 = 0xC3D2E1F0;

    let bit_len = (data.len() as u64) * 8;
    let mut padded = Vec::with_capacity(((data.len() + 9 + 63) / 64) * 64);
    padded.extend_from_slice(data);
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in padded.chunks_exact(64) {
        let mut w = [0u32; 80];
        for (i, word) in chunk.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h0, h1, h2, h3, h4);
        for (i, &wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }

    let mut out = [0u8; 20];
    out[0..4].copy_from_slice(&h0.to_be_bytes());
    out[4..8].copy_from_slice(&h1.to_be_bytes());
    out[8..12].copy_from_slice(&h2.to_be_bytes());
    out[12..16].copy_from_slice(&h3.to_be_bytes());
    out[16..20].copy_from_slice(&h4.to_be_bytes());
    out
}

fn base64_encode(input: &[u8]) -> String {
    let mut out = Vec::with_capacity(((input.len() + 2) / 3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_TABLE[((triple >> 18) & 0x3F) as usize]);
        out.push(B64_TABLE[((triple >> 12) & 0x3F) as usize]);
        out.push(if chunk.len() > 1 {
            B64_TABLE[((triple >> 6) & 0x3F) as usize]
        } else {
            b'='
        });
        out.push(if chunk.len() > 2 {
            B64_TABLE[(triple & 0x3F) as usize]
        } else {
            b'='
        });
    }
    String::from_utf8(out).unwrap_or_default()
}

fn base64_val(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let bytes = input.trim().as_bytes();
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    if bytes.len() % 4 != 0 {
        return Err("非法 base64 长度".into());
    }
    let mut out = Vec::with_capacity((bytes.len() / 4) * 3);
    for chunk in bytes.chunks_exact(4) {
        let v0 = base64_val(chunk[0]).ok_or_else(|| "非法 base64 字符".to_string())?;
        let v1 = base64_val(chunk[1]).ok_or_else(|| "非法 base64 字符".to_string())?;
        let pad2 = chunk[2] == b'=';
        let pad3 = chunk[3] == b'=';
        if pad2 && !pad3 {
            return Err("非法 base64 填充".into());
        }
        let v2 = if pad2 {
            0
        } else {
            base64_val(chunk[2]).ok_or_else(|| "非法 base64 字符".to_string())?
        };
        let v3 = if pad3 {
            0
        } else {
            base64_val(chunk[3]).ok_or_else(|| "非法 base64 字符".to_string())?
        };
        let triple = ((v0 as u32) << 18) | ((v1 as u32) << 12) | ((v2 as u32) << 6) | (v3 as u32);
        out.push(((triple >> 16) & 0xFF) as u8);
        if !pad2 {
            out.push(((triple >> 8) & 0xFF) as u8);
        }
        if !pad3 {
            out.push((triple & 0xFF) as u8);
        }
    }
    Ok(out)
}

fn ws_accept_key(sec_key: &str) -> String {
    let mut combined = String::with_capacity(sec_key.len() + WS_GUID.len());
    combined.push_str(sec_key);
    combined.push_str(WS_GUID);
    base64_encode(&sha1(combined.as_bytes()))
}

fn encode_masked_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let len = payload.len();
    let header_len = if len < 126 {
        2
    } else if len <= 0xFFFF {
        4
    } else {
        10
    };
    let mut mask = [0u8; 4];
    fill_random(&mut mask);
    let mut out = Vec::with_capacity(header_len + 4 + len);
    out.push(0x80 | (opcode & 0x0F));
    if len < 126 {
        out.push(0x80 | (len as u8));
    } else if len <= 0xFFFF {
        out.push(0x80 | 126);
        out.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        out.push(0x80 | 127);
        out.extend_from_slice(&(len as u64).to_be_bytes());
    }
    out.extend_from_slice(&mask);
    for (i, &b) in payload.iter().enumerate() {
        out.push(b ^ mask[i & 3]);
    }
    out
}

fn handshake_client(stream: &mut TcpStream, addr: &SocketAddrV4, path: &str) -> Result<Vec<u8>, String> {
    let mut nonce = [0u8; 16];
    fill_random(&mut nonce);
    let sec_key = base64_encode(&nonce);
    let expected_accept = ws_accept_key(&sec_key);
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {addr}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {sec_key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("发送握手失败：{e}"))?;

    let mut buf = Vec::with_capacity(512);
    let mut chunk = [0u8; 512];
    loop {
        if buf.len() > 16_384 {
            return Err("WebSocket 升级响应头过大".into());
        }
        let n = stream
            .read(&mut chunk)
            .map_err(|e| format!("读取握手响应失败：{e}"))?;
        if n == 0 {
            return Err("连接在升级完成前关闭".into());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let header_str = std::str::from_utf8(&buf[..pos])
                .map_err(|_| "升级响应头编码错误".to_string())?;
            let mut lines = header_str.split("\r\n");
            let status = lines.next().unwrap_or("");
            if !status.starts_with("HTTP/1.1 101") {
                return Err(format!("升级状态码错误：{status}"));
            }
            let mut upgrade_ok = false;
            let mut accept_ok = false;
            for line in lines {
                if let Some((name, val)) = line.split_once(':') {
                    let name = name.trim();
                    let val = val.trim();
                    if name.eq_ignore_ascii_case("upgrade") && val.eq_ignore_ascii_case("websocket")
                    {
                        upgrade_ok = true;
                    } else if name.eq_ignore_ascii_case("sec-websocket-accept")
                        && val == expected_accept
                    {
                        accept_ok = true;
                    }
                }
            }
            if !upgrade_ok || !accept_ok {
                return Err("WebSocket Sec-WebSocket-Accept 校验失败".into());
            }
            return Ok(buf[pos + 4..].to_vec());
        }
    }
}

struct ByteReader {
    stream: TcpStream,
    buf: Vec<u8>,
    pos: usize,
}

impl ByteReader {
    fn new(stream: TcpStream, initial: Vec<u8>) -> Self {
        Self {
            stream,
            buf: initial,
            pos: 0,
        }
    }

    fn read_exact_bytes(&mut self, len: usize) -> Result<Vec<u8>, ()> {
        let mut out = vec![0u8; len];
        let mut filled = 0;
        while filled < len {
            if self.pos < self.buf.len() {
                let avail = (self.buf.len() - self.pos).min(len - filled);
                out[filled..filled + avail].copy_from_slice(&self.buf[self.pos..self.pos + avail]);
                self.pos += avail;
                filled += avail;
                if self.pos == self.buf.len() {
                    self.buf.clear();
                    self.pos = 0;
                }
            } else {
                let n = self.stream.read(&mut out[filled..]).map_err(|_| ())?;
                if n == 0 {
                    return Err(());
                }
                filled += n;
            }
        }
        Ok(out)
    }
}

fn read_loop(
    mut reader: ByteReader,
    tx: mpsc::SyncSender<Outbound>,
    on_event: Channel<Option<String>>,
) {
    let mut fragments = Vec::<u8>::new();
    let mut fragmenting = false;
    loop {
        let head = match reader.read_exact_bytes(2) {
            Ok(h) => h,
            Err(()) => break,
        };
        let fin = (head[0] & 0x80) != 0;
        let rsv = head[0] & 0x70;
        let opcode = head[0] & 0x0F;
        let masked = (head[1] & 0x80) != 0;
        if rsv != 0 {
            break;
        }
        let mut payload_len = (head[1] & 0x7F) as usize;
        if payload_len == 126 {
            let ext = match reader.read_exact_bytes(2) {
                Ok(b) => b,
                Err(()) => break,
            };
            payload_len = u16::from_be_bytes([ext[0], ext[1]]) as usize;
        } else if payload_len == 127 {
            let ext = match reader.read_exact_bytes(8) {
                Ok(b) => b,
                Err(()) => break,
            };
            let raw = u64::from_be_bytes([
                ext[0], ext[1], ext[2], ext[3], ext[4], ext[5], ext[6], ext[7],
            ]);
            if raw > (MAX_FRAME_BYTES as u64) {
                break;
            }
            payload_len = raw as usize;
        }

        let is_control = (opcode & 0x08) != 0;
        if is_control {
            if !fin || payload_len > 125 {
                break;
            }
        } else if payload_len > MAX_FRAME_BYTES
            || fragments.len().saturating_add(payload_len) > MAX_FRAME_BYTES
        {
            break;
        }

        let mask_key = if masked {
            match reader.read_exact_bytes(4) {
                Ok(m) => Some([m[0], m[1], m[2], m[3]]),
                Err(()) => break,
            }
        } else {
            None
        };
        let mut payload = match reader.read_exact_bytes(payload_len) {
            Ok(p) => p,
            Err(()) => break,
        };
        if let Some(m) = mask_key {
            for (i, b) in payload.iter_mut().enumerate() {
                *b ^= m[i & 3];
            }
        }

        match opcode {
            0x8 => {
                let _ = tx.try_send(Outbound::Close);
                break;
            }
            0x9 => {
                let _ = tx.try_send(Outbound::Pong(payload));
            }
            0xA => {}
            0x2 => {
                if fragmenting {
                    break;
                }
                if fin {
                    if on_event.send(Some(base64_encode(&payload))).is_err() {
                        break;
                    }
                } else {
                    fragmenting = true;
                    fragments = payload;
                }
            }
            0x0 => {
                if !fragmenting {
                    break;
                }
                fragments.extend_from_slice(&payload);
                if fin {
                    fragmenting = false;
                    let completed = std::mem::take(&mut fragments);
                    if on_event.send(Some(base64_encode(&completed))).is_err() {
                        break;
                    }
                }
            }
            _ => break,
        }
    }
    let _ = on_event.send(None);
}

#[tauri::command]
async fn connect(
    state: State<'_, Arc<LanWsState>>,
    url: String,
    on_event: Channel<Option<String>>,
) -> Result<u64, String> {
    let (addr, path) = parse_lan_ws_target(&url)?;
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut stream = TcpStream::connect_timeout(&SocketAddr::V4(addr), CONNECT_TIMEOUT)
            .map_err(|e| format!("无法连接局域网端口：{e}"))?;
        let _ = stream.set_nodelay(true);
        let _ = stream.set_read_timeout(Some(HANDSHAKE_READ_TIMEOUT));
        let _ = stream.set_write_timeout(Some(HANDSHAKE_READ_TIMEOUT));
        let leftover = handshake_client(&mut stream, &addr, &path)?;
        let _ = stream.set_read_timeout(None);
        let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));

        let read_stream = stream
            .try_clone()
            .map_err(|e| format!("复制连接句柄失败：{e}"))?;
        let mut write_stream = stream
            .try_clone()
            .map_err(|e| format!("复制写入句柄失败：{e}"))?;

        let (tx, rx) = mpsc::sync_channel::<Outbound>(256);
        let tx_for_reader = tx.clone();
        let id = state_arc.next_id.fetch_add(1, Ordering::Relaxed) + 1;

        {
            let mut guard = state_arc
                .sockets
                .lock()
                .map_err(|_| "连接表已损坏".to_string())?;
            guard.insert(id, ActiveSocket { tx, stream });
        }

        let state_for_writer = state_arc.clone();
        std::thread::spawn(move || {
            while let Ok(cmd) = rx.recv() {
                let res = match cmd {
                    Outbound::Binary(data) => {
                        write_stream.write_all(&encode_masked_frame(0x2, &data))
                    }
                    Outbound::Pong(data) => {
                        write_stream.write_all(&encode_masked_frame(0xA, &data))
                    }
                    Outbound::Close => {
                        let _ = write_stream
                            .write_all(&encode_masked_frame(0x8, &1000u16.to_be_bytes()));
                        let _ = write_stream.shutdown(Shutdown::Both);
                        break;
                    }
                };
                if res.is_err() {
                    let _ = write_stream.shutdown(Shutdown::Both);
                    break;
                }
            }
            if let Ok(mut guard) = state_for_writer.sockets.lock() {
                guard.remove(&id);
            }
        });

        let state_for_reader = state_arc;
        std::thread::spawn(move || {
            read_loop(ByteReader::new(read_stream, leftover), tx_for_reader, on_event);
            if let Ok(mut guard) = state_for_reader.sockets.lock() {
                if let Some(active) = guard.remove(&id) {
                    let _ = active.stream.shutdown(Shutdown::Both);
                }
            }
        });

        Ok(id)
    })
    .await
    .map_err(|e| format!("直连任务异常：{e}"))?
}

#[tauri::command]
fn send(state: State<'_, Arc<LanWsState>>, id: u64, data: String) -> Result<(), String> {
    let bytes = base64_decode(&data)?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err("帧大小超过上限".into());
    }
    let tx = {
        let guard = state
            .sockets
            .lock()
            .map_err(|_| "连接表已损坏".to_string())?;
        guard
            .get(&id)
            .map(|s| s.tx.clone())
            .ok_or_else(|| "直连已关闭".to_string())?
    };
    tx.try_send(Outbound::Binary(bytes))
        .map_err(|_| "直连发送队列已满或已关闭".to_string())
}

#[tauri::command]
fn close(state: State<'_, Arc<LanWsState>>, id: u64) -> Result<(), String> {
    let removed = {
        let mut guard = state
            .sockets
            .lock()
            .map_err(|_| "连接表已损坏".to_string())?;
        guard.remove(&id)
    };
    if let Some(active) = removed {
        let _ = active.tx.try_send(Outbound::Close);
        let _ = active.stream.shutdown(Shutdown::Both);
    }
    Ok(())
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("lan-ws")
        .invoke_handler(tauri::generate_handler![connect, send, close])
        .setup(|app, _api| {
            app.manage(Arc::new(LanWsState::default()));
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc6455_accept_vector_matches() {
        assert_eq!(
            ws_accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn base64_roundtrip() {
        for len in [0usize, 1, 2, 3, 4, 31, 65, 257] {
            let data: Vec<u8> = (0..len).map(|i| (i * 37 + 13) as u8).collect();
            let encoded = base64_encode(&data);
            assert_eq!(base64_decode(&encoded).unwrap(), data);
        }
    }

    #[test]
    fn target_only_allows_private_ws_ipv4() {
        assert!(parse_lan_ws_target("ws://192.168.1.5:41234").is_ok());
        assert!(parse_lan_ws_target("ws://10.0.2.2:41234/").is_ok());
        assert!(parse_lan_ws_target("ws://172.16.5.9:9000").is_ok());
        assert!(parse_lan_ws_target("ws://127.0.0.1:41234").is_ok());

        for rejected in [
            "wss://192.168.1.5:41234",
            "http://192.168.1.5:41234",
            "ws://8.8.8.8:41234",
            "ws://172.32.0.1:41234",
            "ws://relay.example:41234",
            "ws://192.168.1.5",
            "ws://user:pass@192.168.1.5:41234",
        ] {
            assert!(parse_lan_ws_target(rejected).is_err(), "{rejected}");
        }
    }
}
