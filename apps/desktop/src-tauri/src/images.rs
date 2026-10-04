//! 图片选择命令：系统文件对话框选中后由外壳读文件字节，自定义二进制帧回传。
//! 前端不传路径——读取范围仅限用户在对话框里显式选中的文件。

use tauri_plugin_dialog::DialogExt;

use crate::backend::CommandError;

/// 单个文件上限 64 MiB：与 stdout 单行上限同级的内存护栏（不是附件规则，
/// 附件的格式与尺寸校验仍在 Core 侧）。
const IMAGE_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// 响应帧格式：重复记录 [u32 LE 文件名 UTF-8 字节数][文件名][u32 LE 数据字节数][数据]。
pub fn encode_records(records: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, data) in records {
        out.extend_from_slice(&(name.len() as u32).to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(data);
    }
    out
}

#[tauri::command]
pub async fn pick_images(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<tauri::ipc::Response, CommandError> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_parent(&window)
            .add_filter("图片", &["png", "jpg", "jpeg", "gif", "webp"])
            .blocking_pick_files()
    })
    .await
    .map_err(|e| CommandError::new("io", format!("打开文件对话框失败：{e}")))?;
    let Some(files) = picked else {
        return Ok(tauri::ipc::Response::new(Vec::new()));
    };
    let mut records = Vec::with_capacity(files.len());
    for file in files {
        let path = file
            .into_path()
            .map_err(|_| CommandError::new("io", "无法解析所选文件路径"))?;
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        let size = std::fs::metadata(&path)
            .map_err(|e| CommandError::new("io", format!("无法读取 {name}：{e}")))?
            .len();
        if size > IMAGE_MAX_BYTES {
            return Err(CommandError::new(
                "file_too_large",
                format!("{name} 超过 64 MiB，无法加入"),
            ));
        }
        let data = std::fs::read(&path)
            .map_err(|e| CommandError::new("io", format!("无法读取 {name}：{e}")))?;
        records.push((name, data));
    }
    Ok(tauri::ipc::Response::new(encode_records(&records)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(name: &str, data: &[u8]) -> (String, Vec<u8>) {
        (name.to_string(), data.to_vec())
    }

    #[test]
    fn encode_empty() {
        assert!(encode_records(&[]).is_empty());
    }

    #[test]
    fn encode_two_records() {
        let bytes = encode_records(&[record("a.png", &[1, 2, 3]), record("b.jpg", &[])]);
        let mut expect = Vec::new();
        expect.extend_from_slice(&5u32.to_le_bytes());
        expect.extend_from_slice(b"a.png");
        expect.extend_from_slice(&3u32.to_le_bytes());
        expect.extend_from_slice(&[1, 2, 3]);
        expect.extend_from_slice(&5u32.to_le_bytes());
        expect.extend_from_slice(b"b.jpg");
        expect.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(bytes, expect);
    }

    #[test]
    fn encode_unicode_name() {
        let bytes = encode_records(&[record("截图🌙.png", &[0x89])]);
        let name = "截图🌙.png".as_bytes();
        assert_eq!(
            bytes,
            [
                &(name.len() as u32).to_le_bytes()[..],
                name,
                &1u32.to_le_bytes()[..],
                &[0x89],
            ]
            .concat()
        );
    }
}
