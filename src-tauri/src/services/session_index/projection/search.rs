//! The content half of the projection: which conversations say a thing, and the line where they
//! say it.
//!
//! Two query shapes, chosen by what a trigram index can answer:
//!
//! - **Every term is at least three characters** - the length a trigram tokenizes - so the index
//!   answers it. FTS5 tokenizes each term and matches the phrase, which is what makes a query a
//!   substring search in any script: `部署` (two characters) never reaches this path, and
//!   `deployment` or `数据库连接` does.
//! - **Any term is shorter** - a two-character Chinese word is the ordinary case - so the query
//!   falls back to `LIKE '%term%'` over the same rows. Only the conversation's own words are
//!   indexed (no tool output, no reasoning), so that scan is over a few megabytes at most; the
//!   timing that matters is a person typing into a field, and the bound below keeps it there.
//!
//! Sessions are ranked by how many lines matched, then by the newest line, because a conversation
//! that mentions a thing repeatedly is a better answer than one that mentions it once - and the
//! caller re-sorts by recency once it has the summaries. Snippets come back with the match wrapped
//! in [`MARK_START`]/[`MARK_END`], the only thing the reader's side has to understand about them.

use rusqlite::{params, Connection};

/// Characters a snippet wraps a match in. Control characters, so they cannot occur in a transcript
/// and cannot be confused with the text: the reader's side splits on them and draws `<mark>`.
pub(crate) const MARK_START: char = '\u{1}';
pub(crate) const MARK_END: char = '\u{2}';

/// How many characters around a match a fallback snippet keeps.
const SNIPPET_RADIUS: usize = 90;
/// How many characters of a matched line the indexer stores. Conversation text is short; a pasted
/// document is the exception, and its opening is what a search result needs to show anyway.
pub(crate) const MAX_INDEXED_CHARS: usize = 32 * 1024;
/// Terms one query may carry. A field never needs more, and every extra term is another scan.
const MAX_TERMS: usize = 8;
/// Characters one term may carry, so a pasted paragraph does not become a query.
const MAX_TERM_CHARS: usize = 128;
/// Matched lines fetched per conversation for its snippets.
const SNIPPETS_PER_SESSION: usize = 3;

/// One conversation a content search matched.
pub(crate) struct Hit {
    /// The transcript's key in the projection (the normalized path).
    pub(crate) file: String,
    pub(crate) matches: i64,
    pub(crate) snippets: Vec<Snippet>,
}

/// One matched line: which message it was, and the text around the match.
pub(crate) struct Snippet {
    pub(crate) seq: i64,
    pub(crate) role: String,
    pub(crate) text: String,
}

/// The conversations that mention every term of `query`, best first, at most `limit` of them.
///
/// An empty or blank query matches nothing: this search is for a thing the reader half remembers,
/// and "every conversation" is the rail's own list.
pub(super) fn search(conn: &Connection, query: &str, limit: usize) -> Vec<Hit> {
    if limit == 0 {
        return Vec::new();
    }
    let terms = terms_of(query);
    if terms.is_empty() {
        return Vec::new();
    }
    let indexed = terms.iter().all(|term| term.chars().count() >= 3);
    let groups = if indexed {
        fts_groups(conn, &terms, limit)
    } else {
        like_groups(conn, &terms, limit)
    };
    groups
        .into_iter()
        .filter_map(|(file, matches)| {
            let snippets = if indexed {
                fts_snippets(conn, &terms, &file)
            } else {
                like_snippets(conn, &terms, &file)
            };
            (!snippets.is_empty()).then_some(Hit {
                file,
                matches,
                snippets,
            })
        })
        .collect()
}

/// The terms of a query: whitespace-separated, deduplicated, each bounded in length, and at most
/// [`MAX_TERMS`] of them. A term that is only whitespace contributes nothing.
fn terms_of(query: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    for word in query.split_whitespace() {
        let term: String = word.chars().take(MAX_TERM_CHARS).collect();
        if term.is_empty() || terms.iter().any(|seen| seen == &term) {
            continue;
        }
        terms.push(term);
        if terms.len() == MAX_TERMS {
            break;
        }
    }
    terms
}

/// The FTS expression for `terms`: each term as a quoted phrase, all required.
///
/// Quoting is what makes the tokenizer treat a term as one thing rather than a query of its own
/// operators - and an embedded quote is doubled, which is how FTS5 escapes it.
fn match_expression(terms: &[String]) -> String {
    terms
        .iter()
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

/// `(file, matches)` for the sessions the index answers, most matches first.
fn fts_groups(conn: &Connection, terms: &[String], limit: usize) -> Vec<(String, i64)> {
    let expression = match_expression(terms);
    let Ok(mut statement) = conn.prepare(
        "SELECT t.file, COUNT(*) AS matches, MAX(t.rowid) AS newest
         FROM message_fts f JOIN message_text t ON t.rowid = f.rowid
         WHERE message_fts MATCH ?1
         GROUP BY t.file
         ORDER BY matches DESC, newest DESC
         LIMIT ?2",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = statement.query_map(params![expression, limit as i64], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok).collect()
}

/// One conversation's matched lines, with the match marked, newest first.
fn fts_snippets(conn: &Connection, terms: &[String], file: &str) -> Vec<Snippet> {
    let expression = match_expression(terms);
    let Ok(mut statement) = conn.prepare(
        "SELECT t.seq, t.role,
                snippet(message_fts, 0, char(1), char(2), '…', 24)
         FROM message_fts f JOIN message_text t ON t.rowid = f.rowid
         WHERE message_fts MATCH ?1 AND t.file = ?2
         ORDER BY t.seq DESC
         LIMIT ?3",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = statement.query_map(
        params![expression, file, SNIPPETS_PER_SESSION as i64],
        |row| {
            Ok(Snippet {
                seq: row.get(0)?,
                role: row.get(1)?,
                text: row.get(2)?,
            })
        },
    ) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok).collect()
}

/// `(file, matches)` for queries too short for the trigram index, most matches first.
///
/// Every term has to appear: `LIKE '%a%' AND LIKE '%b%'` is the honest reading of a two-word query,
/// and the bound is the number of indexed lines rather than the store's size - only conversation
/// text is in this table.
fn like_groups(conn: &Connection, terms: &[String], limit: usize) -> Vec<(String, i64)> {
    let mut sql = String::from(
        "SELECT file, COUNT(*) AS matches, MAX(rowid) AS newest FROM message_text WHERE ",
    );
    for index in 0..terms.len() {
        if index > 0 {
            sql.push_str(" AND ");
        }
        sql.push_str(&format!("text LIKE ?{} ESCAPE '\\'", index + 1));
    }
    sql.push_str(" GROUP BY file ORDER BY matches DESC, newest DESC LIMIT ");
    sql.push_str(&(limit as i64).to_string());
    let Ok(mut statement) = conn.prepare(&sql) else {
        return Vec::new();
    };
    let patterns: Vec<String> = terms.iter().map(|term| like_pattern(term)).collect();
    let borrowed: Vec<&dyn rusqlite::ToSql> = patterns
        .iter()
        .map(|pattern| pattern as &dyn rusqlite::ToSql)
        .collect();
    let Ok(rows) = statement.query_map(borrowed.as_slice(), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok).collect()
}

/// One conversation's matched lines for a query the index cannot answer.
fn like_snippets(conn: &Connection, terms: &[String], file: &str) -> Vec<Snippet> {
    let mut sql = String::from("SELECT seq, role, text FROM message_text WHERE file = ?1");
    for index in 0..terms.len() {
        sql.push_str(&format!(" AND text LIKE ?{} ESCAPE '\\'", index + 2));
    }
    sql.push_str(" ORDER BY seq DESC LIMIT ");
    sql.push_str(&(SNIPPETS_PER_SESSION as i64).to_string());
    let Ok(mut statement) = conn.prepare(&sql) else {
        return Vec::new();
    };
    let mut values: Vec<String> = vec![file.to_owned()];
    values.extend(terms.iter().map(|term| like_pattern(term)));
    let borrowed: Vec<&dyn rusqlite::ToSql> = values
        .iter()
        .map(|value| value as &dyn rusqlite::ToSql)
        .collect();
    let Ok(rows) = statement.query_map(borrowed.as_slice(), |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok)
        .map(|(seq, role, text)| Snippet {
            seq,
            role,
            text: marked_excerpt(&text, terms),
        })
        .collect()
}

/// A `LIKE` pattern for one term, with the pattern's own wildcards escaped so a search for `100%`
/// means those three characters.
fn like_pattern(term: &str) -> String {
    let mut pattern = String::with_capacity(term.len() + 2);
    pattern.push('%');
    for character in term.chars() {
        if matches!(character, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(character);
    }
    pattern.push('%');
    pattern
}

/// The text around the first occurrence of any term, with that occurrence marked.
///
/// Character-based rather than byte-based, so a window never splits a multi-byte character, and
/// case-insensitive for the Latin scripts where a reader types lowercase and the transcript has not.
fn marked_excerpt(text: &str, terms: &[String]) -> String {
    let haystack = text.to_lowercase();
    let mut found: Option<(usize, usize)> = None;
    for term in terms {
        let needle = term.to_lowercase();
        if let Some(byte) = haystack.find(&needle) {
            let start = haystack[..byte].chars().count();
            let length = needle.chars().count();
            found = Some(match found {
                Some((best, best_len)) if best <= start => (best, best_len),
                _ => (start, length),
            });
        }
    }
    let Some((start, length)) = found else {
        return text.chars().take(SNIPPET_RADIUS * 2).collect();
    };
    let characters: Vec<char> = text.chars().collect();
    let from = start.saturating_sub(SNIPPET_RADIUS);
    let to = (start + length + SNIPPET_RADIUS).min(characters.len());
    let mut snippet = String::new();
    if from > 0 {
        snippet.push('…');
    }
    for (index, character) in characters[from..to].iter().enumerate() {
        let absolute = from + index;
        if absolute == start {
            snippet.push(MARK_START);
        }
        snippet.push(*character);
        if absolute + 1 == start + length {
            snippet.push(MARK_END);
        }
    }
    if to < characters.len() {
        snippet.push('…');
    }
    snippet
}

/// How many characters of a message the index keeps: the bound [`MAX_INDEXED_CHARS`] states, in
/// characters rather than bytes so a CJK message is not cut at a third of the length.
pub(super) fn capped(text: &str) -> String {
    if text.chars().count() <= MAX_INDEXED_CHARS {
        return text.to_owned();
    }
    text.chars().take(MAX_INDEXED_CHARS).collect()
}
