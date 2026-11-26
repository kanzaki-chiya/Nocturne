//! 「文件」标签的「打开」菜单：列出系统给这个文件建议的应用，并用选中的
//! 应用打开文件（ADR-0102、ADR-0110）。系统关联是唯一事实源：名称、图标、默认程序
//! 都从系统读，不写系统状态。应用的身份只以应用键的哈希交给前端，打开时重新枚举、
//! 按哈希找回。
//!
//! - **Windows**：经 Shell COM（`IAssocHandler` / `IApplicationAssociationRegistration`）
//!   查询并 `Invoke`，绝不调用 `MakeDefault`。
//! - **macOS**：经 `NSWorkspace`（`URLsForApplicationsToOpenURL:`、
//!   `URLForApplicationToOpenURL:`、`openURLs:withApplicationAtURL:configuration:completionHandler:`、
//!   `iconForFile:`）与 `NSFileManager::displayNameAtPath:` 查询并打开。
//!
//! 会被直接执行的类型（`editor::launches_code_any`）不列系统应用（ADR-0046 防误运行）。

use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::Serialize;

use crate::backend::CommandError;
use crate::editor;

/// 交给前端的一个系统应用；`id` 是应用键的哈希，不含路径或命令。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileApp {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_data_url: Option<String>,
    pub is_default: bool,
}

/// 兜底的 VS Code / Cursor 图标（从 `find_editor` 找到的命令向上找真实 exe 读取）。
#[derive(Debug, Default, Serialize)]
pub struct EditorIcons {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vscode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// `list_file_apps` 的结果。`apps` 为空时前端退回 VS Code / Cursor：
/// `launches_code` 是脚本类文件（「打开」改为在资源管理器中显示），`failed` 是系统查询
/// 失败或不是 Windows（再加「系统默认程序」）。只有这两种或列表为空时才读编辑器图标。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAppList {
    pub apps: Vec<FileApp>,
    pub launches_code: bool,
    pub failed: bool,
    pub editor_icons: EditorIcons,
}

/// 系统枚举出的一个处理器（还没去重、排序）。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Handler {
    /// `IAssocHandler::GetName`：传统应用是 exe 的完整路径，打包应用是包内标识
    pub key: String,
    /// `IAssocHandler::GetUIName`
    pub name: String,
    /// `IObjectWithProgID::GetProgID`，用来和当前默认程序比对
    pub prog_id: Option<String>,
    /// `IAssocHandler::GetIconLocation`
    pub icon: Option<(String, i32)>,
}

/// `QueryCurrentDefault(..., AL_EFFECTIVE)` 给的当前默认程序：ProgID 与它的可执行文件。
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct DefaultAssoc {
    pub prog_id: Option<String>,
    pub executable: Option<String>,
}

/// 应用键规范化：Windows 统一反斜杠并忽略大小写；macOS / Unix 保留正斜杠、去尾斜杠并忽略大小写。
fn normalize_key(key: &str) -> String {
    #[cfg(windows)]
    {
        key.trim().replace('/', "\\").to_lowercase()
    }
    #[cfg(not(windows))]
    {
        key.trim().trim_end_matches('/').to_lowercase()
    }
}

/// 应用键的哈希（FNV-1a 64，结果稳定，不依赖 std 的随机哈希种子）。
pub(crate) fn app_id(key: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in normalize_key(key).as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("app-{hash:016x}")
}

/// 当前默认程序对应哪个应用键：先比 ProgID，再比可执行文件；比不出唯一结果就不标默认，
/// 不按名字猜。
pub(crate) fn default_key(handlers: &[Handler], assoc: &DefaultAssoc) -> Option<String> {
    let unique = |keys: Vec<String>| -> Option<String> {
        let mut keys = keys;
        keys.sort();
        keys.dedup();
        (keys.len() == 1).then(|| keys.remove(0))
    };
    if let Some(prog_id) = assoc
        .prog_id
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        let matched: Vec<String> = handlers
            .iter()
            .filter(|h| {
                h.prog_id
                    .as_deref()
                    .is_some_and(|p| p.trim().eq_ignore_ascii_case(prog_id))
            })
            .map(|h| normalize_key(&h.key))
            .collect();
        if let Some(key) = unique(matched) {
            return Some(key);
        }
    }
    if let Some(exe) = assoc
        .executable
        .as_deref()
        .map(normalize_key)
        .filter(|e| !e.is_empty())
    {
        let matched: Vec<String> = handlers
            .iter()
            .map(|h| normalize_key(&h.key))
            .filter(|k| *k == exe)
            .collect();
        if let Some(key) = unique(matched) {
            return Some(key);
        }
    }
    None
}

/// 去重（同一个应用键只留第一条）、标默认、默认排第一，其余保持系统给的顺序。
pub(crate) fn arrange(handlers: Vec<Handler>, assoc: &DefaultAssoc) -> Vec<(Handler, bool)> {
    let default = default_key(&handlers, assoc);
    let mut seen = std::collections::HashSet::new();
    let mut list: Vec<(Handler, bool)> = Vec::new();
    for handler in handlers {
        if handler.key.trim().is_empty() || handler.name.trim().is_empty() {
            continue;
        }
        let key = normalize_key(&handler.key);
        if !seen.insert(key.clone()) {
            continue;
        }
        let is_default = default.as_deref() == Some(key.as_str());
        list.push((handler, is_default));
    }
    // 稳定排序：只把默认程序挪到最前
    list.sort_by_key(|(_, is_default)| !*is_default);
    list
}

/// 只接受存在的本机绝对路径文件：目录、网络路径（Windows 会发起 SMB 连接）一律拒绝。
pub(crate) fn validate_file(path: &str) -> Result<PathBuf, CommandError> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err(CommandError::new("invalid_path", "文件路径无效"));
    }
    #[cfg(windows)]
    let unc = path.starts_with("\\\\") || path.starts_with("//");
    #[cfg(not(windows))]
    let unc = false;
    let target = PathBuf::from(path);
    if unc || !target.is_absolute() {
        return Err(CommandError::new(
            "invalid_path",
            "文件路径必须是本机绝对路径",
        ));
    }
    let meta =
        std::fs::metadata(&target).map_err(|_| CommandError::new("not_found", "文件不存在"))?;
    if meta.is_dir() {
        return Err(CommandError::new("is_directory", "不能用应用打开目录"));
    }
    if !meta.is_file() {
        return Err(CommandError::new("invalid_path", "这不是普通文件"));
    }
    #[cfg(windows)]
    {
        // Shell 解析名只认反斜杠（正斜杠让 SHCreateItemFromParsingName 报 E_INVALIDARG）
        Ok(PathBuf::from(path.replace('/', "\\")))
    }
    #[cfg(not(windows))]
    {
        Ok(target)
    }
}

/// 从 `find_editor` 找到的命令向上找真实 exe：`…\Microsoft VS Code\bin\code.cmd` →
/// `…\Microsoft VS Code\Code.exe`。命令本身就是 `<cmd>.exe` 时直接用它。
#[cfg(windows)]
pub(crate) fn editor_exe(command: &Path, cmd: &str) -> Option<PathBuf> {
    let exe_name = format!("{cmd}.exe");
    let is_exe = command
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case(&exe_name));
    if is_exe && command.is_file() {
        return Some(command.to_path_buf());
    }
    command
        .parent()?
        .ancestors()
        .take(4)
        .map(|dir| dir.join(&exe_name))
        .find(|candidate| candidate.is_file())
}

/// 两个路径是不是同一个文件：先比真实路径，取不到就比规范化后的字符串。
#[cfg(windows)]
fn same_file(left: &Path, right: &Path) -> bool {
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(a), Ok(b)) => a == b,
        _ => normalize_key(&left.to_string_lossy()) == normalize_key(&right.to_string_lossy()),
    }
}

/// 这个应用键是不是 VS Code / Cursor 的可执行文件：是的话走 `code -g file:line` 带行号打开。
#[cfg(windows)]
fn editor_for_key(key: &str) -> Option<&'static str> {
    let key = Path::new(key.trim());
    if !key.is_absolute() {
        return None;
    }
    [("vscode", "code"), ("cursor", "cursor")]
        .into_iter()
        .find(|(_, cmd)| {
            editor::find_editor(cmd)
                .and_then(|command| editor_exe(&command, cmd))
                .is_some_and(|exe| same_file(&exe, key))
        })
        .map(|(editor, _)| editor)
}

/// 预乘 alpha RGBA 转直通 alpha（CoreGraphics 位图上下文输出预乘 alpha，PNG 需要直通 alpha）。
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(crate) fn unpremultiply_rgba(rgba: &mut [u8]) {
    for px in rgba.chunks_exact_mut(4) {
        let a = px[3];
        if a > 0 && a < 255 {
            for c in &mut px[..3] {
                *c = ((u16::from(*c) * 255 + u16::from(a) / 2) / u16::from(a)).min(255) as u8;
            }
        }
    }
}

/// RGBA 像素编码成 PNG data URL（图标提取的最后一步，平台无关）。
pub(crate) fn png_data_url(width: u32, height: u32, rgba: &[u8]) -> Option<String> {
    if width == 0 || height == 0 || rgba.len() != (width * height * 4) as usize {
        return None;
    }
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn editor_icons() -> EditorIcons {
    platform::editor_icons()
}

/// 列出系统给这个文件的「建议的应用」。每次打开菜单都重新查，不缓存。
#[tauri::command]
pub async fn list_file_apps(path: String) -> Result<FileAppList, CommandError> {
    let target = validate_file(&path)?;
    let launches_code = editor::launches_code_any(&target);
    tauri::async_runtime::spawn_blocking(move || {
        let (apps, failed) = if launches_code {
            (Vec::new(), false)
        } else {
            match platform::query(&target) {
                Ok(apps) => (apps, false),
                Err(_) => (Vec::new(), true),
            }
        };
        let editor_icons = if apps.is_empty() {
            editor_icons()
        } else {
            EditorIcons::default()
        };
        FileAppList {
            apps,
            launches_code,
            failed,
            editor_icons,
        }
    })
    .await
    .map_err(|e| CommandError::new("io", format!("查询失败：{e}")))
}

/// 校验并拦截会被直接执行的文件类型（`open_file_with_app` 与 `open_file_with_dialog` 共用）。
pub(crate) fn validate_openable_file(path: &str) -> Result<PathBuf, CommandError> {
    let target = validate_file(path)?;
    if editor::launches_code_any(&target) {
        return Err(CommandError::new("app_unavailable", "无法打开此文件"));
    }
    Ok(target)
}

/// 用 `list_file_apps` 给的应用打开文件：重新枚举，按 id 找回处理器再 `Invoke`；
/// VS Code / Cursor 改走 `code -g file:line` 以便跳到行。找不到报 `app_unavailable`。
#[tauri::command]
pub async fn open_file_with_app(
    path: String,
    id: String,
    line: Option<u32>,
) -> Result<(), CommandError> {
    let target = validate_openable_file(&path)?;
    let opened = tauri::async_runtime::spawn_blocking(move || platform::open(&target, &id))
        .await
        .map_err(|e| CommandError::new("io", format!("无法打开此文件：{e}")))??;
    if let Opened::Editor(editor) = opened {
        editor::launch_editor(editor, &path, line)?;
    }
    Ok(())
}

/// 打开 Windows 原生“打开方式”对话框（`SHOpenWithDialog` + `OAIF_EXEC`，ADR-0124）；
/// 沿用路径校验与防误执行保护，用户取消正常返回。
#[tauri::command]
pub async fn open_file_with_dialog(
    window: tauri::Window,
    path: String,
) -> Result<(), CommandError> {
    let target = validate_openable_file(&path)?;
    #[cfg(windows)]
    let owner_hwnd = window.hwnd().ok().map(|hwnd| hwnd.0 as isize);
    #[cfg(not(windows))]
    let owner_hwnd = {
        let _ = window;
        None
    };
    tauri::async_runtime::spawn_blocking(move || platform::open_with_dialog(&target, owner_hwnd))
        .await
        .map_err(|e| CommandError::new("io", format!("无法打开此文件：{e}")))?
}

/// `platform::open` 的结果：已交给系统处理器，或要改由编辑器带行号打开。
#[derive(Debug, PartialEq)]
enum Opened {
    Invoked,
    Editor(&'static str),
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use std::path::Path;

    use super::{EditorIcons, FileApp, Opened};
    use crate::backend::CommandError;

    pub fn query(_path: &Path) -> Result<Vec<FileApp>, CommandError> {
        Err(CommandError::new("unsupported", "此平台不提供系统应用列表"))
    }

    pub fn open(_path: &Path, _id: &str) -> Result<Opened, CommandError> {
        Err(CommandError::new("unsupported", "无法打开此文件"))
    }

    pub fn open_with_dialog(
        _path: &Path,
        _owner_hwnd: Option<isize>,
    ) -> Result<(), CommandError> {
        Err(CommandError::new("unsupported", "此平台不提供系统应用选择器"))
    }

    pub fn editor_icons() -> EditorIcons {
        EditorIcons::default()
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2_app_kit::{NSRunningApplication, NSWorkspace, NSWorkspaceOpenConfiguration};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_core_graphics::{
        CGBitmapContextCreate, CGBitmapInfo, CGColorSpace, CGContext, CGImageAlphaInfo,
        CGInterpolationQuality,
    };
    use objc2_foundation::{
        NSArray, NSBundle, NSError, NSFileManager, NSPoint, NSRect, NSSize, NSString, NSURL,
    };

    use super::{
        app_id, arrange, normalize_key, png_data_url, unpremultiply_rgba, DefaultAssoc,
        EditorIcons, FileApp, Handler, Opened,
    };
    use crate::backend::CommandError;
    use crate::editor;

    const ICON_SIZE: usize = 32;
    const OPEN_TIMEOUT: Duration = Duration::from_secs(15);

    fn display_name(app_path: &str) -> String {
        let ns_path = NSString::from_str(app_path);
        let name = NSFileManager::defaultManager()
            .displayNameAtPath(&ns_path)
            .to_string();
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
        Path::new(app_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(app_path)
            .to_string()
    }

    fn enumerate(path: &Path) -> Result<(Vec<(Handler, Retained<NSURL>)>, DefaultAssoc), CommandError> {
        let ns_path = NSString::from_str(&path.to_string_lossy());
        let file_url = NSURL::fileURLWithPath(&ns_path);
        let ws = NSWorkspace::sharedWorkspace();
        let urls = ws.URLsForApplicationsToOpenURL(&file_url);
        let default_url = ws.URLForApplicationToOpenURL(&file_url);
        let default_path = default_url
            .as_deref()
            .and_then(|u| u.path())
            .map(|p| p.to_string());

        let mut entries: Vec<(Handler, Retained<NSURL>)> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for index in 0..urls.count() {
            let app_url = urls.objectAtIndex(index);
            let Some(app_path) = app_url.path().map(|p| p.to_string()) else {
                continue;
            };
            let norm = normalize_key(&app_path);
            if norm.is_empty() || !seen.insert(norm) {
                continue;
            }
            let handler = Handler {
                name: display_name(&app_path),
                key: app_path,
                prog_id: None,
                icon: None,
            };
            entries.push((handler, app_url));
        }

        // 若系统返回的默认应用不在列表里，补进末尾交由 `arrange` 提到第一项
        if let (Some(app_url), Some(app_path)) = (default_url, default_path.as_ref()) {
            let norm = normalize_key(app_path);
            if !norm.is_empty() && seen.insert(norm) {
                let handler = Handler {
                    name: display_name(app_path),
                    key: app_path.clone(),
                    prog_id: None,
                    icon: None,
                };
                entries.push((handler, app_url));
            }
        }

        let assoc = DefaultAssoc {
            prog_id: None,
            executable: default_path,
        };
        Ok((entries, assoc))
    }

    pub fn query(path: &Path) -> Result<Vec<FileApp>, CommandError> {
        let (entries, assoc) = enumerate(path)?;
        let handlers: Vec<Handler> = entries.into_iter().map(|(h, _)| h).collect();
        let arranged = arrange(handlers, &assoc);
        Ok(arranged
            .into_iter()
            .map(|(handler, is_default)| FileApp {
                id: app_id(&handler.key),
                name: handler.name,
                icon_data_url: icon_for_path(&handler.key),
                is_default,
            })
            .collect())
    }

    pub fn open(path: &Path, id: &str) -> Result<Opened, CommandError> {
        let (entries, _assoc) = enumerate(path)?;
        let Some((_handler, app_url)) = entries
            .into_iter()
            .find(|(handler, _)| app_id(&handler.key) == id)
        else {
            return Err(CommandError::new("app_unavailable", "无法打开此文件"));
        };

        // VS Code / Cursor 走 CLI `-g file:line` 以便跳到行号（前提是找得到命令行可执行文件）
        if let Some(bundle_id) =
            NSBundle::bundleWithURL(&app_url).and_then(|bundle| bundle.bundleIdentifier())
        {
            if let Some((editor_kind, cmd)) =
                editor::macos_editor_for_bundle_id(&bundle_id.to_string())
            {
                if editor::find_editor(cmd).is_some() {
                    return Ok(Opened::Editor(editor_kind));
                }
            }
        }

        let ws = NSWorkspace::sharedWorkspace();
        let ns_path = NSString::from_str(&path.to_string_lossy());
        let file_url = NSURL::fileURLWithPath(&ns_path);
        let urls = NSArray::from_slice(&[&*file_url]);
        let config = NSWorkspaceOpenConfiguration::configuration();
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let handler = RcBlock::new(
            move |_app: *mut NSRunningApplication, error: *mut NSError| {
                let res = if error.is_null() {
                    Ok(())
                } else {
                    // SAFETY: 非空 NSError 指针在回调期间有效。
                    Err(unsafe { &*error }.localizedDescription().to_string())
                };
                let _ = tx.send(res);
            },
        );
        ws.openURLs_withApplicationAtURL_configuration_completionHandler(
            &urls,
            &app_url,
            &config,
            Some(&*handler),
        );
        match rx.recv_timeout(OPEN_TIMEOUT) {
            Ok(Ok(())) => Ok(Opened::Invoked),
            Ok(Err(detail)) => Err(CommandError::new(
                "open_failed",
                format!("无法打开此文件：{detail}"),
            )),
            Err(_) => Err(CommandError::new("open_failed", "打开文件超时")),
        }
    }

    fn icon_for_path(app_path: &str) -> Option<String> {
        let ws = NSWorkspace::sharedWorkspace();
        let ns_path = NSString::from_str(app_path);
        let image = ws.iconForFile(&ns_path);
        let mut rect = NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(ICON_SIZE as f64, ICON_SIZE as f64),
        );
        // SAFETY: `rect` 为有效的栈上 NSRect，context 与 hints 均为 None。
        let cg_image =
            unsafe { image.CGImageForProposedRect_context_hints(&mut rect, None, None) }?;
        let color_space = CGColorSpace::new_device_rgb()?;
        let mut rgba = vec![0u8; ICON_SIZE * ICON_SIZE * 4];
        let bitmap_info = CGImageAlphaInfo::PremultipliedLast.0 | CGBitmapInfo::ByteOrder32Big.0;
        // SAFETY: `rgba` 长度为 ICON_SIZE * ICON_SIZE * 4，在 `ctx` 释放前有效且不重分配。
        let ctx = unsafe {
            CGBitmapContextCreate(
                rgba.as_mut_ptr().cast(),
                ICON_SIZE,
                ICON_SIZE,
                8,
                ICON_SIZE * 4,
                Some(&*color_space),
                bitmap_info,
            )
        }?;
        CGContext::set_interpolation_quality(Some(&*ctx), CGInterpolationQuality::High);
        CGContext::draw_image(
            Some(&*ctx),
            CGRect::new(
                CGPoint::new(0.0, 0.0),
                CGSize::new(ICON_SIZE as f64, ICON_SIZE as f64),
            ),
            Some(&*cg_image),
        );
        drop(ctx);
        unpremultiply_rgba(&mut rgba);
        png_data_url(ICON_SIZE as u32, ICON_SIZE as u32, &rgba)
    }

    fn find_editor_bundle(cmd: &str) -> Option<PathBuf> {
        editor::macos_editor_bundle(cmd).or_else(|| {
            let cli = editor::find_editor(cmd)?;
            let real = std::fs::canonicalize(&cli).unwrap_or(cli);
            editor::macos_app_bundle_ancestor(&real)
        })
    }

    pub fn open_with_dialog(
        _path: &Path,
        _owner_hwnd: Option<isize>,
    ) -> Result<(), CommandError> {
        Err(CommandError::new("unsupported", "此平台不提供系统应用选择器"))
    }

    pub fn editor_icons() -> EditorIcons {
        let read = |cmd: &str| {
            find_editor_bundle(cmd).and_then(|bundle| icon_for_path(&bundle.to_string_lossy()))
        };
        EditorIcons {
            vscode: read("code"),
            cursor: read("cursor"),
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::path::Path;

    use windows::core::{Interface, HSTRING, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{ERROR_CANCELLED, HWND, SIZE};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IDataObject,
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::System::Environment::ExpandEnvironmentStringsW;
    use windows::Win32::UI::Shell::{
        ApplicationAssociationRegistration, AssocQueryStringW, BHID_DataObject,
        IApplicationAssociationRegistration, IAssocHandler, IObjectWithProgID, IShellItem,
        IShellItemImageFactory, SHAssocEnumHandlers, SHCreateItemFromParsingName,
        SHDefExtractIconW, SHLoadIndirectString, SHOpenWithDialog, AL_EFFECTIVE, ASSOCF_NONE,
        ASSOCSTR_EXECUTABLE, ASSOC_FILTER_RECOMMENDED, AT_FILEEXTENSION, OAIF_EXEC, OPENASINFO,
        SIIGBF_THUMBNAILONLY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    use super::{
        app_id, arrange, editor_exe, editor_for_key, png_data_url, DefaultAssoc, EditorIcons,
        FileApp, Handler, Opened,
    };
    use crate::backend::CommandError;
    use crate::editor;

    pub fn editor_icons() -> EditorIcons {
        let read = |cmd: &str| {
            editor::find_editor(cmd)
                .and_then(|command| editor_exe(&command, cmd))
                .and_then(|exe| icon_data_url(&exe.to_string_lossy(), 0))
        };
        EditorIcons {
            vscode: read("code"),
            cursor: read("cursor"),
        }
    }

    const ICON_SIZE: i32 = 32;

    /// 在单独的 STA 线程里做 COM 调用（Shell 关联接口要求 STA），不占用调用方线程的套间。
    fn in_sta<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
        std::thread::Builder::new()
            .name("file-apps".into())
            .spawn(move || {
                let init = unsafe {
                    CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE)
                };
                let out = work();
                if init.is_ok() {
                    unsafe { CoUninitialize() };
                }
                out
            })
            .ok()?
            .join()
            .ok()
    }

    /// 取出 COM 分配的字符串并释放。
    unsafe fn take(text: PWSTR) -> Option<String> {
        if text.is_null() {
            return None;
        }
        let value = unsafe { text.to_string() }.ok();
        unsafe { CoTaskMemFree(Some(text.0 as *const _)) };
        value.filter(|v| !v.trim().is_empty())
    }

    fn extension(path: &Path) -> Option<HSTRING> {
        path.extension()
            .and_then(|e| e.to_str())
            .filter(|e| !e.is_empty())
            .map(|e| HSTRING::from(format!(".{e}")))
    }

    unsafe fn effective_default(ext: &HSTRING) -> DefaultAssoc {
        let registration: Option<IApplicationAssociationRegistration> = unsafe {
            CoCreateInstance(
                &ApplicationAssociationRegistration,
                None,
                CLSCTX_INPROC_SERVER,
            )
        }
        .ok();
        let Some(registration) = registration else {
            return DefaultAssoc::default();
        };
        // AL_EFFECTIVE：Shell 实际会用的关联（UserChoice 写了但没生效的不算）
        let prog_id =
            unsafe { registration.QueryCurrentDefault(ext, AT_FILEEXTENSION, AL_EFFECTIVE) }
                .ok()
                .and_then(|p| unsafe { take(p) });
        let executable = prog_id.as_deref().and_then(|prog_id| {
            let mut buf = vec![0u16; 1024];
            let mut len = buf.len() as u32;
            let hr = unsafe {
                AssocQueryStringW(
                    ASSOCF_NONE,
                    ASSOCSTR_EXECUTABLE,
                    &HSTRING::from(prog_id),
                    PCWSTR::null(),
                    Some(PWSTR(buf.as_mut_ptr())),
                    &mut len,
                )
            };
            hr.is_ok().then(|| from_wide(&buf))
        });
        DefaultAssoc {
            prog_id,
            executable,
        }
    }

    fn from_wide(buf: &[u16]) -> String {
        let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    /// 枚举 `ASSOC_FILTER_RECOMMENDED` 的处理器（就是「打开方式」对话框「建议的应用」一组）。
    unsafe fn enumerate(ext: &HSTRING) -> windows::core::Result<Vec<(Handler, IAssocHandler)>> {
        let handlers = unsafe { SHAssocEnumHandlers(ext, ASSOC_FILTER_RECOMMENDED) }?;
        let mut out = Vec::new();
        loop {
            let mut slot: [Option<IAssocHandler>; 1] = [None];
            let mut fetched = 0u32;
            if unsafe { handlers.Next(&mut slot, Some(std::ptr::from_mut(&mut fetched))) }.is_err()
                || fetched == 0
            {
                break;
            }
            let Some(handler) = slot[0].take() else { break };
            let key = unsafe { handler.GetName() }
                .ok()
                .and_then(|p| unsafe { take(p) });
            let name = unsafe { handler.GetUIName() }
                .ok()
                .and_then(|p| unsafe { take(p) });
            let (Some(key), Some(name)) = (key, name) else {
                continue;
            };
            let mut icon_path = PWSTR::null();
            let mut icon_index = 0i32;
            let icon = unsafe { handler.GetIconLocation(&mut icon_path, &mut icon_index) }
                .ok()
                .and_then(|()| unsafe { take(icon_path) })
                .map(|path| (path, icon_index));
            let prog_id = handler
                .cast::<IObjectWithProgID>()
                .ok()
                .and_then(|o| unsafe { o.GetProgID() }.ok())
                .and_then(|p| unsafe { take(p) });
            out.push((
                Handler {
                    key,
                    name,
                    prog_id,
                    icon,
                },
                handler,
            ));
        }
        Ok(out)
    }

    pub fn query(path: &Path) -> Result<Vec<FileApp>, CommandError> {
        let Some(ext) = extension(path) else {
            return Ok(Vec::new());
        };
        let listed = in_sta(move || -> windows::core::Result<Vec<FileApp>> {
            let assoc = unsafe { effective_default(&ext) };
            let handlers = unsafe { enumerate(&ext) }?;
            let arranged = arrange(handlers.into_iter().map(|(h, _)| h).collect(), &assoc);
            Ok(arranged
                .into_iter()
                .map(|(handler, is_default)| FileApp {
                    id: app_id(&handler.key),
                    icon_data_url: handler
                        .icon
                        .as_ref()
                        .and_then(|(location, index)| icon_in_sta(location, *index)),
                    name: handler.name,
                    is_default,
                })
                .collect())
        })
        .ok_or_else(|| CommandError::new("io", "系统查询失败"))?
        .map_err(|e| CommandError::new("query_failed", format!("系统查询失败：{e}")))?;
        Ok(listed)
    }

    pub fn open(path: &Path, id: &str) -> Result<Opened, CommandError> {
        let unavailable = || CommandError::new("app_unavailable", "无法打开此文件");
        let Some(ext) = extension(path) else {
            return Err(unavailable());
        };
        let path = HSTRING::from(path.as_os_str());
        let id = id.to_string();
        in_sta(move || -> Result<Opened, CommandError> {
            let handlers = unsafe { enumerate(&ext) }.map_err(|_| unavailable())?;
            let Some((found, handler)) = handlers.into_iter().find(|(h, _)| app_id(&h.key) == id)
            else {
                return Err(unavailable());
            };
            if let Some(editor) = editor_for_key(&found.key) {
                return Ok(Opened::Editor(editor));
            }
            let open_failed = |e: windows::core::Error| {
                CommandError::new("open_failed", format!("无法打开此文件：{}", e.message()))
            };
            let item: IShellItem =
                unsafe { SHCreateItemFromParsingName(&path, None) }.map_err(open_failed)?;
            let data: IDataObject =
                unsafe { item.BindToHandler(None, &BHID_DataObject) }.map_err(open_failed)?;
            unsafe { handler.Invoke(&data) }.map_err(open_failed)?;
            Ok(Opened::Invoked)
        })
        .ok_or_else(unavailable)?
    }

    /// 映射 `SHOpenWithDialog` 结果：用户取消（`ERROR_CANCELLED`）视为正常结束。
    pub(crate) fn map_open_with_dialog_result(
        result: windows::core::Result<()>,
    ) -> Result<(), CommandError> {
        match result {
            Ok(()) => Ok(()),
            Err(err) if err.code() == ERROR_CANCELLED.to_hresult() => Ok(()),
            Err(err) => Err(CommandError::new(
                "open_failed",
                format!("无法打开此文件：{}", err.message()),
            )),
        }
    }

    /// 调用 Windows 原生“打开方式”对话框（`SHOpenWithDialog` + `OAIF_EXEC`）。
    pub fn open_with_dialog(path: &Path, owner_hwnd: Option<isize>) -> Result<(), CommandError> {
        let file = HSTRING::from(path.as_os_str());
        in_sta(move || -> Result<(), CommandError> {
            let hwnd = owner_hwnd
                .filter(|raw| *raw != 0)
                .map(|raw| HWND(raw as *mut std::ffi::c_void));
            let info = OPENASINFO {
                pcszFile: PCWSTR::from_raw(file.as_ptr()),
                pcszClass: PCWSTR::null(),
                oaifInFlags: OAIF_EXEC,
            };
            map_open_with_dialog_result(unsafe { SHOpenWithDialog(hwnd, &info) })
        })
        .ok_or_else(|| CommandError::new("io", "无法打开此文件"))?
    }

    /// 间接资源（`@{包名?ms-resource://…}`、`@%SystemRoot%\…,-123`）先让系统解析成路径，
    /// 再展开环境变量；只读本机固定盘上的文件，不碰 UNC 或设备路径。
    fn resolve_location(location: &str) -> Option<String> {
        let mut path = location.trim().to_string();
        if path.starts_with('@') {
            let mut buf = vec![0u16; 2048];
            unsafe { SHLoadIndirectString(&HSTRING::from(path.as_str()), &mut buf, None) }.ok()?;
            path = from_wide(&buf);
        }
        let source = HSTRING::from(path.as_str());
        let needed = unsafe { ExpandEnvironmentStringsW(&source, None) };
        if needed > 0 {
            let mut buf = vec![0u16; needed as usize];
            if unsafe { ExpandEnvironmentStringsW(&source, Some(&mut buf)) } > 0 {
                path = from_wide(&buf);
            }
        }
        let path = path.trim().trim_matches('"').to_string();
        let bytes = path.as_bytes();
        let local = bytes.len() > 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/');
        (local && Path::new(&path).is_file()).then_some(path)
    }

    pub fn icon_data_url(location: &str, index: i32) -> Option<String> {
        let location = location.to_string();
        in_sta(move || icon_in_sta(&location, index)).flatten()
    }

    /// 图标提取本体：调用方已经在 STA 线程里（Shell 解析与缩略图都走 COM）。
    fn icon_in_sta(location: &str, index: i32) -> Option<String> {
        let path = resolve_location(location)?;
        let ext = Path::new(&path)
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        if matches!(
            ext.as_str(),
            "exe" | "dll" | "ico" | "icl" | "cpl" | "ocx" | "mun"
        ) {
            let (w, h, rgba) = unsafe { extract_icon(&path, index) }?;
            return png_data_url(w, h, &rgba);
        }
        // 打包应用给的是包里的 PNG：让 Shell 出缩略图（按比例缩到 32 以内）
        let (w, h, rgba) = unsafe { thumbnail(&path) }?;
        png_data_url(w, h, &rgba)
    }

    unsafe fn extract_icon(path: &str, index: i32) -> Option<(u32, u32, Vec<u8>)> {
        let mut large = HICON::default();
        let size = ICON_SIZE as u32;
        // 负索引是资源 ID，由系统按同样规则处理
        let hr = unsafe {
            SHDefExtractIconW(
                &HSTRING::from(path),
                index,
                0,
                Some(std::ptr::from_mut(&mut large)),
                None,
                size,
            )
        };
        if hr.is_err() || hr.0 != 0 || large.is_invalid() {
            return None;
        }
        let pixels = unsafe { icon_pixels(large) };
        let _ = unsafe { DestroyIcon(large) };
        pixels
    }

    /// HICON → 自上而下的 RGBA（直通 alpha）。老式无 alpha 图标用掩码补透明。
    unsafe fn icon_pixels(icon: HICON) -> Option<(u32, u32, Vec<u8>)> {
        let mut info = ICONINFO::default();
        unsafe { GetIconInfo(icon, &mut info) }.ok()?;
        let result = (|| {
            if info.hbmColor.is_invalid() {
                return None;
            }
            let (w, h) = unsafe { bitmap_size(info.hbmColor) }?;
            let mut bgra = unsafe { dib_bits(info.hbmColor, w, h) }?;
            if bgra.chunks_exact(4).all(|px| px[3] == 0) {
                let mask = unsafe { dib_bits(info.hbmMask, w, h) }?;
                for (px, m) in bgra.chunks_exact_mut(4).zip(mask.chunks_exact(4)) {
                    px[3] = if m[0] == 0 { 255 } else { 0 };
                }
            }
            Some((w as u32, h as u32, bgra_to_rgba(bgra, false)))
        })();
        unsafe {
            if !info.hbmColor.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(info.hbmColor.0));
            }
            if !info.hbmMask.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(info.hbmMask.0));
            }
        }
        result
    }

    unsafe fn thumbnail(path: &str) -> Option<(u32, u32, Vec<u8>)> {
        let factory: IShellItemImageFactory =
            unsafe { SHCreateItemFromParsingName(&HSTRING::from(path), None) }.ok()?;
        let bitmap = unsafe {
            factory.GetImage(
                SIZE {
                    cx: ICON_SIZE,
                    cy: ICON_SIZE,
                },
                SIIGBF_THUMBNAILONLY,
            )
        }
        .ok()?;
        let result = (|| {
            let (w, h) = unsafe { bitmap_size(bitmap) }?;
            let bgra = unsafe { dib_bits(bitmap, w, h) }?;
            // Shell 缩略图是预乘 alpha，PNG 要直通 alpha
            Some((w as u32, h as u32, bgra_to_rgba(bgra, true)))
        })();
        let _ = unsafe { DeleteObject(HGDIOBJ(bitmap.0)) };
        result
    }

    unsafe fn bitmap_size(bitmap: HBITMAP) -> Option<(i32, i32)> {
        let mut info = BITMAP::default();
        let read = unsafe {
            GetObjectW(
                HGDIOBJ(bitmap.0),
                std::mem::size_of::<BITMAP>() as i32,
                Some(std::ptr::from_mut(&mut info).cast()),
            )
        };
        (read > 0 && info.bmWidth > 0 && info.bmHeight != 0 && info.bmWidth <= 256)
            .then(|| (info.bmWidth, info.bmHeight.abs().min(256)))
    }

    unsafe fn dib_bits(bitmap: HBITMAP, w: i32, h: i32) -> Option<Vec<u8>> {
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let dc = unsafe { CreateCompatibleDC(None) };
        let lines = unsafe {
            GetDIBits(
                dc,
                bitmap,
                0,
                h as u32,
                Some(buf.as_mut_ptr().cast()),
                &mut info,
                DIB_RGB_COLORS,
            )
        };
        let _ = unsafe { DeleteDC(dc) };
        (lines == h).then_some(buf)
    }

    fn bgra_to_rgba(mut px: Vec<u8>, premultiplied: bool) -> Vec<u8> {
        for chunk in px.chunks_exact_mut(4) {
            let (b, g, r, a) = (chunk[0], chunk[1], chunk[2], chunk[3]);
            let un = |c: u8| -> u8 {
                if premultiplied && a > 0 && a < 255 {
                    ((u16::from(c) * 255 + u16::from(a) / 2) / u16::from(a)).min(255) as u8
                } else {
                    c
                }
            };
            chunk[0] = un(r);
            chunk[1] = un(g);
            chunk[2] = un(b);
            chunk[3] = a;
        }
        px
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handler(key: &str, name: &str, prog_id: Option<&str>) -> Handler {
        Handler {
            key: key.into(),
            name: name.into(),
            prog_id: prog_id.map(Into::into),
            icon: None,
        }
    }

    #[test]
    fn app_id_is_stable_and_hides_the_key() {
        #[cfg(windows)]
        let (left, same, other) = (
            r"C:\Program Files\App\App.exe",
            "c:/program files/app/APP.EXE ",
            r"C:\Program Files\Other\Other.exe",
        );
        #[cfg(not(windows))]
        let (left, same, other) = (
            "/Applications/Visual Studio Code.app",
            "/applications/visual studio code.app/ ",
            "/Applications/Cursor.app",
        );
        let a = app_id(left);
        assert_eq!(a, app_id(same));
        assert_ne!(a, app_id(other));
        assert!(a.starts_with("app-") && a.len() == 20, "{a}");
        assert!(!a.to_lowercase().contains("program"));
        assert!(!a.to_lowercase().contains("applications"));
    }

    #[test]
    fn arrange_dedupes_and_puts_default_first() {
        let handlers = vec![
            handler(r"C:\A\Code.exe", "Visual Studio Code", Some("VSCode.cjs")),
            handler(
                r"C:\B\Antigravity.exe",
                "Antigravity",
                Some("Antigravity.cjs"),
            ),
            handler(r"c:\a\code.exe", "Visual Studio Code", None),
            handler(r"C:\C\Notepad.exe", "记事本", None),
        ];
        let assoc = DefaultAssoc {
            prog_id: Some("antigravity.CJS".into()),
            executable: None,
        };
        let list = arrange(handlers, &assoc);
        let names: Vec<&str> = list.iter().map(|(h, _)| h.name.as_str()).collect();
        assert_eq!(names, ["Antigravity", "Visual Studio Code", "记事本"]);
        assert_eq!(
            list.iter().map(|(_, d)| *d).collect::<Vec<_>>(),
            [true, false, false]
        );
    }

    #[test]
    fn arrange_keeps_system_order_without_default() {
        let handlers = vec![
            handler("B", "Second", None),
            handler("A", "First", None),
            handler(" ", "Blank key", None),
            handler("C", " ", None),
        ];
        let list = arrange(handlers, &DefaultAssoc::default());
        let names: Vec<&str> = list.iter().map(|(h, _)| h.name.as_str()).collect();
        assert_eq!(names, ["Second", "First"]);
        assert!(list.iter().all(|(_, d)| !d));
    }

    #[test]
    fn default_falls_back_to_executable_and_refuses_ambiguity() {
        #[cfg(windows)]
        let (a_key, b_key, b_query, b_norm) = (
            r"C:\A\Code.exe",
            r"C:\B\Other.exe",
            "c:/b/other.exe",
            r"c:\b\other.exe",
        );
        #[cfg(not(windows))]
        let (a_key, b_key, b_query, b_norm) = (
            "/Applications/Visual Studio Code.app",
            "/Applications/TextEdit.app",
            "/applications/textedit.app/",
            "/applications/textedit.app",
        );
        let handlers = vec![
            handler(a_key, "Visual Studio Code", Some("Shared")),
            handler(b_key, "Other", Some("Shared")),
        ];
        // ProgID 对上两个 → 不唯一，退到可执行文件 / 应用包路径比对
        let assoc = DefaultAssoc {
            prog_id: Some("Shared".into()),
            executable: Some(b_query.into()),
        };
        assert_eq!(default_key(&handlers, &assoc).as_deref(), Some(b_norm));
        // 都比不出唯一结果就不标
        let assoc = DefaultAssoc {
            prog_id: Some("Shared".into()),
            executable: None,
        };
        assert_eq!(default_key(&handlers, &assoc), None);
    }

    #[test]
    fn validate_file_rejects_relative_unc_directory_and_missing() {
        let dir = std::env::temp_dir().join(format!("nct-file-apps-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.cjs");
        std::fs::write(&file, "x").unwrap();
        assert!(validate_file(&file.to_string_lossy()).is_ok());
        assert_eq!(validate_file("a/b.ts").unwrap_err().code, "invalid_path");
        assert_eq!(
            validate_file(r"\\server\share\a.ts").unwrap_err().code,
            "invalid_path"
        );
        assert_eq!(validate_file("").unwrap_err().code, "invalid_path");
        assert_eq!(
            validate_file(&dir.to_string_lossy()).unwrap_err().code,
            "is_directory"
        );
        assert_eq!(
            validate_file(&dir.join("missing.ts").to_string_lossy())
                .unwrap_err()
                .code,
            "not_found"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn scripts_get_no_system_apps() {
        let dir = std::env::temp_dir().join(format!("nct-file-apps-s-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        #[cfg(target_os = "macos")]
        let names = ["run.command", "tool.tool", "x.terminal"];
        #[cfg(not(target_os = "macos"))]
        let names = ["run.ps1", "tool.py", "x.bat"];
        for name in names {
            let file = dir.join(name);
            std::fs::write(&file, "x").unwrap();
            let list =
                tauri::async_runtime::block_on(list_file_apps(file.to_string_lossy().into()))
                    .unwrap();
            assert!(list.launches_code, "{name}");
            assert!(list.apps.is_empty(), "{name}");
            assert!(!list.failed, "{name}");
            let opened = tauri::async_runtime::block_on(open_file_with_app(
                file.to_string_lossy().into(),
                "app-0000000000000000".into(),
                None,
            ));
            assert_eq!(opened.unwrap_err().code, "app_unavailable", "{name}");
            // 原生选择器入口（open_file_with_dialog）复用同一路径与可执行保护
            assert_eq!(
                validate_openable_file(&file.to_string_lossy())
                    .unwrap_err()
                    .code,
                "app_unavailable",
                "{name}"
            );
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn validate_openable_file_enforces_same_path_rules_for_dialog_and_open() {
        let dir =
            std::env::temp_dir().join(format!("nct-file-apps-openable-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("note.txt");
        std::fs::write(&file, "hello").unwrap();
        assert!(validate_openable_file(&file.to_string_lossy()).is_ok());
        assert_eq!(
            validate_openable_file("relative/note.txt").unwrap_err().code,
            "invalid_path"
        );
        assert_eq!(
            validate_openable_file(r"\\server\share\note.txt")
                .unwrap_err()
                .code,
            "invalid_path"
        );
        assert_eq!(
            validate_openable_file(&dir.to_string_lossy())
                .unwrap_err()
                .code,
            "is_directory"
        );
        assert_eq!(
            validate_openable_file(&dir.join("missing.txt").to_string_lossy())
                .unwrap_err()
                .code,
            "not_found"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn map_open_with_dialog_treats_cancel_as_ok_and_other_errors_as_open_failed() {
        use windows::Win32::Foundation::{ERROR_CANCELLED, E_FAIL};
        assert!(platform::map_open_with_dialog_result(Ok(())).is_ok());
        let cancelled = windows::core::Error::from_hresult(ERROR_CANCELLED.to_hresult());
        assert!(platform::map_open_with_dialog_result(Err(cancelled)).is_ok());
        let failed = windows::core::Error::from_hresult(E_FAIL);
        assert_eq!(
            platform::map_open_with_dialog_result(Err(failed))
                .unwrap_err()
                .code,
            "open_failed"
        );
    }

    #[cfg(windows)]
    #[test]
    fn editor_exe_walks_up_from_the_cli_shim() {
        let root = std::env::temp_dir().join(format!("nct-editor-exe-{}", std::process::id()));
        let bin = root.join("Microsoft VS Code").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let shim = bin.join("code.cmd");
        std::fs::write(&shim, "").unwrap();
        assert_eq!(editor_exe(&shim, "code"), None);
        let exe = root.join("Microsoft VS Code").join("Code.exe");
        std::fs::write(&exe, "").unwrap();
        let found = editor_exe(&shim, "code").unwrap();
        assert!(same_file(&found, &exe), "{}", found.display());
        assert!(same_file(&editor_exe(&exe, "code").unwrap(), &exe));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn unpremultiply_rgba_restores_straight_alpha() {
        let mut px = vec![
            128, 64, 0, 128, // 半透明：预乘 128 → 直通 255，64 → 128
            0, 0, 0, 0, // 全透明保持 0
            10, 20, 30, 255, // 全不透明不变
        ];
        unpremultiply_rgba(&mut px);
        assert_eq!(px, vec![255, 128, 0, 128, 0, 0, 0, 0, 10, 20, 30, 255]);
    }

    #[test]
    fn png_data_url_encodes_rgba() {
        let rgba = vec![255u8; 2 * 2 * 4];
        let url = png_data_url(2, 2, &rgba).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(url.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        assert!(png_data_url(2, 2, &rgba[..4]).is_none());
    }
}
