//! Node.js 查找与版本检查（ADR-0046 第 2 节）。
//! 顺序：NOCTURNE_NODE → 资源目录随附 node → PATH；找到后跑 `node --version` 校验 ≥ 24.14。

use serde::Serialize;
use std::env;
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub const REQUIRED_NODE: (u64, u64, u64) = (24, 14, 0);
pub const REQUIRED_NODE_STR: &str = "24.14.0";
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NodeSource {
    Env,
    Bundled,
    Path,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StepStatus {
    Unset,
    NotBundled,
    Missing,
    Found,
    Skipped,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeProbeStep {
    pub source: NodeSource,
    pub status: StepStatus,
    pub path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedNode {
    pub source: NodeSource,
    pub path: String,
    pub version: Option<String>,
    pub error: Option<String>,
}

impl SelectedNode {
    /// 后台日志行里的来源描述，如 `bundled：C:\...\node.exe（v24.21.0）`。
    /// 来源标签与序列化的 kebab-case 一致，便于和探测页对照。
    pub fn describe(&self) -> String {
        let source = match self.source {
            NodeSource::Env => "env",
            NodeSource::Bundled => "bundled",
            NodeSource::Path => "path",
        };
        format!(
            "{source}：{}（{}）",
            self.path,
            self.version.as_deref().unwrap_or("未知版本")
        )
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeProbe {
    pub required: String,
    pub steps: Vec<NodeProbeStep>,
    pub selected: Option<SelectedNode>,
    pub ok: bool,
}

fn step(source: NodeSource, status: StepStatus, path: Option<PathBuf>) -> NodeProbeStep {
    NodeProbeStep {
        source,
        status,
        path: path.map(|p| p.to_string_lossy().into_owned()),
    }
}

fn node_exe_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

/// 资源目录里的随附 Node：发布构建由 scripts/fetch-node.mjs 放进
/// resources/node/，版本固定在 scripts/node-version.json（ADR-0050）。
pub fn bundled_node_path(resource_dir: &Path) -> PathBuf {
    resource_dir.join("node").join(node_exe_name())
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.is_file()
        && std::fs::metadata(path)
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

fn find_on_path() -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    for dir in env::split_paths(&path_var) {
        let candidate = dir.join(node_exe_name());
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// 解析 `node --version` 的输出（`v24.14.0`、`24.15.0`、`-`/`+` 后缀忽略）。
pub fn parse_node_version(text: &str) -> Option<(u64, u64, u64)> {
    let text = text.trim();
    let text = text.strip_prefix('v').unwrap_or(text);
    let end = text.find(['-', '+']).unwrap_or(text.len());
    let core = &text[..end];
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let mut nums = [0u64; 3];
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        nums[i] = part.parse().ok()?;
    }
    Some((nums[0], nums[1], nums[2]))
}

pub fn satisfies(version: (u64, u64, u64)) -> bool {
    version >= REQUIRED_NODE
}

/// 构造执行 `program args...` 的命令；Windows 上加 CREATE_NO_WINDOW 防止弹控制台窗口。
/// `.cmd`/`.bat` 不用手工包 cmd /c：Rust ≥1.77 的 std 在 Windows 上会自动经 cmd.exe
/// 执行脚本并对命令行做安全转义（参数里的空格与引号由 std 处理）。
pub fn program_command(program: &Path, args: &[&OsStr]) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// 等待子进程退出（带超时）；超时后强杀并继续等它结束。
pub fn wait_with_timeout(child: &mut Child, timeout: Duration) -> std::io::Result<bool> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(_status) = child.try_wait()? {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(false);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// 跑 `<node> --version`（5 秒超时），返回 stdout 第一行（trim 后）。
pub fn run_node_version(node: &Path) -> Result<String, String> {
    let mut child = program_command(node, &[OsStr::new("--version")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("无法启动 {}：{e}", node.display()))?;

    if !wait_with_timeout(&mut child, VERSION_TIMEOUT)
        .map_err(|e| format!("无法运行 node --version：{e}"))?
    {
        return Err("node --version 运行超时".into());
    }
    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut out);
    }
    let first = out.lines().next().unwrap_or("").trim().to_string();
    if first.is_empty() {
        return Err("node --version 没有输出".into());
    }
    Ok(first)
}

/// 完整探测：env → bundled → PATH，返回固定 3 步的 NodeProbe。
pub fn probe_node(resource_dir: &Path) -> NodeProbe {
    let mut steps = Vec::with_capacity(3);
    let mut found: Option<(NodeSource, PathBuf)> = None;
    // stop 为 true 时后续步骤记 skipped（已选中或 env 指定了不存在的文件）
    let mut stop = false;

    // ① NOCTURNE_NODE
    match env::var("NOCTURNE_NODE") {
        Ok(value) if !value.trim().is_empty() => {
            let path = PathBuf::from(value.trim());
            if path.is_file() {
                steps.push(step(NodeSource::Env, StepStatus::Found, Some(path.clone())));
                found = Some((NodeSource::Env, path));
            } else {
                steps.push(step(NodeSource::Env, StepStatus::Missing, Some(path)));
            }
            stop = true;
        }
        _ => steps.push(step(NodeSource::Env, StepStatus::Unset, None)),
    }

    // ② 资源目录随附 Node（安装包内置；开发构建没有时落到 PATH）
    let bundled = bundled_node_path(resource_dir);
    if stop {
        steps.push(step(NodeSource::Bundled, StepStatus::Skipped, None));
    } else if bundled.is_file() {
        steps.push(step(
            NodeSource::Bundled,
            StepStatus::Found,
            Some(bundled.clone()),
        ));
        found = Some((NodeSource::Bundled, bundled));
        stop = true;
    } else {
        steps.push(step(
            NodeSource::Bundled,
            StepStatus::NotBundled,
            Some(bundled),
        ));
    }

    // ③ PATH
    if stop {
        steps.push(step(NodeSource::Path, StepStatus::Skipped, None));
    } else {
        match find_on_path() {
            Some(path) => {
                steps.push(step(NodeSource::Path, StepStatus::Found, Some(path.clone())));
                found = Some((NodeSource::Path, path));
            }
            None => steps.push(step(NodeSource::Path, StepStatus::Missing, None)),
        }
    }

    let selected = found.map(|(source, path)| {
        let mut sel = SelectedNode {
            source,
            path: path.to_string_lossy().into_owned(),
            version: None,
            error: None,
        };
        match run_node_version(&path) {
            Ok(version) => {
                if parse_node_version(&version).is_none() {
                    sel.error = Some(format!("无法解析版本输出：{version}"));
                } else {
                    sel.version = Some(version);
                }
            }
            Err(error) => sel.error = Some(error),
        }
        sel
    });

    let ok = selected
        .as_ref()
        .and_then(|s| s.version.as_deref())
        .and_then(parse_node_version)
        .map(satisfies)
        .unwrap_or(false);

    NodeProbe {
        required: REQUIRED_NODE_STR.into(),
        steps,
        selected,
        ok,
    }
}

/// Windows 上 Tauri 的 `resource_dir()` 来自 `canonicalize`，返回 `\\?\` 前缀的
/// verbatim 路径。子进程不能统一处理这种形式（Node 解析 `\\?\Z:\x.mjs` 时会退化成
/// `lstat 'Z:'` 直接 EISDIR 退出），所以在进 AppState 前剥掉前缀还原普通路径。
/// `\\?\UNC\server\share` 对应 `\\server\share`；其余 `\\?\X:\…` 去掉 4 字符前缀。
pub fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(text) = path.as_os_str().to_str() {
            if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
                return PathBuf::from(format!(r"\\{rest}"));
            }
            if let Some(rest) = text.strip_prefix(r"\\?\") {
                // 只剥形如 \\?\X:\… 的：剥完是带盘符的绝对路径；
                // \\?\Z:（无反斜杠）剥完会退化成盘相对路径，保持原样更安全
                let b = rest.as_bytes();
                if b.len() >= 3
                    && b[0].is_ascii_alphabetic()
                    && b[1] == b':'
                    && b[2] == b'\\'
                {
                    return PathBuf::from(rest);
                }
            }
        }
    }
    path
}

/// 后台脚本：`NOCTURNE_DESKTOP_BACKEND` > debug 构建用仓库内 cli/dist/main.js > release 用资源目录 nctrn.mjs。
pub fn backend_script(resource_dir: &Path) -> PathBuf {
    if let Ok(value) = env::var("NOCTURNE_DESKTOP_BACKEND") {
        if !value.trim().is_empty() {
            return PathBuf::from(value.trim());
        }
    }
    if cfg!(debug_assertions) {
        normalize_path(&PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../cli/dist/main.js"
        )))
    } else {
        resource_dir.join("nctrn.mjs")
    }
}

/// 词法规范化：消掉 `.` 与 `..`（`CARGO_MANIFEST_DIR` 是绝对路径，不会越出根）。
fn normalize_path(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions() {
        assert_eq!(parse_node_version("v24.14.0"), Some((24, 14, 0)));
        assert_eq!(parse_node_version("24.15.0"), Some((24, 15, 0)));
        assert_eq!(
            parse_node_version("v25.0.0-nightly20260101"),
            Some((25, 0, 0))
        );
        assert_eq!(parse_node_version("v24.14.0+build1"), Some((24, 14, 0)));
        assert_eq!(parse_node_version("garbage"), None);
        assert_eq!(parse_node_version(""), None);
        assert_eq!(parse_node_version("v24.14"), None);
    }

    #[test]
    fn satisfies_required() {
        assert!(satisfies((24, 14, 0)));
        assert!(!satisfies((24, 13, 9)));
        assert!(satisfies((25, 0, 0)));
        assert!(!satisfies((22, 11, 0)));
    }

    #[test]
    fn describes_selected_source() {
        let bundled = SelectedNode {
            source: NodeSource::Bundled,
            path: r"C:\app\node\node.exe".into(),
            version: Some("v24.21.0".into()),
            error: None,
        };
        assert_eq!(bundled.describe(), r"bundled：C:\app\node\node.exe（v24.21.0）");
        let missing_version = SelectedNode {
            source: NodeSource::Path,
            path: "node".into(),
            version: None,
            error: None,
        };
        assert!(missing_version.describe().starts_with("path：node（未知版本"));
    }

    /// resource_dir() 经 canonicalize 返回 \\?\ verbatim 路径，
    /// 传给子进程前要还原成普通形式（Node 不认 \\?\Z:\…）。
    #[cfg(windows)]
    #[test]
    fn strips_verbatim_prefix() {
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"\\?\Z:\app\nctrn.mjs")),
            PathBuf::from(r"Z:\app\nctrn.mjs")
        );
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"\\?\UNC\server\share\x")),
            PathBuf::from(r"\\server\share\x")
        );
        // 无反斜杠的盘根剥完是盘相对路径，不剥
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"\\?\Z:")),
            PathBuf::from(r"\\?\Z:")
        );
        // 普通路径原样返回
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"Z:\app\nctrn.mjs")),
            PathBuf::from(r"Z:\app\nctrn.mjs")
        );
    }

    /// Windows：`.cmd` 脚本经 std 自动的 cmd.exe 包装执行，
    /// 路径含空格、参数含空格都要原样到达。
    #[cfg(windows)]
    #[test]
    fn cmd_script_version_and_arg_forwarding() {
        let dir = std::env::temp_dir().join(format!("nocturne desktop test {}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        // 假 node.cmd：run_node_version 拿到 --version 输出
        let fake_node = dir.join("fake node.cmd");
        std::fs::write(&fake_node, "@echo off\r\n@echo v22.11.0\r\n").unwrap();
        assert_eq!(run_node_version(&fake_node), Ok("v22.11.0".into()));

        // @echo %*：断言参数原样到达（含空格的参数完整、不被拆散或吃掉）
        let echo_args = dir.join("echo args.cmd");
        std::fs::write(&echo_args, "@echo off\r\n@echo %*\r\n").unwrap();
        let out = program_command(
            &echo_args,
            &[
                OsStr::new("C:\\some dir\\main.js"),
                OsStr::new("rpc"),
                OsStr::new("--stdio"),
            ],
        )
        .stdout(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut c| {
            let mut buf = String::new();
            c.stdout.take().unwrap().read_to_string(&mut buf)?;
            c.wait()?;
            Ok(buf)
        })
        .unwrap();
        let line = out.trim();
        assert!(line.contains("C:\\some dir\\main.js"), "参数丢失或被拆散: {line}");
        assert!(line.contains("rpc"), "输出: {line}");
        assert!(line.contains("--stdio"), "输出: {line}");

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
