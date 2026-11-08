//! The `@<path>` lines a prompt names its attachments with: how the host writes them, and how the
//! transcript is read back for them.
//!
//! A prompt carries its files *beside* its words - `session_prompt` takes an `attachments` array,
//! and the engine reads each one from the path it names - so the message the engine stores is the
//! reader's own text with one expanded mention line appended per file
//! (`services/runtime/session.rs::build_prompt`). That makes the transcript the only record of what
//! a message carried: the files are named in its text, at the end, one per line.
//!
//! Reading them back is what this module is for. The lines are the host's own (`mention_line`), so
//! the rule that recognizes one and the rule that writes one are the same rule, stated once - a
//! session title skips those lines (`services/session_title.rs`) and a conversation read turns them
//! back into the attachments the row draws (`services/runtime/history.rs`), and neither may disagree
//! with the writer about what a mention looks like.
//!
//! Two facts bound the read:
//!
//! * The reader's words are the message minus the mention lines, and the composer's own file
//!   placeholders (`\u{E000}`-`\u{F8FF}`) stay in them: they are what a sent message's chips are
//!   positioned by, and the frontend pairs them with these files by order
//!   (`src/src/state/composer-draft.ts::messageSegments`). So the files are recovered in the
//!   order the lines stand in, which is the order the prompt was sent with.
//! * Only the lines the host appended are taken. The count of placeholders in the words says how
//!   many lines those are - one per file the composer sent - so a mention the reader typed on a line
//!   of its own stays part of what they wrote instead of being paired with another file's
//!   placeholder. A message with no placeholder at all (one sent before the composer kept them, or by
//!   another front end) has its trailing mention lines read as its files, which is the only reading
//!   left for it.

use std::path::Path;

/// The private-use range the composer writes one attachment's character from
/// (`src/src/state/composer-draft.ts`).
const PLACEHOLDER_FIRST: char = '\u{e000}';
const PLACEHOLDER_LAST: char = '\u{f8ff}';

/// Whether one character is a file placeholder the composer wrote into a draft.
fn is_placeholder(value: char) -> bool {
    (PLACEHOLDER_FIRST..=PLACEHOLDER_LAST).contains(&value)
}

/// The line one attachment is named by: `@C:\dir\1.png`, or `@"C:\dir with space\1.png"` for a path
/// that holds a space and has to stay one token for the engine's own mention parser.
pub(crate) fn mention_line(path: &str) -> String {
    if path.contains(' ') {
        format!("@\"{path}\"")
    } else {
        format!("@{path}")
    }
}

/// The path one mention line names, or `None` for a line that is not one.
///
/// Only a line that is *nothing but* a mention counts, and only for an absolute path: the host
/// appends exactly that shape, so a sentence that happens to contain an `@` is the reader's own
/// text. A quoted remainder may hold a space (the host quotes a path for exactly that reason), while
/// an unquoted `@...` with further words in it is a sentence someone wrote.
pub(crate) fn mention_path(line: &str) -> Option<&str> {
    let rest = line.strip_prefix('@')?;
    let (path, quoted) = match rest.chars().next() {
        Some('"') => (trim_wrapping_quotes(rest), true),
        _ => (rest, false),
    };
    if path.is_empty() || (!quoted && path.contains(char::is_whitespace)) {
        return None;
    }
    Path::new(path).is_absolute().then_some(path)
}

/// Whether a line is nothing but a file mention the host appended to a prompt.
pub(crate) fn is_mention_line(line: &str) -> bool {
    mention_path(line).is_some()
}

/// One stored prompt, as the words it was written with and the files it carried.
pub(crate) struct PromptRead<'a> {
    /// The reader's own text, placeholders included, with the mention lines taken out.
    pub(crate) words: &'a str,
    /// The files the mention lines named, in the order the prompt carried them.
    pub(crate) paths: Vec<&'a str>,
}

/// Read a stored prompt back into its words and its files.
///
/// The mention lines are taken from the end, one per placeholder the words hold; a prompt with no
/// placeholder has every trailing mention line taken instead (see the module doc). A line that is
/// not a mention ends the read - the host never writes a mention before the words - so a prompt that
/// was never given any is answered with itself and no files.
pub(crate) fn read_prompt(text: &str) -> PromptRead<'_> {
    // A trailing newline is not a file: the reader's own draft may end in one (a draft is sent as it
    // was typed) and the mention lines still stand before it.
    let text = text.trim_end();
    let wanted = text.chars().filter(|value| is_placeholder(*value)).count();
    let mut paths: Vec<&str> = Vec::new();
    let mut words_end = text.len();

    for line in text.rsplit('\n') {
        if wanted > 0 && paths.len() >= wanted {
            break;
        }
        let Some(path) = mention_path(line) else {
            break;
        };
        paths.push(path);
        // The line, and the break that put it on its own line, leave the words with it.
        words_end -= line.len();
        words_end = words_end.saturating_sub(1);
    }
    paths.reverse();
    PromptRead {
        words: &text[..words_end],
        paths,
    }
}

/// Removes one pair of quotes wrapped around the whole remainder: the host quotes a path that holds
/// a space, and only a matching pair is taken - an unbalanced quote is more likely the text itself.
fn trim_wrapping_quotes(input: &str) -> &str {
    let mut body = input;
    loop {
        let mut characters = body.chars();
        let Some(opening) = characters.next() else {
            return body;
        };
        // A single character cannot be both ends of a pair.
        let Some(closing) = characters.next_back() else {
            return body;
        };
        if opening != '"' || closing != '"' {
            return body;
        }
        body = characters.as_str();
    }
}

#[cfg(test)]
mod tests {
    use super::{is_mention_line, mention_line, read_prompt};

    /// An absolute path as the running platform spells one: what counts as absolute is the host's
    /// own question, so the checks below are written against this machine's answer.
    fn absolute(name: &str) -> String {
        if cfg!(windows) {
            format!("C:\\dir\\{name}")
        } else {
            format!("/dir/{name}")
        }
    }

    /// The line the host appends, and the line it reads back: one rule, so a path that holds a space
    /// is quoted by the writer and unquoted by the reader.
    #[test]
    fn a_mention_is_written_and_read_the_same_way() {
        let plain = absolute("1.png");
        assert_eq!(mention_line(&plain), format!("@{plain}"));

        let spaced = if cfg!(windows) {
            "C:\\dir with space\\1.png".to_owned()
        } else {
            "/dir with space/1.png".to_owned()
        };
        let line = mention_line(&spaced);
        assert_eq!(line, format!("@\"{spaced}\""));
        let prompt = format!("words\n{line}");
        let read = read_prompt(&prompt);
        assert_eq!(read.words, "words");
        assert_eq!(read.paths, vec![spaced.as_str()]);
    }

    /// A sentence with an `@` in it is the reader's own text: only a line that is nothing but an
    /// absolute path is a file.
    #[test]
    fn only_a_line_that_is_one_absolute_path_is_a_mention() {
        let path = absolute("1.png");
        for line in [
            String::new(),
            "@".to_owned(),
            "@notes.txt".to_owned(),
            format!("@{path} and more"),
            format!("see @{path}"),
            format!("@{path} "),
            format!(" @{path}"),
        ] {
            assert!(!is_mention_line(&line), "{line:?} is not a mention");
        }
        assert!(is_mention_line(&format!("@{path}")));
    }

    /// The words keep the composer's placeholders, because they are where the files sit in the
    /// sentence, and the mention lines leave with the files they named.
    #[test]
    fn a_prompt_reads_back_as_its_words_and_its_files() {
        let first = absolute("1.png");
        let prompt = format!("\u{e000}看这张图\n@{first}");
        let read = read_prompt(&prompt);
        assert_eq!(read.words, "\u{e000}看这张图");
        assert_eq!(read.paths, vec![first.as_str()]);

        // Several files, in the order the prompt carried them.
        let second = absolute("2.png");
        let two = format!("\u{e001}和\u{e000}\n@{first}\n@{second}");
        let read = read_prompt(&two);
        assert_eq!(read.words, "\u{e001}和\u{e000}");
        assert_eq!(read.paths, vec![first.as_str(), second.as_str()]);
    }

    /// A message with no placeholder - one sent before the composer kept them, or by another front
    /// end - still has its files read from the lines at its end.
    #[test]
    fn a_prompt_without_placeholders_still_carries_its_files() {
        let first = absolute("1.png");
        let second = absolute("2.png");
        let prompt = format!("看一下\n@{first}\n@{second}");
        let read = read_prompt(&prompt);
        assert_eq!(read.words, "看一下");
        assert_eq!(read.paths, vec![first.as_str(), second.as_str()]);

        // Nothing but files: the message has no words of its own.
        let prompt = format!("\n@{first}");
        let read = read_prompt(&prompt);
        assert_eq!(read.words, "");
        assert_eq!(read.paths, vec![first.as_str()]);
    }

    /// A mention the reader typed on a line of its own is not one of the host's: it stays in the
    /// words, so the files the composer sent are still paired with their own placeholders.
    #[test]
    fn a_typed_mention_line_is_not_taken_for_one_of_the_hosts() {
        let typed = absolute("notes.txt");
        let sent = absolute("1.png");
        // One file was attached, so the prompt holds one placeholder - and the host appended exactly
        // one mention line for it. The line the reader typed stays where they wrote it.
        let prompt = format!("\u{e000}看一下\n@{typed}\n@{sent}");
        let read = read_prompt(&prompt);
        assert_eq!(read.words, format!("\u{e000}看一下\n@{typed}"));
        assert_eq!(read.paths, vec![sent.as_str()]);
    }

    /// A prompt the host never gave a file to is answered with itself, and a trailing newline is not
    /// a file either.
    #[test]
    fn a_prompt_with_no_files_is_left_alone() {
        let read = read_prompt("只是文字");
        assert_eq!(read.words, "只是文字");
        assert!(read.paths.is_empty());

        let sent = absolute("1.png");
        let prompt = format!("看一下\n@{sent}\n");
        let read = read_prompt(&prompt);
        assert_eq!(read.words, "看一下");
        assert_eq!(read.paths, vec![sent.as_str()]);
    }
}
