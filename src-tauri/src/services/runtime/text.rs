//! The text rules applied to anything that leaves this process as a log line or a frame.
//!
//! Redaction is best-effort and deliberately narrow (see [`sanitize_message`]); bounding is exact,
//! because `String::truncate` panics rather than cutting a character in half. Both live here rather
//! than beside their callers: the application log, the engine log, the host's stderr tail and the
//! frames the UI reads all take text this process did not compose.

/// Best-effort redaction for engine-provided text before it reaches the UI or a log.
///
/// The host redacts its own text before it writes a frame; this is the second pass, and the one
/// that covers text this process composes. Only something that looks like a secret is replaced: a
/// known key prefix, a token after `Bearer`, or a long high-entropy run. Ordinary provider error
/// text - model ids, request ids, retry hints - must survive verbatim, because that text is what
/// the user has to read.
pub(crate) fn sanitize_message(input: &str) -> String {
    // Key shapes worth hiding even when short.
    const KEY_PREFIXES: &[&str] = &["sk-", "sk_", "ghp_", "github_pat_", "xoxb-", "AIza"];
    // A long run is only suspicious when it mixes cases and digits, which is what a generated
    // credential looks like; prose and model ids do not.
    const ENTROPY_MIN: usize = 40;
    const OUTPUT_LIMIT: usize = 4000;
    const TRUNCATION_MARKER: &str = "…(truncated)";
    // The marker is part of the ceiling, not something added beyond it: a cut line that does not say
    // it was cut is worse than the longer line, and callers bound the result again (`clamp_text`) on
    // the assumption that this limit is already a ceiling.
    let body_limit = OUTPUT_LIMIT - TRUNCATION_MARKER.chars().count();

    let mut out = String::with_capacity(input.len().min(2048));
    let mut written = 0usize;
    let chars: Vec<char> = input.chars().collect();
    let mut index = 0usize;
    let mut truncated = false;
    // Appends a replacement literal only when the whole of it fits. A half-written `<path>` is worse
    // than a line that simply ends, and the budget is a ceiling rather than a hint.
    let push_literal = |out: &mut String, written: &mut usize, literal: &str| -> bool {
        let count = literal.chars().count();
        if count > body_limit - *written {
            return false;
        }
        out.push_str(literal);
        *written += count;
        true
    };
    while index < chars.len() && written < body_limit {
        let character = chars[index];
        if is_drive_path(&chars, index) {
            while index < chars.len() && !chars[index].is_whitespace() {
                index += 1;
            }
            if !push_literal(&mut out, &mut written, "<path>") {
                truncated = true;
                break;
            }
            continue;
        }
        if character == '/' && is_home_path(&chars, index) {
            while index < chars.len() && !chars[index].is_whitespace() {
                index += 1;
            }
            if !push_literal(&mut out, &mut written, "<path>") {
                truncated = true;
                break;
            }
            continue;
        }
        if let Some(after) = bearer_length(&chars, index) {
            index += after;
            while index < chars.len() && chars[index].is_whitespace() {
                index += 1;
            }
            let token_start = index;
            while index < chars.len() && is_secret_char(chars[index]) {
                index += 1;
            }
            let literal = if index > token_start {
                "Bearer <redacted>"
            } else {
                "Bearer "
            };
            if !push_literal(&mut out, &mut written, literal) {
                truncated = true;
                break;
            }
            continue;
        }
        if is_secret_char(character) {
            let start = index;
            while index < chars.len() && is_secret_char(chars[index]) {
                index += 1;
            }
            let run: String = chars[start..index].iter().collect();
            if looks_like_secret(&run, KEY_PREFIXES, ENTROPY_MIN) {
                if !push_literal(&mut out, &mut written, "<redacted>") {
                    truncated = true;
                    break;
                }
            } else {
                // A long ordinary run is cut at the ceiling instead of being appended whole: the
                // ceiling used to apply only to the character-at-a-time path, so one 131 KB token
                // went up the wire untouched (the whole point of bounding this text).
                let length = run.chars().count();
                let keep = length.min(body_limit - written);
                out.extend(run.chars().take(keep));
                written += keep;
                if keep < length {
                    truncated = true;
                    break;
                }
            }
            continue;
        }
        out.push(character);
        written += 1;
        index += 1;
    }
    // Anything left unread was cut by the ceiling; say so in the output itself.
    if truncated || index < chars.len() {
        out.push_str(TRUNCATION_MARKER);
    }
    out
}

/// `text` cut to at most `limit` bytes, backed up to the nearest character boundary.
///
/// Beside [`sanitize_message`] because it is the other half of the same job: text that reaches a log
/// or a frame is redacted and bounded, and `String::truncate` panics rather than cutting a character
/// in half - which a host stderr line naming a path under a non-ASCII user name is enough to do.
pub(crate) fn truncate_on_char_boundary(text: &str, limit: usize) -> &str {
    if text.len() <= limit {
        return text;
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Characters a key or token is made of. `.` and `/` are included so a run is not split in the
/// middle of something that looks like `deepseek/deepseek-v4.1-flash`.
fn is_secret_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '+' | '=' | '.' | '/')
}

fn looks_like_secret(run: &str, prefixes: &[&str], entropy_min: usize) -> bool {
    if prefixes.iter().any(|prefix| run.starts_with(prefix)) {
        return true;
    }
    run.chars().count() >= entropy_min
        && run.chars().any(|character| character.is_ascii_uppercase())
        && run.chars().any(|character| character.is_ascii_lowercase())
        && run.chars().any(|character| character.is_ascii_digit())
}

/// Length of a `Bearer` keyword at `index` (ASCII, case-insensitive), else `None`.
fn bearer_length(chars: &[char], index: usize) -> Option<usize> {
    const KEYWORD: &str = "bearer";
    if index + KEYWORD.len() > chars.len() {
        return None;
    }
    let matches = KEYWORD
        .chars()
        .enumerate()
        .all(|(offset, expected)| chars[index + offset].to_ascii_lowercase() == expected);
    if !matches {
        return None;
    }
    match chars.get(index + KEYWORD.len()) {
        Some(next) if !next.is_whitespace() => None,
        _ => Some(KEYWORD.len()),
    }
}

/// Whether the run at `index` opens a Windows drive path rather than the tail of a URL scheme.
///
/// `xd://`, `local://`, `agent://` and `https://` all present a `d:` / `l:` / `t:` / `s:` shape
/// that the drive rule alone cannot tell from `C:\`: the letter has to open the word (it must not
/// sit inside one) and the colon must not be the scheme separator, which no drive uses.
fn is_drive_path(chars: &[char], index: usize) -> bool {
    if !cfg!(windows) {
        return false;
    }
    if index + 2 >= chars.len() {
        return false;
    }
    if !chars[index].is_ascii_alphabetic() || chars[index + 1] != ':' {
        return false;
    }
    if !matches!(chars[index + 2], '\\' | '/') {
        return false;
    }
    if chars.get(index + 3) == Some(&'/') {
        return false;
    }
    match index.checked_sub(1) {
        None => true,
        Some(previous) => {
            let before = chars[previous];
            !(before.is_ascii_alphanumeric() || matches!(before, '_' | '.' | '+' | '-'))
        }
    }
}

fn is_home_path(chars: &[char], index: usize) -> bool {
    let rest: String = chars[index..chars.len().min(index + 7)].iter().collect();
    rest.starts_with("/home/") || rest.starts_with("/Users/")
}

#[cfg(test)]
mod sanitize_tests {
    use super::*;

    /// The regression this covers: a provider error ends up as `(<redacted>)` because the token
    /// rule swallowed a whole sentence of harmless text.
    #[test]
    fn provider_error_text_survives_verbatim() {
        let text = "Error 429: Daily free limit reached on model deepseek/deepseek-v4.1-flash. Try again in 3h 35m";
        assert_eq!(sanitize_message(text), text);
    }

    #[test]
    fn model_ids_and_prose_are_not_secrets() {
        for text in [
            "model zai-org/GLM-5.3 is unavailable",
            "request id req_0123456789abcdef0123456789abcdef",
            "Try again in 3h 35m",
        ] {
            assert_eq!(sanitize_message(text), text, "{text}");
        }
    }

    #[test]
    fn keys_are_still_redacted() {
        assert_eq!(
            sanitize_message("Authorization: Bearer sk-ant-api03-AAAbbbCCC111222333"),
            "Authorization: Bearer <redacted>"
        );
        assert_eq!(sanitize_message("sk-ant-api03-XXXXYYYYZZZZ"), "<redacted>");
        assert_eq!(
            sanitize_message("token ghp_AbCdEf0123456789AbCdEf0123456789ab"),
            "token <redacted>"
        );
        assert_eq!(sanitize_message("AIzaSyA1234567890abcdef"), "<redacted>");
        // Long, mixed-case and numeric: indistinguishable from a generated credential.
        assert_eq!(
            sanitize_message("value AbCdEf0123456789AbCdEf0123456789AbCdEf01"),
            "value <redacted>"
        );
    }

    #[test]
    fn paths_are_still_redacted() {
        assert!(sanitize_message(r"open C:\Users\user\.ssh\id_rsa").contains("<path>"));
        assert!(sanitize_message("rm /home/user/.aws/credentials").contains("<path>"));
    }

    /// The regression this covers: `xd://` read as a drive path, so the tool list the reader saw
    /// said `~ x<path>` for every mounted device and a mount notice said `x<path>: unmounted …`.
    /// A drive letter opens a word and never carries a scheme separator.
    #[test]
    fn a_url_scheme_is_not_a_drive_path() {
        for text in [
            "xd://: unmounted ast_edit, debug, lsp",
            "~ xd://lsp",
            "read local://PLAN.md",
            "agent://all broadcast",
            "proc://bg_1 status",
            "see https://omp.sh/docs/sdk",
        ] {
            assert_eq!(sanitize_message(text), text, "{text}");
        }
    }

    /// The ceiling applies to a single long run too, not only to the character-at-a-time path.
    #[test]
    fn a_single_long_run_is_cut_at_the_ceiling() {
        let text = "x".repeat(131_073);
        let output = sanitize_message(&text);
        assert_eq!(output.chars().count(), 4_000);
        assert!(output.ends_with("…(truncated)"));
        assert!(output.starts_with("xxxx"));
        // Text that fits is not marked and not changed.
        let short = "a provider said no";
        assert_eq!(sanitize_message(short), short);
    }

    #[test]
    fn no_output_exceeds_the_ceiling_whatever_it_contains() {
        let samples = [
            "x".repeat(10_000),
            format!("{}sk-ant-api03-AAAbbbCCC111222333", "y".repeat(3_990)),
            format!("{} C:\\Users\\user\\.ssh\\id_rsa", "z".repeat(3_995)),
            format!(
                "{}Bearer sk-ant-api03-AAAbbbCCC111222333",
                "w".repeat(3_990)
            ),
        ];
        for sample in samples {
            assert!(
                sanitize_message(&sample).chars().count() <= 4_000,
                "{}",
                &sample[..sample.len().min(40)]
            );
        }
    }

    /// A secret that cannot fit whole is dropped rather than emitted as a recognisable fragment.
    #[test]
    fn a_secret_that_does_not_fit_is_not_half_written() {
        let text = format!("{}sk-ant-api03-AAAbbbCCC111222333", "a".repeat(3_995));
        let output = sanitize_message(&text);
        assert!(output.chars().count() <= 4_000);
        assert!(!output.contains("sk-ant"));
    }
}
