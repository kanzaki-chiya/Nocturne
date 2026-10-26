//! 面板浏览器的网页全屏（desktop.md 5.10）。tauri-runtime-wry 在网页进出全屏时只把整个
//! 窗口切成全屏，不动子 webview 的尺寸；全屏元素按 webview 自己的大小显示，所以子
//! webview 要由我们扩到整个窗口，退出时回到面板。这里只做取舍，全是纯函数；browser.rs
//! 负责把结果接到 webview 上。

/// 下一步要对 webview 做的事。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Step<B> {
    None,
    /// 放回面板（`Some`）或隐藏（`None`）
    Apply(Option<B>),
    /// 铺满主窗口客户区并放到最上层
    FillWindow,
    /// 让网页退出全屏（之后网页的退出事件把它放回或隐藏）
    ExitPage,
}

/// 一个浏览器标签的全屏状态与最后一次面板位置。
#[derive(Debug, Clone, Copy)]
pub struct Fullscreen<B> {
    on: bool,
    /// 前端最后要的位置；`None` = 隐藏
    panel: Option<B>,
}

impl<B: Copy> Fullscreen<B> {
    pub fn new(panel: Option<B>) -> Self {
        Self { on: false, panel }
    }

    pub fn active(&self) -> bool {
        self.on
    }

    /// 前端发来 `browser_layout`：全屏期间只记下，不生效；要隐藏就先让网页退出全屏。
    pub fn layout(&mut self, panel: Option<B>) -> Step<B> {
        self.panel = panel;
        match (self.on, panel) {
            (false, _) => Step::Apply(panel),
            (true, Some(_)) => Step::None,
            (true, None) => Step::ExitPage,
        }
    }

    /// 网页进出全屏（`ContainsFullScreenElementChanged`）。
    pub fn changed(&mut self, on: bool) -> Step<B> {
        if on == self.on {
            return if on { Step::FillWindow } else { Step::None };
        }
        self.on = on;
        match (on, self.panel) {
            // 隐藏着的网页不该全屏：直接让它退出
            (true, None) => Step::ExitPage,
            (true, Some(_)) => Step::FillWindow,
            (false, panel) => Step::Apply(panel),
        }
    }

    /// 主窗口尺寸变了（切到全屏是异步的，尺寸稍后才变）：全屏中跟着铺满。
    pub fn resized(&self) -> Step<B> {
        if self.on {
            Step::FillWindow
        } else {
            Step::None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: (i32, i32) = (1, 1);
    const B: (i32, i32) = (2, 2);

    #[test]
    fn layout_applies_when_not_fullscreen() {
        let mut fs = Fullscreen::new(Some(A));
        assert_eq!(fs.layout(Some(B)), Step::Apply(Some(B)));
        assert_eq!(fs.layout(None), Step::Apply(None));
        assert_eq!(fs.resized(), Step::None);
        assert!(!fs.active());
    }

    #[test]
    fn enter_fills_and_follows_resize() {
        let mut fs = Fullscreen::new(Some(A));
        assert_eq!(fs.changed(true), Step::FillWindow);
        assert!(fs.active());
        assert_eq!(fs.resized(), Step::FillWindow);
        // 重复的进入事件也只是再铺一次
        assert_eq!(fs.changed(true), Step::FillWindow);
    }

    #[test]
    fn layout_during_fullscreen_is_remembered_and_restored_on_exit() {
        let mut fs = Fullscreen::new(Some(A));
        fs.changed(true);
        assert_eq!(fs.layout(Some(B)), Step::None);
        assert_eq!(fs.changed(false), Step::Apply(Some(B)));
        assert!(!fs.active());
        assert_eq!(fs.changed(false), Step::None);
    }

    #[test]
    fn hide_during_fullscreen_exits_page_then_stays_hidden() {
        let mut fs = Fullscreen::new(Some(A));
        fs.changed(true);
        assert_eq!(fs.layout(None), Step::ExitPage);
        // 退出前面板又要显示：退出时回到最新位置
        assert_eq!(fs.layout(Some(B)), Step::None);
        assert_eq!(fs.layout(None), Step::ExitPage);
        assert_eq!(fs.changed(false), Step::Apply(None));
    }

    #[test]
    fn hidden_page_entering_fullscreen_is_sent_back() {
        let mut fs: Fullscreen<(i32, i32)> = Fullscreen::new(None);
        assert_eq!(fs.changed(true), Step::ExitPage);
        assert_eq!(fs.changed(false), Step::Apply(None));
    }
}
