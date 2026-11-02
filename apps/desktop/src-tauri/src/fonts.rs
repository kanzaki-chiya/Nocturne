//! 本机已安装字体（设置 › 外观的字体下拉）：用 fontdb 扫系统字体目录，只取字体族名
//! 和是否等宽，不加载、不打包任何字体文件。第一次调用扫一遍，结果在本次运行内缓存。

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Serialize;

use crate::backend::CommandError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FontFamily {
    pub name: String,
    pub mono: bool,
}

static FONTS: OnceLock<Vec<FontFamily>> = OnceLock::new();

/// 列出本机字体族（按名称排序，不分大小写）。扫描失败时前端只显示「默认」。
#[tauri::command]
pub async fn list_fonts() -> Result<Vec<FontFamily>, CommandError> {
    if let Some(fonts) = FONTS.get() {
        return Ok(fonts.clone());
    }
    let fonts = tauri::async_runtime::spawn_blocking(scan)
        .await
        .map_err(|e| CommandError::new("io", format!("读取字体失败：{e}")))?;
    Ok(FONTS.get_or_init(|| fonts).clone())
}

fn scan() -> Vec<FontFamily> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    families(
        db.faces()
            .filter_map(|face| face.families.first().map(|(name, _)| (name.as_str(), face.monospaced))),
    )
}

/// 把逐个字形文件（同一族的常规、粗体、斜体各一个）归并成字体族。
/// 族里任意一个字形标了等宽就算等宽；`@` 开头的是 Windows 的竖排别名，`.` 开头的是
/// 系统内部字体（如 `.PingFang SC`），都不列。
fn families<'a>(faces: impl Iterator<Item = (&'a str, bool)>) -> Vec<FontFamily> {
    let mut map: BTreeMap<String, FontFamily> = BTreeMap::new();
    for (name, mono) in faces {
        let name = name.trim();
        if name.is_empty() || name.starts_with('@') || name.starts_with('.') {
            continue;
        }
        let entry = map.entry(name.to_lowercase()).or_insert_with(|| FontFamily {
            name: name.to_string(),
            mono: false,
        });
        entry.mono |= mono;
    }
    map.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_faces_into_families() {
        let list = families(
            [
                ("Consolas", true),
                ("Segoe UI", false),
                ("consolas", false),
                ("@MS Gothic", true),
                (".PingFang SC", false),
                ("  ", false),
                ("Arial", false),
            ]
            .into_iter(),
        );
        assert_eq!(
            list,
            vec![
                FontFamily { name: "Arial".into(), mono: false },
                FontFamily { name: "Consolas".into(), mono: true },
                FontFamily { name: "Segoe UI".into(), mono: false },
            ]
        );
    }
}
