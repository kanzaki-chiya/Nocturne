//! 普通对话工作区（ADR-0046 修订第 1 条）：`<NOCTURNE_HOME>/workspace`，
//! 不属于任何项目的会话归到左栏「对话」分区。目录由外壳创建，前端只拿到路径。

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// 解析 NOCTURNE_HOME，规则与 Core `nocturneHome()`（platform.ts）一致：
/// `NOCTURNE_HOME` 存在且非空（不 trim）→ 解析成绝对路径（相对路径相对 `cwd`）；
/// 否则 `<home>/.nocturne`；home 也拿不到 → None。
/// `env` 传 `env::var_os("NOCTURNE_HOME")` 的结果，`home` 传 `env::home_dir().ok()`。
pub fn resolve_nocturne_home(
    env: Option<OsString>,
    home: Option<PathBuf>,
    cwd: &Path,
) -> Option<PathBuf> {
    if let Some(value) = env {
        if !value.is_empty() {
            let path = PathBuf::from(value);
            return Some(if path.is_absolute() {
                path
            } else {
                // 与 std::path::absolute 等价：相对路径拼到 cwd 上（不规范化 ..、不加 \\?\ 前缀）
                cwd.join(path)
            });
        }
    }
    home.map(|h| h.join(".nocturne"))
}

/// `<nocturne_home>/workspace`。
pub fn plain_workspace_path(nocturne_home: &Path) -> PathBuf {
    nocturne_home.join("workspace")
}

/// 递归创建目录；POSIX 上新建的目录用 0700（与 Core 创建 NOCTURNE_HOME 一致；
/// mode 只作用于本次新建的目录，已有目录权限不动）。路径存在但不是目录时返回错误。
pub fn ensure_dir(path: &Path) -> std::io::Result<()> {
    if path.exists() {
        if path.is_dir() {
            return Ok(());
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotADirectory,
            format!("{} 已存在但不是目录", path.display()),
        ));
    }
    ensure_dir_impl(path)
}

#[cfg(unix)]
fn ensure_dir_impl(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
}

#[cfg(not(unix))]
fn ensure_dir_impl(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(s: &str) -> Option<OsString> {
        Some(OsString::from(s))
    }

    #[test]
    fn env_absolute_path() {
        let home = PathBuf::from(if cfg!(windows) { "C:\\home" } else { "/home/u" });
        let cwd = Path::new(if cfg!(windows) { "Z:\\repo" } else { "/repo" });
        assert_eq!(
            resolve_nocturne_home(os("D:\\data"), Some(home), cwd),
            Some(PathBuf::from("D:\\data"))
        );
    }

    #[test]
    fn env_relative_resolves_against_cwd() {
        let cwd = PathBuf::from(if cfg!(windows) { "Z:\\repo" } else { "/repo" });
        assert_eq!(
            resolve_nocturne_home(os("data"), None, &cwd),
            Some(cwd.join("data"))
        );
    }

    #[test]
    fn env_empty_falls_back_to_home() {
        let home = PathBuf::from(if cfg!(windows) { "C:\\home" } else { "/home/u" });
        assert_eq!(
            resolve_nocturne_home(os(""), Some(home.clone()), Path::new(".")),
            Some(home.join(".nocturne"))
        );
    }

    #[test]
    fn env_unset_uses_home() {
        let home = PathBuf::from(if cfg!(windows) { "C:\\home" } else { "/home/u" });
        assert_eq!(
            resolve_nocturne_home(None, Some(home.clone()), Path::new(".")),
            Some(home.join(".nocturne"))
        );
    }

    #[test]
    fn no_home_returns_none() {
        assert_eq!(resolve_nocturne_home(None, None, Path::new(".")), None);
    }

    #[test]
    fn workspace_is_home_workspace() {
        let home = PathBuf::from(if cfg!(windows) { "C:\\h" } else { "/h" });
        assert_eq!(
            plain_workspace_path(&home),
            home.join("workspace")
        );
    }

    #[test]
    fn ensure_dir_creates_nested_and_is_idempotent() {
        let base = std::env::temp_dir().join(format!(
            "nocturne-ws-test-{}-{}",
            std::process::id(),
            "nested"
        ));
        let target = base.join("a").join("b").join("workspace");
        ensure_dir(&target).unwrap();
        ensure_dir(&target).unwrap(); // 幂等
        assert!(target.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn ensure_dir_on_file_fails() {
        let base = std::env::temp_dir().join(format!(
            "nocturne-ws-test-{}-file",
            std::process::id()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let file = base.join("workspace");
        std::fs::write(&file, "x").unwrap();
        assert!(ensure_dir(&file).is_err());
        std::fs::remove_dir_all(&base).unwrap();
    }
}
