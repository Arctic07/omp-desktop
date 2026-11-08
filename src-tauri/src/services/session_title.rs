//! Deterministic title derivation for the engine's session transcripts.
//!
//! Measured against `omp 18.2.6` and re-checked against 18.6.1 (same slot width, same header
//! version), a session file (`sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`) holds a fixed-width
//! 256-byte title slot on line 1, the header on line 2
//! (`{"type":"session","version":3,"id":..,"cwd":..}`), and one entry per line after that
//! (`{"type":"message"|"mode_change"|"custom"|..,..}`). The writer fills that slot only when it has
//! a name to put there, so a programmatically created session keeps a blank slot and would
//! otherwise read as untitled; the derivation below backfills the label from the first human prompt
//! in the transcript head.
//!
//! `parse_line` lives here because the derivation and the session index decode the same NDJSON
//! transcript format: one decoder, no second copy of the line rules. The caller decides how much of
//! a file to hand in, so every function here works on a borrowed, bounded window.

use std::iter::Peekable;
use std::str::Chars;

use serde_json::Value;

use super::attachment_mentions;

/// Characters a derived title keeps: a label that fits a sidebar row and a hover card.
const TITLE_FALLBACK_CHARS: usize = 60;
/// Appended when the label had to be cut, so a label is never mistaken for the whole prompt.
const TITLE_ELLIPSIS: char = '…';

/// Parses one NDJSON line. Blank lines, non-UTF-8 bytes and truncated fragments are skipped.
pub(crate) fn parse_line(line: &[u8]) -> Option<Value> {
    let text = std::str::from_utf8(line).ok()?.trim();
    if text.is_empty() {
        return None;
    }
    serde_json::from_str(text).ok()
}

/// Whether the transcript bytes hold any message entry at all.
///
/// Only the bytes handed in are answered for. A window that starts at the file's own beginning
/// still cannot say "nothing was ever written to this conversation" on its own: the window is a
/// fixed size, so a first message longer than the window - or a preamble that pushes it past it -
/// leaves no parsable message behind even though the file has one. The caller proves the window
/// reaches the end of the file before it reads an empty answer as "this conversation is empty";
/// see `session_index::read_summary`.
pub(crate) fn head_holds_message(bytes: &[u8]) -> bool {
    bytes.split(|byte| *byte == b'\n').any(|line| {
        parse_line(line)
            .and_then(|entry| entry.get("type").and_then(Value::as_str).map(str::to_owned))
            .is_some_and(|kind| kind == "message")
    })
}

/// Derives a title from the transcript head when the engine left the title slot blank. Entries are
/// read in file order, so the first eligible human prompt decides the label and the scan stops
/// there; a prompt that holds no words of its own - an attachment and nothing else, say - keeps the
/// scan going, and an empty result means the bytes handed in hold no eligible prompt. A window that
/// cuts a message line short makes that line unparsable, so the caller has to hand in a window wide
/// enough to hold the whole line it expects the label from.
pub(crate) fn derived_title(bytes: &[u8]) -> String {
    for line in bytes.split(|byte| *byte == b'\n') {
        let Some(entry) = parse_line(line) else {
            continue;
        };
        if entry.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(message) = entry.get("message") else {
            continue;
        };
        if message.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        // Only text the user wrote: subagent and system deliveries are also recorded as `user`
        // entries, but carry `attribution: "agent"`.
        if !matches!(
            message.get("attribution").and_then(Value::as_str),
            None | Some("user")
        ) {
            continue;
        }
        let title = fallback_title(&message_text(message));
        if !title.is_empty() {
            return title;
        }
    }
    String::new()
}

/// Concatenates every text block of one message; non-text blocks (images, resources) carry no
/// title text, and blocks are separated so that adjacent words never merge.
fn message_text(message: &Value) -> String {
    let Some(blocks) = message.get("content").and_then(Value::as_array) else {
        return String::new();
    };
    let mut text = String::new();
    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let Some(part) = block.get("text").and_then(Value::as_str) else {
            continue;
        };
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(part);
    }
    text
}

/// Removes terminal escape sequences, non-whitespace C0/C1 controls, directional or invisible
/// characters and the composer's own attachment placeholders, folds whitespace runs into single
/// spaces, trims the result and takes off the wrapper a title model was told to write around its
/// answer (see [`strip_title_wrapper`]): the label is engine-authored text, so anything that could
/// render deceptively - or that is the transport's envelope rather than the name - is dropped
/// instead of shown. `pub(crate)` because the engine's title slot and its live frames are display
/// text of the same kind, and both are cleaned through this one function rather than through a
/// second copy of these rules.
pub(crate) fn clean_title_text(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut characters = input.chars().peekable();
    let mut pending_space = false;
    while let Some(character) = characters.next() {
        match character {
            // Operating-system command: `ESC ]` .. BEL | `ESC \`.
            '\u{1b}' if characters.peek() == Some(&']') => {
                characters.next();
                skip_until_terminator(&mut characters);
            }
            '\u{9d}' => skip_until_terminator(&mut characters),
            // Control sequence introducer: `ESC [` .. final byte.
            '\u{1b}' if characters.peek() == Some(&'[') => {
                characters.next();
                skip_control_sequence(&mut characters);
            }
            '\u{9b}' => skip_control_sequence(&mut characters),
            // Remaining two-byte escapes, e.g. charset selection.
            '\u{1b}' => {
                if matches!(characters.peek(), Some(&next) if matches!(next, '@'..='_')) {
                    characters.next();
                }
            }
            _ if is_title_control(character) => {}
            _ if character.is_whitespace() => pending_space = !output.is_empty(),
            _ => {
                if pending_space {
                    output.push(' ');
                    pending_space = false;
                }
                output.push(character);
            }
        }
    }
    let body = strip_title_wrapper(&output);
    if is_empty_title_marker(body) {
        return String::new();
    }
    body.to_owned()
}

/// The envelope a title model was told to write around its answer, taken off: `<title>…</title>` in
/// the exact ASCII form the engine parses, and the translated spelling a model sometimes emits
/// instead (`<标题>…</标题>`, `<titre>…</titre>`). The engine reads only the ASCII marker, so a
/// translated envelope survives into the session name verbatim (measured:
/// `<标题>修复浏览器 agent 蒙版错位与 GPU 卡顿</标题>`); the name is what the tags wrap, never the
/// tags themselves.
///
/// Only a matching pair wrapping the whole text is taken, so a title that quotes markup
/// (`修复嵌套的 <div></div> 渲染`) keeps its words, and one layer at a time, because a model can
/// wrap a translated marker in an ASCII one.
fn strip_title_wrapper(input: &str) -> &str {
    let mut body = input.trim();
    while let Some(inner) = title_envelope_inner(body) {
        body = inner.trim();
    }
    body
}

/// The text between a wrapper's opening and closing tags, when all of `body` is that one element.
/// The closing tag has to name the opening one, case-insensitively; attributes on the opening tag
/// are allowed, which is how `<title lang="zh">` comes back from some models.
fn title_envelope_inner(body: &str) -> Option<&str> {
    let opening = body.strip_prefix('<')?;
    let (opening, rest) = opening.split_once('>')?;
    let name = opening.split_whitespace().next()?;
    if name.is_empty() || name.contains('<') || name.contains('>') || name.contains('/') {
        return None;
    }
    let rest = rest.trim_end();
    let close_at = rest.rfind('<')?;
    let closing = rest[close_at + 1..].strip_suffix('>')?.trim();
    if !closing.strip_prefix('/')?.trim().eq_ignore_ascii_case(name) {
        return None;
    }
    let inner = rest[..close_at].trim();
    if inner.is_empty() {
        return None;
    }
    Some(inner)
}

/// Whether the text is an empty title marker (`<title/>`, `<标题/>`): the model's way of answering
/// "nothing to name", which the engine understands only under the ASCII tag name.
fn is_empty_title_marker(body: &str) -> bool {
    let Some(inner) = body.strip_prefix('<') else {
        return false;
    };
    let Some(inner) = inner.strip_suffix("/>") else {
        return false;
    };
    let inner = inner.trim();
    !inner.is_empty() && !inner.contains('<') && !inner.contains('>')
}

/// Deterministic fallback label for one prompt: the first line that still holds text of its own,
/// with the markup a pasted draft opens with stripped off, cut to `TITLE_FALLBACK_CHARS` characters
/// and marked with the ellipsis when it was cut. Text that cleans to nothing - or that turns out to
/// be nothing but the file mentions the host appends - yields an empty label and the caller keeps
/// scanning.
///
/// Line breaks divide the candidates instead of folding into spaces because the host sends the
/// prompt with one expanded `@<path>` line per attachment (`build_prompt` in the runtime session
/// service): the label has to name what was asked, not the files that came with it.
fn fallback_title(input: &str) -> String {
    let Some(line) = input
        .split('\n')
        .map(clean_title_text)
        .find(|line| !line.is_empty() && !is_attachment_mention(line))
    else {
        return String::new();
    };
    let body = trim_leading_markers(&line);
    let body = trim_wrapping_quotes(body);
    let body = body
        .trim_end_matches(is_title_trailing_punctuation)
        .trim_end();
    let mut title: String = body.chars().take(TITLE_FALLBACK_CHARS).collect();
    // The cut can land on a space, and a label never ends in one.
    title.truncate(title.trim_end().len());
    if body.chars().count() > TITLE_FALLBACK_CHARS {
        title.push(TITLE_ELLIPSIS);
    }
    title
}

/// True for a line that is nothing but a file mention the host appended to the prompt:
/// `@C:\dir\1.txt`, or `@"C:\dir with space\1.txt"` for a path that holds a space and has to stay
/// one token. The host mints those lines from the composer's attachments, so they are not words the
/// user wrote and a path is not a label - a prompt that only attached files belongs to the UI's
/// untitled copy.
///
/// The rule itself lives with the writer (`services/attachment_mentions.rs`), which is what keeps a
/// title and a conversation read agreeing about what a mention looks like.
fn is_attachment_mention(line: &str) -> bool {
    attachment_mentions::is_mention_line(line)
}

/// Strips the list, quote and heading markup a pasted draft opens with, so the label reads as the
/// request itself and not as the bullet that introduced it. Markers stack (`> - item`) and a heading
/// is a run of one character (`## title`), so the strip repeats until nothing is left to take. A
/// marker only counts when whitespace follows it: `-2` and `1.5` are content.
fn trim_leading_markers(input: &str) -> &str {
    let mut body = input.trim_start();
    loop {
        let Some(marker) = body.chars().next() else {
            return body;
        };
        let marker_len = match marker {
            '-' | '*' | '+' | '>' | '#' => body
                .chars()
                .take_while(|character| *character == marker)
                .map(char::len_utf8)
                .sum(),
            // An ordered-list marker is the digits plus the delimiter that follows them. Digits and
            // delimiter are ASCII, so the byte index the scan reports is a character boundary.
            '0'..='9' => {
                let digits = body
                    .find(|character: char| !character.is_ascii_digit())
                    .unwrap_or(body.len());
                if !matches!(body[digits..].chars().next(), Some('.' | ')')) {
                    return body;
                }
                digits + 1
            }
            _ => return body,
        };
        let mut rest = body[marker_len..].chars();
        if !matches!(rest.next(), Some(character) if character.is_whitespace()) {
            return body;
        }
        body = rest.as_str().trim_start();
    }
}

/// Removes one pair of quotes wrapped around the whole line: a quote a user typed around the request
/// is punctuation rather than part of the name, so the label reads better without it. Only a
/// matching pair is taken - an unbalanced quote is more likely to be the text itself - and a nested
/// pair is taken by the next pass.
fn trim_wrapping_quotes(input: &str) -> &str {
    let mut body = input.trim();
    loop {
        let mut characters = body.chars();
        let Some(opening) = characters.next() else {
            return body;
        };
        // A single character cannot be both ends of a pair.
        let Some(closing) = characters.next_back() else {
            return body;
        };
        let expected = match opening {
            '"' | '\'' => opening,
            '“' => '”',
            '‘' => '’',
            _ => return body,
        };
        if expected != closing {
            return body;
        }
        body = characters.as_str().trim();
    }
}

/// Sentence punctuation that closes a pasted request: a label is a name, so the mark that ended the
/// sentence is dropped. Only the end of the line is considered - punctuation inside the text is part
/// of what was asked.
fn is_title_trailing_punctuation(character: char) -> bool {
    matches!(
        character,
        '.' | '。' | '!' | '！' | '?' | '？' | ':' | '：' | ',' | '，' | ';' | '；'
    )
}

/// Consumes an OSC body up to its BEL or `ESC \` terminator, or to the end of the input.
fn skip_until_terminator(characters: &mut Peekable<Chars<'_>>) {
    while let Some(character) = characters.next() {
        match character {
            '\u{7}' => return,
            '\u{1b}' if characters.peek() == Some(&'\\') => {
                characters.next();
                return;
            }
            _ => {}
        }
    }
}

/// Consumes a CSI body: parameter and intermediate bytes, then the final byte. A malformed tail
/// stops the scan without consuming the character that ended it.
fn skip_control_sequence(characters: &mut Peekable<Chars<'_>>) {
    while matches!(
        characters.peek(),
        Some(&character) if matches!(character, '\u{20}'..='\u{3f}')
    ) {
        characters.next();
    }
    if matches!(
        characters.peek(),
        Some(&character) if matches!(character, '\u{40}'..='\u{7e}')
    ) {
        characters.next();
    }
}

/// Non-whitespace C0/C1 controls plus the directional, invisible and placeholder characters that
/// could make a displayed title deceptive. Whitespace controls (`\t`, `\n`, `\r`) are folded, not
/// dropped.
///
/// The private-use range is the composer's own: it writes one such code point per attachment into
/// the draft, and the prompt travels to the engine and into the transcript with them, so a derived
/// label would open with a character no font has a glyph for - a box (`口`) where the name should
/// start. The object replacement character stands for a rendered object in the same way and is
/// dropped for the same reason.
fn is_title_control(character: char) -> bool {
    matches!(
        character,
        '\u{0}'..='\u{8}'
            | '\u{b}'..='\u{c}'
            | '\u{e}'..='\u{1f}'
            | '\u{7f}'..='\u{9f}'
            | '\u{200b}'
            | '\u{200e}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206f}'
            | '\u{e000}'..='\u{f8ff}'
            | '\u{feff}'
            | '\u{fffc}'
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One `user` entry as the engine writes it: a single text block plus the attribution.
    fn user_entry(attribution: Option<&str>, text: &str) -> String {
        let attribution = match attribution {
            Some(value) => format!(",\"attribution\":\"{value}\""),
            None => String::new(),
        };
        format!(
            "{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\
             \"content\":[{{\"type\":\"text\",\"text\":\"{text}\"}}]{attribution}}}}}"
        )
    }

    /// Transcript head: a title slot, the header, then one line per entry.
    fn head(slot_title: &str, entries: &[String]) -> Vec<u8> {
        let mut bytes = format!(
            "{{\"type\":\"title\",\"v\":1,\"title\":\"{slot_title}\",\"pad\":\"\"}}\n\
             {{\"type\":\"session\",\"version\":3,\"id\":\"01a0bcf1-1e76-7000-aeae-aefed618164f\",\
             \"cwd\":\"D:/workspace\"}}\n"
        );
        for entry in entries {
            bytes.push_str(entry);
            bytes.push('\n');
        }
        bytes.into_bytes()
    }

    /// Labels are engine-authored text: escape sequences and invisible controls must never reach
    /// the title, and whitespace collapses into single spaces.
    #[test]
    fn title_cleaning_drops_escapes_and_invisible_controls() {
        assert_eq!(
            clean_title_text("\u{1b}[31mred\u{1b}[0m title\u{200b}\u{feff}here"),
            "red titlehere"
        );
        assert_eq!(clean_title_text("fix\t\r\n   the   bug"), "fix the bug");
        assert_eq!(
            clean_title_text("\u{1b}]0;window title\u{7}prompt"),
            "prompt"
        );
        assert_eq!(clean_title_text("\u{9d}0;window title\u{7}kept"), "kept");
        assert_eq!(clean_title_text("\u{9b}2Ktrim  "), "trim");
        // Only two-byte `ESC[@-_]` escapes and OSC/CSI are honoured. A three-byte charset sequence
        // (`ESC ( B`) is not special-cased, so the ESC alone is dropped and the rest of the text
        // is kept.
        assert_eq!(clean_title_text("\u{1b}(Bplain"), "(Bplain");
        // The composer writes one private-use code point per attachment into the draft, so the
        // prompt the engine records opens with one; no font has a glyph for it, and a row would
        // draw a box (`口`) instead of the name. It is dropped like any other deceptive character,
        // and the object replacement character goes with it.
        assert_eq!(
            clean_title_text("\u{e000}改为李白 静夜思"),
            "改为李白 静夜思"
        );
        assert_eq!(clean_title_text("look\u{f8ff}here\u{fffc}"), "lookhere");
    }

    /// The engine asks a title model for `<title>…</title>` and parses only that ASCII marker, so a
    /// model that translates the tag leaves the envelope in the name (measured:
    /// `<标题>修复浏览器 agent 蒙版错位与 GPU 卡顿</标题>`). The name is what the tags wrap; markup
    /// the title quotes as its subject stays, and a mismatched pair is text.
    #[test]
    fn title_cleaning_takes_off_a_marker_wrapper() {
        assert_eq!(
            clean_title_text("<标题>修复浏览器 agent 蒙版错位与 GPU 卡顿</标题>"),
            "修复浏览器 agent 蒙版错位与 GPU 卡顿"
        );
        assert_eq!(
            clean_title_text("<title>Fix flaky park tests</title>"),
            "Fix flaky park tests"
        );
        assert_eq!(
            clean_title_text("<title lang=\"zh\">修复卡顿</title>"),
            "修复卡顿"
        );
        assert_eq!(clean_title_text("<TITLE>Fix</tItLe>"), "Fix");
        // A model can wrap a translated marker in the ASCII one.
        assert_eq!(
            clean_title_text("<title><标题>修复卡顿</标题></title>"),
            "修复卡顿"
        );
        // An empty marker is the model's "nothing to name", in either spelling.
        assert_eq!(clean_title_text("<title/>"), String::new());
        assert_eq!(clean_title_text("<标题/>"), String::new());
        // Markup that is the title's subject is content, not an envelope.
        assert_eq!(
            clean_title_text("修复嵌套的 <div></div> 渲染"),
            "修复嵌套的 <div></div> 渲染"
        );
        assert_eq!(clean_title_text("<div> 是怎么工作的"), "<div> 是怎么工作的");
        assert_eq!(clean_title_text("<标题>修复</title>"), "<标题>修复</title>");
    }

    /// The label is a whole line of the prompt, not a slice of its words: the host sends one
    /// expanded `@<path>` line per attachment after the request, and a title names the request.
    #[test]
    fn fallback_title_keeps_the_first_non_empty_line() {
        assert_eq!(fallback_title("first line\nsecond line"), "first line");
        assert_eq!(
            fallback_title("\u{e000}改为李白 静夜思\n@D:\\project\\test\\1.txt"),
            "改为李白 静夜思"
        );
        assert_eq!(
            fallback_title("\n \n  the real request\n"),
            "the real request"
        );
        assert_eq!(fallback_title("   "), String::new());
    }

    /// A draft pasted from notes opens with its bullet, quote marker or number; the label keeps the
    /// request and drops the markup that introduced it, while content that merely starts with a
    /// dash or a decimal point survives.
    #[test]
    fn fallback_title_strips_leading_markers() {
        assert_eq!(
            fallback_title("- 真实引擎下 abort 的往返时延与超时分支"),
            "真实引擎下 abort 的往返时延与超时分支"
        );
        assert_eq!(fallback_title("1. 修 bug"), "修 bug");
        assert_eq!(fallback_title("> * quoted item"), "quoted item");
        assert_eq!(fallback_title("## heading"), "heading");
        assert_eq!(fallback_title("-2 degrees"), "-2 degrees");
        assert_eq!(fallback_title("1.5 hours"), "1.5 hours");
    }

    /// Quotes wrapped around the whole request and the mark that ended its sentence are punctuation
    /// rather than part of the name, and an unbalanced quote is text like any other.
    #[test]
    fn fallback_title_strips_wrapping_quotes_and_trailing_punctuation() {
        assert_eq!(fallback_title("\"修 bug。\""), "修 bug");
        assert_eq!(fallback_title("“检查一下这个问题”"), "检查一下这个问题");
        assert_eq!(
            fallback_title("'why is the row empty?'"),
            "why is the row empty"
        );
        assert_eq!(fallback_title("修 bug。"), "修 bug");
        assert_eq!(
            fallback_title("fix the title, then list;"),
            "fix the title, then list"
        );
        assert_eq!(fallback_title("fix a, then b"), "fix a, then b");
        assert_eq!(fallback_title("unbalanced \"quote"), "unbalanced \"quote");
    }

    /// A prompt that fits the budget keeps its whole text; a longer one is cut on a character
    /// boundary and marked, so a shortened label is never mistaken for the whole prompt.
    #[test]
    fn fallback_title_cuts_long_text_at_the_character_budget() {
        let short = "对齐引擎的标题推导规则";
        assert_eq!(fallback_title(short), short);
        let long = "这是一段没有空格的很长的中文标题内容用于验证截断是否按字符边界进行而不是按字节"
            .repeat(2);
        let title = fallback_title(&long);
        assert_eq!(title.chars().count(), TITLE_FALLBACK_CHARS + 1);
        let kept: String = long.chars().take(TITLE_FALLBACK_CHARS).collect();
        assert_eq!(title, format!("{kept}{TITLE_ELLIPSIS}"));
        assert!(long.chars().count() > TITLE_FALLBACK_CHARS);
        // A cut can land on a space, and the ellipsis never follows one.
        assert_eq!(
            fallback_title(&"word ".repeat(20)),
            format!("{}…", "word ".repeat(12).trim_end())
        );
    }

    /// Text that cleans to nothing produces no label: the UI keeps its own untitled copy.
    #[test]
    fn fallback_title_of_pure_control_text_is_empty() {
        assert_eq!(
            fallback_title("\u{1b}[31m\u{1b}[0m\u{200b}\u{7f}"),
            String::new()
        );
        assert_eq!(fallback_title("\u{0}\u{1}\u{200e}\u{feff}"), String::new());
        // A prompt that is nothing but the composer's placeholders names nothing, so the search for
        // a prompt with words of its own continues.
        assert_eq!(fallback_title("\u{e000}\u{e110}\u{fffc}"), String::new());
        assert_eq!(fallback_title("\u{e000}\n\u{fffc}"), String::new());
    }

    /// A line that is only a file mention is the host's own account of an attachment, not something
    /// the user said: the label skips it and keeps looking, so a prompt that only attached files has
    /// no name at all. Whether a path is absolute is the running host's question, and the host only
    /// ever appends paths that are absolute for that same host.
    #[test]
    fn fallback_title_skips_attachment_mention_lines() {
        let mention = if cfg!(windows) {
            r"@D:\dir\1.txt"
        } else {
            "@/dir/1.txt"
        };
        let spaced = if cfg!(windows) {
            r#"@"D:\dir with space\1.txt""#
        } else {
            r#"@"/dir with space/1.txt""#
        };
        assert_eq!(fallback_title(mention), String::new());
        assert_eq!(fallback_title(spaced), String::new());
        assert_eq!(fallback_title(&format!("{mention}\n真实需求")), "真实需求");
        // A mention inside a sentence is text like any other: only a line that is nothing but a path
        // is skipped.
        assert_eq!(
            fallback_title(&format!("{mention} 顺便看看")),
            format!("{mention} 顺便看看")
        );
        assert_eq!(
            fallback_title("@notes.txt please read this"),
            "@notes.txt please read this"
        );
    }

    /// The label comes from the first prompt the user typed: turns the user did not author are
    /// skipped, and a turn that cleans to nothing - escapes, invisible controls, the composer's
    /// placeholders - neither ends the search nor contributes a character.
    #[test]
    fn derived_title_keeps_scanning_for_the_first_eligible_human_prompt() {
        let bytes = head(
            "",
            &[
                user_entry(Some("agent"), "Injected reminder"),
                user_entry(Some("user"), "\\u001b[31m\\u200b\\ue000"),
                user_entry(
                    Some("user"),
                    "please refactor the session index projection now",
                ),
                user_entry(Some("user"), "ignore this later prompt"),
            ],
        );
        assert_eq!(
            derived_title(&bytes),
            "please refactor the session index projection now"
        );
    }

    /// A prompt that carried an attachment and no words has no title to derive, and a mention line
    /// ahead of the real text never stands in for it: the host mints those lines from the composer's
    /// attachments (`build_prompt`), so they are not something the user said.
    #[test]
    fn derived_title_skips_attachment_mention_lines() {
        let mention = if cfg!(windows) {
            "@D:/project/test/1.txt"
        } else {
            "@/project/test/1.txt"
        };
        assert_eq!(
            derived_title(&head(
                "",
                &[user_entry(None, &format!("\\ue000\\n{mention}"))]
            )),
            String::new()
        );
        assert_eq!(
            derived_title(&head(
                "",
                &[user_entry(None, &format!("{mention}\\n真实需求"))]
            )),
            "真实需求"
        );
    }

    /// A user turn without an attribution still counts; other roles and a transcript without any
    /// user turn yield an empty label, which the UI shows as untitled.
    #[test]
    fn derived_title_ignores_other_roles_and_blank_transcripts() {
        let unattributed = user_entry(None, "unattributed prompt");
        assert_eq!(
            derived_title(&head("", &[unattributed])),
            "unattributed prompt"
        );
        let assistant = "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\
                         \"content\":[{\"type\":\"text\",\"text\":\"reply\"}]}}";
        assert_eq!(
            derived_title(&head("", &[assistant.to_owned()])),
            String::new()
        );
        assert_eq!(derived_title(&head("", &[])), String::new());
        assert_eq!(
            derived_title(&head("", &[user_entry(Some("user"), "   ")])),
            String::new()
        );
    }
}
