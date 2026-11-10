use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, SocketAddrV4, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, State};

/// 与 @nocturne/remote 的 MAX_FRAME (1 MiB) 一致，单帧合法长度范围 1..=MAX_FRAME
const MAX_FRAME: usize = 1_048_576;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(2_000);
const BASE64_TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

enum Outbound {
    Frame(Vec<u8>),
    Close,
}

struct ActiveSocket {
    tx: mpsc::SyncSender<Outbound>,
    stream: TcpStream,
}

#[derive(Default)]
struct LanTcpRegistry {
    next_id: AtomicU64,
    sockets: Mutex<HashMap<u64, ActiveSocket>>,
}

fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(((input.len() + 2) / 3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(BASE64_TABLE[((n >> 18) & 0x3F) as usize] as char);
        out.push(BASE64_TABLE[((n >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(BASE64_TABLE[((n >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(BASE64_TABLE[(n & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn base64_val(b: u8) -> Option<u8> {
    match b {
        b'A'..=b'Z' => Some(b - b'A'),
        b'a'..=b'z' => Some(b - b'a' + 26),
        b'0'..=b'9' => Some(b - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let clean: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace() && *b != b'=')
        .collect();
    let mut out = Vec::with_capacity((clean.len() * 3) / 4);
    for chunk in clean.chunks(4) {
        if chunk.len() == 1 {
            return Err("非法的 base64 长度".into());
        }
        let v0 = base64_val(chunk[0]).ok_or("非法的 base64 字符")? as u32;
        let v1 = base64_val(chunk[1]).ok_or("非法的 base64 字符")? as u32;
        out.push(((v0 << 2) | (v1 >> 4)) as u8);
        if chunk.len() > 2 {
            let v2 = base64_val(chunk[2]).ok_or("非法的 base64 字符")? as u32;
            out.push((((v1 & 0x0F) << 4) | (v2 >> 2)) as u8);
            if chunk.len() > 3 {
                let v3 = base64_val(chunk[3]).ok_or("非法的 base64 字符")? as u32;
                out.push((((v2 & 0x03) << 6) | v3) as u8);
            }
        }
    }
    Ok(out)
}

fn is_allowed_lan_ipv4(ip: Ipv4Addr) -> bool {
    ip.is_private()
}

/// 严格校验目标地址，仅接受 `tcp://<私有网段 IPv4>:<1..=65535>`
fn parse_lan_tcp_target(raw: &str) -> Result<SocketAddrV4, String> {
    let rest = raw
        .trim()
        .strip_prefix("tcp://")
        .ok_or_else(|| "局域网直连仅允许 tcp:// 协议".to_string())?;
    let host_port = rest.strip_suffix('/').unwrap_or(rest);
    if host_port.contains(['/', '?', '#', '@']) {
        return Err("非法的直连地址格式".into());
    }
    let (host_str, port_str) = host_port
        .split_once(':')
        .ok_or_else(|| "直连地址必须显式指定端口".to_string())?;
    if host_str.is_empty()
        || port_str.is_empty()
        || port_str.starts_with('0')
        || !port_str.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("非法的直连主机或端口".into());
    }
    let ip: Ipv4Addr = host_str
        .parse()
        .map_err(|_| "直连地址仅允许点分十进制 IPv4".to_string())?;
    if !is_allowed_lan_ipv4(ip) {
        return Err("直连地址仅允许私有网段 IPv4".into());
    }
    let port: u16 = port_str
        .parse()
        .map_err(|_| "直连端口超出有效范围".to_string())?;
    if port == 0 {
        return Err("直连端口不能为 0".into());
    }
    Ok(SocketAddrV4::new(ip, port))
}

/// 编码 4 字节大端无符号长度前缀 + 原始帧负载（长度范围 1..=MAX_FRAME）
fn encode_length_prefixed(payload: &[u8]) -> Result<Vec<u8>, String> {
    let len = payload.len();
    if len == 0 || len > MAX_FRAME {
        return Err(format!("直连帧长度越界：{len}"));
    }
    let mut out = Vec::with_capacity(4 + len);
    out.extend_from_slice(&(len as u32).to_be_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

/// 从字节流读取一条带 4 字节大端长度前缀的帧：
/// - 在帧起始处遇到正常 EOF 返回 `Ok(None)`；
/// - 读完 4 字节长度头后立即校验 `1..=MAX_FRAME`，越界立即返回 `Err` 且不分配负载内存。
fn read_length_prefixed_frame<R: Read>(reader: &mut R) -> Result<Option<Vec<u8>>, String> {
    let mut header = [0u8; 4];
    let mut read_header = 0usize;
    while read_header < 4 {
        match reader.read(&mut header[read_header..]) {
            Ok(0) => {
                if read_header == 0 {
                    return Ok(None);
                }
                return Err("长度头未读完连接已关闭".into());
            }
            Ok(n) => read_header += n,
            Err(ref e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(format!("读取帧头失败：{e}")),
        }
    }
    let len = u32::from_be_bytes(header) as usize;
    if len == 0 || len > MAX_FRAME {
        return Err(format!("入站帧长度越界：{len}"));
    }
    let mut payload = vec![0u8; len];
    reader
        .read_exact(&mut payload)
        .map_err(|e| format!("读取帧负载失败：{e}"))?;
    Ok(Some(payload))
}

fn read_loop(
    mut reader: TcpStream,
    write_shutdown: TcpStream,
    on_event: Channel<Option<String>>,
) {
    while let Ok(Some(payload)) = read_length_prefixed_frame(&mut reader) {
        if on_event.send(Some(base64_encode(&payload))).is_err() {
            break;
        }
    }
    let _ = write_shutdown.shutdown(Shutdown::Both);
    let _ = on_event.send(None);
}

fn write_loop(mut stream: TcpStream, rx: mpsc::Receiver<Outbound>) {
    while let Ok(cmd) = rx.recv() {
        match cmd {
            Outbound::Frame(payload) => {
                let Ok(encoded) = encode_length_prefixed(&payload) else {
                    let _ = stream.shutdown(Shutdown::Both);
                    break;
                };
                if stream.write_all(&encoded).is_err() {
                    let _ = stream.shutdown(Shutdown::Both);
                    break;
                }
            }
            Outbound::Close => {
                let _ = stream.shutdown(Shutdown::Both);
                break;
            }
        }
    }
}

#[tauri::command]
async fn connect(
    state: State<'_, LanTcpRegistry>,
    url: String,
    on_event: Channel<Option<String>>,
) -> Result<u64, String> {
    let addr = parse_lan_tcp_target(&url)?;
    let stream = tauri::async_runtime::spawn_blocking(move || -> Result<TcpStream, String> {
        let tcp = TcpStream::connect_timeout(&SocketAddr::V4(addr), CONNECT_TIMEOUT)
            .map_err(|e| format!("局域网直连失败：{e}"))?;
        let _ = tcp.set_nodelay(true);
        let _ = tcp.set_read_timeout(None);
        let _ = tcp.set_write_timeout(Some(Duration::from_secs(10)));
        Ok(tcp)
    })
    .await
    .map_err(|e| format!("连接任务异常：{e}"))??;

    let read_stream = stream
        .try_clone()
        .map_err(|e| format!("复制套接字失败：{e}"))?;
    let read_killer = stream
        .try_clone()
        .map_err(|e| format!("复制套接字失败：{e}"))?;
    let write_stream = stream
        .try_clone()
        .map_err(|e| format!("复制套接字失败：{e}"))?;

    let (tx, rx) = mpsc::sync_channel::<Outbound>(256);
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    {
        let mut guard = state.sockets.lock().map_err(|_| "连接表锁损坏")?;
        guard.insert(id, ActiveSocket { tx, stream });
    }

    thread::spawn(move || write_loop(write_stream, rx));
    thread::spawn(move || read_loop(read_stream, read_killer, on_event));

    Ok(id)
}

#[tauri::command]
fn send(state: State<'_, LanTcpRegistry>, id: u64, data: String) -> Result<(), String> {
    let bytes = base64_decode(&data)?;
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return Err("发送帧大小越界".into());
    }
    let tx = {
        let guard = state.sockets.lock().map_err(|_| "连接表锁损坏")?;
        guard.get(&id).map(|s| s.tx.clone())
    };
    match tx {
        Some(sender) => sender
            .send(Outbound::Frame(bytes))
            .map_err(|_| "局域网直连已关闭".into()),
        None => Err("局域网直连不存在或已关闭".into()),
    }
}

#[tauri::command]
fn close(state: State<'_, LanTcpRegistry>, id: u64) -> Result<(), String> {
    let removed = {
        let mut guard = state.sockets.lock().map_err(|_| "连接表锁损坏")?;
        guard.remove(&id)
    };
    if let Some(active) = removed {
        let _ = active.tx.try_send(Outbound::Close);
        let _ = active.stream.shutdown(Shutdown::Both);
    }
    Ok(())
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("lan-tcp")
        .invoke_handler(tauri::generate_handler![connect, send, close])
        .setup(|app, _api| {
            app.manage(LanTcpRegistry::default());
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn target_only_allows_private_tcp_ipv4() {
        assert!(parse_lan_tcp_target("tcp://192.168.1.5:41234").is_ok());
        assert!(parse_lan_tcp_target("tcp://10.0.2.2:41234").is_ok());
        assert!(parse_lan_tcp_target("tcp://172.16.5.9:9000").is_ok());

        for denied in [
            "ws://192.168.1.5:41234",
            "wss://192.168.1.5:41234",
            "http://192.168.1.5:41234",
            "tcp://127.0.0.1:8080",
            "tcp://169.254.1.2:8080",
            "tcp://8.8.8.8:41234",
            "tcp://100.64.0.1:41234",
            "tcp://172.32.0.1:41234",
            "tcp://example.com:41234",
            "tcp://192.168.1.5",
            "tcp://192.168.1.5:0",
            "tcp://192.168.1.5:0123",
            "tcp://192.168.1.5:41234/path",
            "tcp://[::1]:41234",
        ] {
            assert!(parse_lan_tcp_target(denied).is_err(), "{denied}");
        }
    }

    #[test]
    fn length_prefixed_codec_and_bounds() {
        // 空帧与超限帧在编码侧拒绝
        assert!(encode_length_prefixed(&[]).is_err());
        assert!(encode_length_prefixed(&vec![0xAB; MAX_FRAME + 1]).is_err());

        // 多帧连续编解码与尾部正常 EOF
        let f1 = vec![0x01, 0x10, 0x20, 0x30];
        let f2 = vec![0x10; 300];
        let mut wire = encode_length_prefixed(&f1).unwrap();
        wire.extend_from_slice(&encode_length_prefixed(&f2).unwrap());

        let mut cursor = Cursor::new(wire);
        assert_eq!(read_length_prefixed_frame(&mut cursor).unwrap(), Some(f1));
        assert_eq!(read_length_prefixed_frame(&mut cursor).unwrap(), Some(f2));
        assert_eq!(read_length_prefixed_frame(&mut cursor).unwrap(), None);

        // 入站长度前缀为 0 立即报错（即使后面没有字节）
        let mut zero_len = Cursor::new([0u8, 0, 0, 0]);
        assert!(read_length_prefixed_frame(&mut zero_len).is_err());

        // 入站长度前缀超过 MAX_FRAME（如 MAX_FRAME + 1 或 HTTP "GET "）立即报错且不读取/分配负载
        let mut over_len = Cursor::new(((MAX_FRAME as u32) + 1).to_be_bytes());
        assert!(read_length_prefixed_frame(&mut over_len).is_err());
        let mut http_prefix = Cursor::new(*b"GET ");
        assert!(read_length_prefixed_frame(&mut http_prefix).is_err());
    }

    #[test]
    fn base64_roundtrip() {
        for len in [1usize, 2, 3, 4, 31, 32, 33, 1024] {
            let src: Vec<u8> = (0..len).map(|i| ((i * 73 + 19) & 0xFF) as u8).collect();
            let encoded = base64_encode(&src);
            let decoded = base64_decode(&encoded).unwrap();
            assert_eq!(decoded, src);
        }
    }
}
