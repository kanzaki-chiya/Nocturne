//! 按行切分：跨 chunk 拼接半行、去 `\r`、丢空行、非 UTF-8 lossy、超长行丢弃。

/// 切分结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Split {
    /// 完整一行（已去行尾 `\r`，已做 lossy UTF-8 转换）
    Line(String),
    /// 一整行超过上限：内容被丢弃，`bytes` 是该行的总字节数（不含 `\n`）
    Overlong { bytes: usize },
}

pub struct LineSplitter {
    max_line_bytes: usize,
    /// 当前未结束的半行
    buf: Vec<u8>,
    /// 处于丢弃模式时已计入的字节数；None 表示正常累积
    overlong: Option<usize>,
}

impl LineSplitter {
    pub fn new(max_line_bytes: usize) -> Self {
        Self {
            max_line_bytes,
            buf: Vec::new(),
            overlong: None,
        }
    }

    /// 喂入一个 chunk，返回本次切出的完整行与超长行标记。
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Split> {
        let mut out = Vec::new();
        for &b in chunk {
            if b == b'\n' {
                if let Some(bytes) = self.overlong.take() {
                    out.push(Split::Overlong { bytes });
                } else {
                    if self.buf.last() == Some(&b'\r') {
                        self.buf.pop();
                    }
                    if !self.buf.is_empty() {
                        out.push(Split::Line(
                            String::from_utf8_lossy(&self.buf).into_owned(),
                        ));
                    }
                    self.buf.clear();
                }
            } else if let Some(bytes) = self.overlong.as_mut() {
                *bytes += 1;
            } else {
                self.buf.push(b);
                if self.buf.len() > self.max_line_bytes {
                    self.overlong = Some(self.buf.len());
                    self.buf.clear();
                }
            }
        }
        out
    }

    /// EOF：把剩余的不完整半行作为最后一行交付；超长半行交付 Overlong。
    pub fn finish(&mut self) -> Option<Split> {
        if let Some(bytes) = self.overlong.take() {
            return Some(Split::Overlong { bytes });
        }
        if self.buf.last() == Some(&b'\r') {
            self.buf.pop();
        }
        if self.buf.is_empty() {
            return None;
        }
        let buf = std::mem::take(&mut self.buf);
        Some(Split::Line(String::from_utf8_lossy(&buf).into_owned()))
    }
}

/// stderr 用：同样按行切，但超长的行不丢弃整行，而是保留前 `max_line_bytes` 字节。
pub struct TruncatingLineSplitter {
    max_line_bytes: usize,
    buf: Vec<u8>,
    truncating: bool,
}

impl TruncatingLineSplitter {
    pub fn new(max_line_bytes: usize) -> Self {
        Self {
            max_line_bytes,
            buf: Vec::with_capacity(max_line_bytes.min(4096)),
            truncating: false,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for &b in chunk {
            if b == b'\n' {
                if self.buf.last() == Some(&b'\r') {
                    self.buf.pop();
                }
                if !self.buf.is_empty() {
                    if self.truncating {
                        self.buf.extend_from_slice("…".as_bytes());
                    }
                    out.push(String::from_utf8_lossy(&self.buf).into_owned());
                }
                self.buf.clear();
                self.truncating = false;
            } else if self.truncating {
                // 丢弃超长部分的剩余字节
            } else {
                self.buf.push(b);
                if self.buf.len() >= self.max_line_bytes {
                    self.truncating = true;
                }
            }
        }
        out
    }

    pub fn finish(&mut self) -> Option<String> {
        if self.buf.last() == Some(&b'\r') {
            self.buf.pop();
        }
        if self.buf.is_empty() {
            return None;
        }
        if self.truncating {
            self.buf.extend_from_slice("…".as_bytes());
        }
        self.truncating = false;
        let buf = std::mem::take(&mut self.buf);
        Some(String::from_utf8_lossy(&buf).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(s: &mut LineSplitter, chunks: &[&[u8]]) -> Vec<Split> {
        chunks.iter().flat_map(|c| s.push(c)).collect()
    }

    #[test]
    fn multiple_lines_in_one_chunk() {
        let mut s = LineSplitter::new(1024);
        assert_eq!(
            lines(&mut s, &[b"a\nb\nc\n"]),
            vec![
                Split::Line("a".into()),
                Split::Line("b".into()),
                Split::Line("c".into()),
            ]
        );
    }

    #[test]
    fn partial_line_across_chunks() {
        let mut s = LineSplitter::new(1024);
        assert!(s.push(b"hel").is_empty());
        assert_eq!(s.push(b"lo\n"), vec![Split::Line("hello".into())]);
    }

    #[test]
    fn strips_cr_before_lf() {
        let mut s = LineSplitter::new(1024);
        assert_eq!(s.push(b"a\r\nb\r\n"), vec![
            Split::Line("a".into()),
            Split::Line("b".into()),
        ]);
    }

    #[test]
    fn lone_cr_at_chunk_boundary() {
        let mut s = LineSplitter::new(1024);
        assert!(s.push(b"a\r").is_empty());
        assert_eq!(s.push(b"\n"), vec![Split::Line("a".into())]);
    }

    #[test]
    fn empty_lines_dropped() {
        let mut s = LineSplitter::new(1024);
        assert_eq!(s.push(b"\n\r\na\n\n"), vec![Split::Line("a".into())]);
    }

    #[test]
    fn eof_delivers_partial_line() {
        let mut s = LineSplitter::new(1024);
        assert!(s.push(b"a\nrest").len() == 1);
        assert_eq!(s.finish(), Some(Split::Line("rest".into())));
        assert_eq!(s.finish(), None);
    }

    #[test]
    fn overlong_line_dropped_then_next_line_ok() {
        let mut s = LineSplitter::new(8);
        let out = s.push(b"0123456789abcdef\nok\n");
        assert_eq!(out, vec![
            Split::Overlong { bytes: 16 },
            Split::Line("ok".into()),
        ]);
    }

    #[test]
    fn overlong_across_chunks_and_at_eof() {
        let mut s = LineSplitter::new(4);
        assert!(s.push(b"123456").is_empty());
        assert!(s.push(b"78").is_empty());
        assert_eq!(s.finish(), Some(Split::Overlong { bytes: 8 }));
    }

    #[test]
    fn non_utf8_lossy() {
        let mut s = LineSplitter::new(1024);
        let out = s.push(&[0x61, 0xff, 0xfe, b'\n']);
        assert_eq!(out.len(), 1);
        match &out[0] {
            Split::Line(l) => assert_eq!(l, "a\u{FFFD}\u{FFFD}"),
            _ => panic!("expected line"),
        }
    }

    #[test]
    fn truncating_splitter_keeps_prefix() {
        let mut s = TruncatingLineSplitter::new(8);
        let out = s.push(b"0123456789abcdef\nok\n");
        assert_eq!(out, vec!["01234567…".to_string(), "ok".to_string()]);
    }
}
