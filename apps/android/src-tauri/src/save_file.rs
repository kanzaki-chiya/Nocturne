//! 安卓文件保存插件：前端传入文件名、MIME 类型与 base64 字节，Rust 校验参数与体积上限并解码后，
//! 交由 Kotlin `SaveFilePlugin` 拉起系统 `ACTION_CREATE_DOCUMENT` 写入用户所选 Uri。
use serde_json::Value;
#[cfg(target_os = "android")]
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

/// 单次保存原始字节上限（16 MiB，涵盖 5 MiB 单张图片上限与远程通道附件上限）。
pub const MAX_SAVE_BYTES: usize = 16 * 1024 * 1024;

#[cfg(target_os = "android")]
static NEXT_SAVE_ID: AtomicU64 = AtomicU64::new(1);

#[cfg(target_os = "android")]
struct SaveFile<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct PreparedSave {
    pub name: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

fn sanitize_file_name(raw: &str) -> Result<String, String> {
    let segment = raw
        .trim()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim();
    let cleaned: String = segment
        .chars()
        .map(|c| match c {
            '\0'..='\x1F' | '\x7F' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return Err("Invalid file name".into());
    }
    Ok(trimmed.to_string())
}

fn sanitize_mime_type(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok("application/octet-stream".into());
    }
    if trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("Invalid MIME type".into());
    }
    let Some((major, minor)) = trimmed.split_once('/') else {
        return Err("Invalid MIME type".into());
    };
    if major.is_empty() || minor.is_empty() {
        return Err("Invalid MIME type".into());
    }
    Ok(trimmed.to_string())
}

pub(crate) fn prepare_save_payload(
    name: &str,
    mime_type: &str,
    data: &str,
) -> Result<PreparedSave, String> {
    let clean_name = sanitize_file_name(name)?;
    let clean_mime = sanitize_mime_type(mime_type)?;

    let clean_len = data
        .bytes()
        .filter(|b| !b.is_ascii_whitespace() && *b != b'=')
        .count();
    if clean_len % 4 == 1 {
        return Err("Invalid base64 length".into());
    }
    let estimated = (clean_len / 4) * 3
        + match clean_len % 4 {
            2 => 1,
            3 => 2,
            _ => 0,
        };
    if estimated > MAX_SAVE_BYTES {
        return Err("File exceeds size limit".into());
    }

    let bytes = crate::lan_tcp::base64_decode(data).map_err(|_| "Invalid base64 data".to_string())?;
    if bytes.len() > MAX_SAVE_BYTES {
        return Err("File exceeds size limit".into());
    }

    Ok(PreparedSave {
        name: clean_name,
        mime_type: clean_mime,
        bytes,
    })
}

#[tauri::command]
async fn save_file<R: Runtime>(
    app: tauri::AppHandle<R>,
    name: String,
    mime_type: String,
    data: String,
) -> Result<Value, String> {
    let prepared = prepare_save_payload(&name, &mime_type, &data)?;
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let cache_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
        let id = NEXT_SAVE_ID.fetch_add(1, Ordering::Relaxed);
        let temp_path = cache_dir.join(format!("pending-save-{id}.bin"));
        std::fs::write(&temp_path, &prepared.bytes).map_err(|e| e.to_string())?;

        let handle = app.state::<SaveFile<R>>();
        let result = handle
            .0
            .run_mobile_plugin(
                "save_file",
                serde_json::json!({
                    "name": prepared.name,
                    "mimeType": prepared.mime_type,
                    "tempPath": temp_path.to_string_lossy(),
                }),
            )
            .map_err(|error| error.to_string());
        let _ = std::fs::remove_file(&temp_path);
        result
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, prepared);
        Err("save_file is only available on Android".into())
    }
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("save-file")
        .invoke_handler(tauri::generate_handler![save_file])
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = _api.register_android_plugin(
                    "io.github.kanzaki_chiya.nocturne.remote",
                    "SaveFilePlugin",
                )?;
                _app.manage(SaveFile(handle));
            }
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lan_tcp::base64_encode;

    #[test]
    fn validates_file_name_and_mime_type() {
        let ok = prepare_save_payload("dir/sub\\photo:1?.png", "image/png", "AQID").unwrap();
        assert_eq!(ok.name, "photo_1_.png");
        assert_eq!(ok.mime_type, "image/png");
        assert_eq!(ok.bytes, vec![1, 2, 3]);

        let fallback_mime = prepare_save_payload("notes.txt", "   ", "").unwrap();
        assert_eq!(fallback_mime.name, "notes.txt");
        assert_eq!(fallback_mime.mime_type, "application/octet-stream");
        assert!(fallback_mime.bytes.is_empty());

        for bad_name in ["", "   ", ".", "..", "a/b/", "..."] {
            assert!(
                prepare_save_payload(bad_name, "image/png", "AQID").is_err(),
                "expected invalid name: {bad_name}"
            );
        }
        for bad_mime in ["image", "/png", "image/", "image/png extra", "image/\npng"] {
            assert!(
                prepare_save_payload("a.png", bad_mime, "AQID").is_err(),
                "expected invalid mime: {bad_mime}"
            );
        }
    }

    #[test]
    fn decodes_base64_and_rejects_corrupted_input() {
        let png_sig = [0x89u8, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        let encoded = base64_encode(&png_sig);
        let prepared = prepare_save_payload("shot.png", "image/png", &encoded).unwrap();
        assert_eq!(prepared.bytes, png_sig);

        let with_ws = format!("  {}\n{}  ", &encoded[..4], &encoded[4..]);
        assert_eq!(
            prepare_save_payload("shot.png", "image/png", &with_ws)
                .unwrap()
                .bytes,
            png_sig
        );

        for invalid in ["A", "abc$def=", "====A"] {
            assert!(
                prepare_save_payload("shot.png", "image/png", invalid).is_err(),
                "expected invalid base64: {invalid}"
            );
        }
    }

    #[test]
    fn enforces_size_limit_at_5mb_and_max_boundary() {
        let five_mb = vec![0x5Au8; 5 * 1024 * 1024];
        let five_encoded = base64_encode(&five_mb);
        let ok_five = prepare_save_payload("large.png", "image/png", &five_encoded).unwrap();
        assert_eq!(ok_five.bytes.len(), 5 * 1024 * 1024);

        let exact_max = vec![0xA5u8; MAX_SAVE_BYTES];
        let max_encoded = base64_encode(&exact_max);
        let ok_max =
            prepare_save_payload("bundle.bin", "application/octet-stream", &max_encoded).unwrap();
        assert_eq!(ok_max.bytes.len(), MAX_SAVE_BYTES);

        let over_max = vec![0x11u8; MAX_SAVE_BYTES + 1];
        let over_encoded = base64_encode(&over_max);
        assert!(
            prepare_save_payload("too-big.bin", "application/octet-stream", &over_encoded).is_err()
        );
    }
}
