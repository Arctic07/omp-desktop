/**
 * One session name as this host may compose with it.
 *
 * The engine asks its title model for `<title>…</title>` and parses only that ASCII marker, so a
 * model that translates the tag leaves the envelope inside the name
 * (`<标题>修复浏览器 agent 蒙版错位与 GPU 卡顿</标题>`). The Rust boundary cleans a name before it
 * is shown; a name this host *builds* - `Fork of …` - has to start from the words instead, or the
 * child carries the parent's envelope inside its own title and no display-time rule can tell the
 * envelope from the name.
 *
 * Only a matching pair wrapping the whole name is taken, so a name that quotes markup
 * (`修复嵌套的 <div></div> 渲染`) keeps it, and nesting is peeled one layer at a time because a
 * model can wrap a translated marker in an ASCII one. An empty marker (`<标题/>`, the model's "no
 * name") answers with the empty string, which callers read as "nothing to compose with".
 *
 * Mirrors `clean_title_text`'s wrapper rule in `src-tauri/src/services/session_title.rs`: the two
 * layers read the same engine output, so the rule has to agree.
 */
export function sessionTitleText(title: string | null | undefined): string {
  let body = (title ?? '').trim()
  for (;;) {
    const match = /^<([^\s<>/]{1,32})(?:\s[^<>]*)?>([\s\S]*)<\/\1\s*>$/iu.exec(body)
    if (match === null) break
    body = match[2].trim()
  }
  // An empty marker (`<标题/>`) is the model's "no name".
  return /^<[^\s<>/]+\s*\/>$/u.test(body) ? '' : body
}
