//! The stylesheet boundary, rule by rule: one test per thing a theme's `css` may not do, and one per
//! thing it may.
//!
//! Split from the module (`rules.md#single-file-line-limit`): the assertions are the specification of the sanitizer,
//! and none of them runs in the application.

use std::fs::{self, File};
use std::path::{Path, PathBuf};

use super::*;

/// A scratch package root for one test, keyed by tag so parallel tests never share a tree.
fn scratch(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("omp-theme-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("scratch");
    root
}

/// One file inside a scratch package, with its parent directories made.
fn write(root: &Path, relative: &str, body: &[u8]) -> PathBuf {
    let path = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("parent");
    }
    fs::write(&path, body).expect("write");
    path
}

/// One file of `len` bytes inside a scratch package, without writing the bytes: the caps are read
/// from the filesystem, so the size is the only fact the test needs.
fn write_sized(root: &Path, relative: &str, len: u64) -> PathBuf {
    let path = write(root, relative, b"");
    File::options()
        .write(true)
        .open(&path)
        .expect("open")
        .set_len(len)
        .expect("resize");
    path
}

/// The origin one installation's assets are served from, derived the way every other URL is.
fn origin() -> String {
    pages::origin_of("demo-plugin", "user")
}

/// The `(declared path, served URL)` pairs a theme with one asset produces.
fn declared(path: &str) -> Vec<(String, String)> {
    let url = pages::page_url(&origin(), path).expect("the asset is addressable");
    vec![(path.to_owned(), url)]
}

/// One theme's declared content as the caller passes it.
fn prepare_in(root: &Path, css: Option<&str>, assets: &[&str]) -> Result<Prepared, CssRefusal> {
    let declared: Vec<String> = assets.iter().map(|asset| (*asset).to_owned()).collect();
    prepare(root, &origin(), css, &declared)
}

/// A stylesheet with no `url()` and no forbidden construct comes back exactly as written.
#[test]
fn a_benign_stylesheet_passes_unchanged() {
    let text =
        "/* midnight */\n:root {\n  --omp-radius: 6px;\n}\n.btn:hover { border-radius: 12px }\n";
    assert_eq!(
        sanitize(text, "desktop/themes/midnight.css", &[]).expect("a benign stylesheet"),
        text
    );
}

/// `@import` loads a document from somewhere this build does not serve, in any spelling.
#[test]
fn an_import_is_refused() {
    for sample in [
        "@import url(\"https://example.test/x.css\");",
        "@IMPORT 'other.css';",
        "a{background:red}\n@import \"x.css\";",
        "@importurl(x.css);",
    ] {
        assert_eq!(
            sanitize(sample, "a.css", &[]),
            Err(CssRefusal::Import),
            "{sample}"
        );
    }
}

/// The historical script doors - in a `url()` and in a plain declaration - are refused, as are the
/// two binding properties.
#[test]
fn script_doors_and_bindings_are_refused() {
    assert_eq!(
        sanitize(
            "a{background:url(\"javascript:alert(1)\")}",
            "a.css",
            &declared("desktop/bg.png")
        ),
        Err(CssRefusal::Script)
    );
    assert_eq!(
        sanitize(
            "a{background:JAVASCRIPT:alert(1)}",
            "a.css",
            &declared("desktop/bg.png")
        ),
        Err(CssRefusal::Script)
    );
    assert_eq!(
        sanitize("a{width:expression(alert(1))}", "a.css", &[]),
        Err(CssRefusal::Expression)
    );
    assert_eq!(
        sanitize("a{width:expression (alert(1))}", "a.css", &[]),
        Err(CssRefusal::Expression)
    );
    assert_eq!(
        sanitize("a{behavior:url(#default#time2)}", "a.css", &[]),
        Err(CssRefusal::Behavior)
    );
    assert_eq!(
        sanitize("a{-moz-binding:url(x.xml#y)}", "a.css", &[]),
        Err(CssRefusal::Binding)
    );
}

/// The four markup tokens only make sense to a parser that is about to treat this text as HTML, so
/// each is refused rather than escaped: this text is injected as a text node and never parsed.
#[test]
fn markup_escapes_are_refused() {
    for sample in ["<style>a{}</style>", "</style>", "<!-- a{} -->", "a{}\n-->"] {
        assert_eq!(
            sanitize(sample, "a.css", &[]),
            Err(CssRefusal::Markup),
            "{sample}"
        );
    }
}

/// A control character is not something a stylesheet needs, and a `\0` in an injected text node is a
/// truncation waiting to happen. Tab, line feed and carriage return are the three exceptions.
#[test]
fn a_control_character_is_refused() {
    assert_eq!(
        sanitize("a\u{0}{\n\tcolor: red;\r\n}", "a.css", &[]),
        Err(CssRefusal::ControlCharacter)
    );
    assert_eq!(
        sanitize("a\u{1b}b{color:red}", "a.css", &[]),
        Err(CssRefusal::ControlCharacter)
    );
    assert_eq!(
        sanitize("a\u{7f}b{color:red}", "a.css", &[]),
        Err(CssRefusal::ControlCharacter)
    );
    assert!(
        sanitize("a{\n\tcolor: red;\r\n}\n", "a.css", &[]).is_ok(),
        "tab, line feed and carriage return are ordinary whitespace"
    );
}

/// A `url()` may name a declared asset and nothing else: not a sibling file the theme forgot to
/// declare, not an absolute path, not a climb out of the package, not another origin, not a query.
#[test]
fn an_undeclared_or_unaddressable_url_is_refused() {
    let assets = declared("desktop/themes/bg.svg");
    for sample in [
        "a{background:url(desktop/themes/other.svg)}",
        "a{background:url(/etc/passwd)}",
        "a{background:url(../../secret.svg)}",
        "a{background:url(https://example.test/bg.svg)}",
        "a{background:url(//example.test/bg.svg)}",
        "a{background:url(other-origin.example/bg.svg)}",
        "a{background:url(bg.svg?v=1)}",
        "a{background:url(bg.svg#icon)}",
        "a{background:url(data:image/svg+xml;base64,AA\"A)}",
        "a{background:url(\"\")}",
    ] {
        assert_eq!(
            sanitize(sample, "desktop/themes/midnight.css", &assets),
            Err(CssRefusal::UndeclaredAsset),
            "{sample}"
        );
    }
}

/// A `data:` URI is its own content rather than a second file to address, so it is carried as it was
/// written - which is how a theme ships a tiny inline icon.
#[test]
fn a_data_uri_is_carried_as_written() {
    let text = "a{background:url(\"data:image/svg+xml;base64,PHN2Zy8+\")}";
    assert_eq!(
        sanitize(text, "a.css", &[]).expect("a data URI needs no declared asset"),
        text
    );
}

/// Every allowed spelling of a declared asset is rewritten to the one absolute URL form this
/// codebase serves a plugin's file from, and nothing else in the text changes.
#[test]
fn a_declared_asset_is_rewritten_to_its_served_url() {
    let served = pages::page_url(&origin(), "desktop/themes/bg.svg").expect("addressable");
    let assets = declared("desktop/themes/bg.svg");
    let text = ".a{background:url(bg.svg)}\n.b{background:url('desktop/themes/bg.svg')}\n\
                .c{background:url(../themes/bg.svg)}\n.d{background:url(\"./bg.svg\")}\n\
                .e{background:url(desktop/themes/bg.svg)}";
    let rewritten =
        sanitize(text, "desktop/themes/midnight.css", &assets).expect("declared assets");
    assert_eq!(
        rewritten,
        format!(
            ".a{{background:url(\"{served}\")}}\n.b{{background:url(\"{served}\")}}\n\
             .c{{background:url(\"{served}\")}}\n.d{{background:url(\"{served}\")}}\n\
             .e{{background:url(\"{served}\")}}"
        )
    );
    assert!(
        served.starts_with(&origin()),
        "the URL is the installation's own: {served}"
    );
}

/// An already-served URL is accepted for the same asset: a theme may spell the address it will be
/// given, and it is normalised to that same address.
#[test]
fn a_served_url_is_accepted_and_normalised() {
    let served = pages::page_url(&origin(), "desktop/themes/bg.svg").expect("addressable");
    let text = format!("a{{background:url({served})}}");
    assert_eq!(
        sanitize(
            &text,
            "desktop/themes/midnight.css",
            &declared("desktop/themes/bg.svg")
        )
        .expect("the served form names a declared asset"),
        format!("a{{background:url(\"{served}\")}}")
    );
}

/// A stylesheet over the ceiling is refused from the real size on disk, not from anything a manifest
/// said.
#[test]
fn an_oversize_stylesheet_is_refused() {
    let root = scratch("oversize");
    write_sized(&root, "desktop/themes/big.css", CSS_MAX_BYTES + 1);
    assert_eq!(
        prepare_in(&root, Some("desktop/themes/big.css"), &[]),
        Err(CssRefusal::TooLarge)
    );

    let root = scratch("exactly-max");
    let body = "a{}".repeat((CSS_MAX_BYTES / 3) as usize);
    write(&root, "desktop/themes/max.css", body.as_bytes());
    assert!(
        prepare_in(&root, Some("desktop/themes/max.css"), &[]).is_ok(),
        "a stylesheet at the ceiling is carried"
    );
}

/// An unbalanced comment, quote or brace is refused: this layer will not hand the renderer text whose
/// end it cannot find.
#[test]
fn an_unbalanced_construct_is_refused() {
    for sample in [
        "a{color:red",
        "a{color:red}}",
        "a{content:\"unterminated}",
        "a{color:red} /* never closed",
        "a{background:url(\"x.svg}",
        "a{content:'}",
    ] {
        assert_eq!(
            sanitize(sample, "a.css", &[]),
            Err(CssRefusal::Unbalanced),
            "{sample}"
        );
    }
}

/// One leading `@charset` is accepted and dropped; any second one names an encoding this layer does
/// not honour, because the text is injected rather than linked.
#[test]
fn a_leading_charset_is_dropped_and_a_later_one_is_refused() {
    assert_eq!(
        sanitize("@charset \"UTF-8\";\na{color:red}", "a.css", &[]).expect("one leading charset"),
        "a{color:red}"
    );
    assert_eq!(
        sanitize("\u{feff}@CHARSET 'utf-8';a{}", "a.css", &[]).expect("a BOM and another casing"),
        "a{}"
    );
    for sample in [
        "@charset \"utf-8\";\n@charset \"utf-8\";\na{}",
        "a{}\n@charset \"utf-8\";",
        "@charset\"utf-8\";a{}",
        "@charset;",
    ] {
        assert_eq!(
            sanitize(sample, "a.css", &[]),
            Err(CssRefusal::Charset),
            "{sample}"
        );
    }
}

/// A backslash outside a string is refused: it is the one way to spell a keyword the substring scan
/// would not see (`@im\port`), and no theme needs one.
#[test]
fn an_escape_outside_a_string_is_refused() {
    assert_eq!(
        sanitize("@im\\port \"x.css\";", "a.css", &[]),
        Err(CssRefusal::Escape)
    );
    assert!(
        sanitize("a::after{content:\"\\2014\"}", "a.css", &[]).is_ok(),
        "an escape inside a string is ordinary CSS text"
    );
}

/// The asset list is bounded, and every declared file is read from the package: a missing file, a
/// count over the ceiling and a total over the ceiling are all refusals.
#[test]
fn declared_assets_are_bounded_and_must_exist() {
    let root = scratch("assets");
    write(&root, "desktop/bg.svg", b"<svg/>");

    let many: Vec<String> = (0..=ASSETS_MAX)
        .map(|index| format!("desktop/{index}.svg"))
        .collect();
    assert_eq!(
        prepare(&root, &origin(), None, &many),
        Err(CssRefusal::TooManyAssets)
    );

    assert_eq!(
        prepare_in(&root, None, &["desktop/missing.png"]),
        Err(CssRefusal::MissingFile)
    );

    let root = scratch("assets-total");
    for index in 0..3 {
        write_sized(
            &root,
            &format!("desktop/big{index}.png"),
            ASSETS_TOTAL_MAX_BYTES / 2,
        );
    }
    assert_eq!(
        prepare_in(
            &root,
            None,
            &["desktop/big0.png", "desktop/big1.png", "desktop/big2.png"]
        ),
        Err(CssRefusal::AssetsTooLarge)
    );
}

/// A declared path this layer will not resolve - a dependency tree, a wrong extension, an absolute
/// path, a climb out of the package - is refused before any file is read.
#[test]
fn an_unservable_declared_path_is_refused() {
    let root = scratch("paths");
    write(&root, "node_modules/pkg/bg.svg", b"<svg/>");
    write(&root, "desktop/themes/not-css.svg", b"<svg/>");
    write(&root, "desktop/bg.svg", b"<svg/>");

    assert_eq!(
        prepare_in(&root, None, &["node_modules/pkg/bg.svg"]),
        Err(CssRefusal::UnsafePath)
    );
    assert_eq!(
        prepare_in(&root, Some("desktop/themes/not-css.svg"), &[]),
        Err(CssRefusal::UnsafePath),
        "a theme stylesheet is a `.css`"
    );
    assert_eq!(
        prepare_in(&root, Some("../outside.css"), &[]),
        Err(CssRefusal::UnsafePath)
    );
    assert_eq!(
        prepare_in(&root, None, &["/desktop/bg.svg"]),
        Err(CssRefusal::UnsafePath)
    );
}

/// The closed extension list the resolver asks about is the one [`prepare`] accepts.
#[test]
fn the_asset_extension_list_is_closed() {
    for path in [
        "a/bg.svg",
        "a/bg.PNG",
        "a/bg.jpg",
        "a/bg.jpeg",
        "a/bg.webp",
        "a/bg.avif",
        "a/bg.woff2",
    ] {
        assert!(is_theme_asset_path(path), "{path}");
    }
    for path in [
        "a/bg.gif",
        "a/bg.woff",
        "a/bg.html",
        "a/bg.js",
        "a/bg.css",
        "a/no-extension",
    ] {
        assert!(!is_theme_asset_path(path), "{path}");
    }
}

/// A stylesheet may only paint with the assets its theme declared, and the URLs it is rewritten to
/// are the ones the protocol will actually answer - the same builder a page's entry uses.
#[test]
fn a_stylesheet_is_rewritten_against_the_served_origin() {
    let root = scratch("rewrite");
    write(
        &root,
        "desktop/themes/midnight.css",
        b"a{background:url(bg.svg)}",
    );
    write(&root, "desktop/themes/bg.svg", b"<svg/>");
    let prepared = prepare_in(
        &root,
        Some("desktop/themes/midnight.css"),
        &["desktop/themes/bg.svg"],
    )
    .expect("declared content");
    let served = pages::page_url(&origin(), "desktop/themes/bg.svg").expect("addressable");
    assert_eq!(prepared.assets, vec![served.clone()]);
    assert_eq!(
        prepared.css.as_deref(),
        Some(format!("a{{background:url(\"{served}\")}}").as_str())
    );
}
