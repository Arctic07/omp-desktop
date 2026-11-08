use super::*;
use zip::write::SimpleFileOptions;

/// One entry of a fixture archive: a path and what it holds.
struct Entry {
    path: String,
    body: String,
}

fn entry(path: &str, body: impl Into<String>) -> Entry {
    Entry {
        path: path.to_owned(),
        body: body.into(),
    }
}

/// A fixture manifest with the three fields a catalogue entry carries.
fn manifest(name: &str, version: &str) -> String {
    format!(
            "{{\n  \"name\": \"{name}\",\n  \"version\": \"{version}\",\n  \"description\": \"A fixture\",\n  \"omp\": {{ \"extensions\": [\"index.js\"] }}\n}}\n"
        )
}

/// The one extension module every fixture package ships.
const MODULE: &str = "export default function () {}\n";

/// A scratch directory for one test, keyed by tag so parallel tests never share a tree.
fn scratch(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("omp-package-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("scratch");
    root
}

/// A fresh staging directory inside one test's scratch tree.
fn staging(root: &Path, tag: &str) -> PathBuf {
    let path = root.join(format!("staging-{tag}"));
    fs::create_dir_all(&path).expect("staging");
    path
}

/// Writes a zip archive holding the given entries, all stored as plain files.
fn archive(root: &Path, name: &str, entries: &[Entry]) -> PathBuf {
    let path = root.join(name);
    let file = File::create(&path).expect("archive");
    let mut zip = zip::write::ZipWriter::new(file);
    let options = SimpleFileOptions::default();
    for item in entries {
        zip.start_file(item.path.as_str(), options).expect("entry");
        zip.write_all(item.body.as_bytes()).expect("body");
    }
    zip.finish().expect("finish");
    path
}

/// A well-formed package: the manifest at the archive root, plus one extension module.
fn package_entries(version: &str) -> Vec<Entry> {
    vec![
        entry("package.json", manifest("demo-plugin", version)),
        entry("index.js", MODULE),
    ]
}

/// The catalogue a staging directory holds, as the host hands it to the engine's parser.
fn catalog_of(staging: &Path) -> Value {
    let text = fs::read_to_string(staging.join(".omp-plugin").join("marketplace.json"))
        .expect("catalogue file");
    serde_json::from_str(&text).expect("catalogue JSON")
}

/// The unzipped fixture at the archive root: the facts the install needs, and the catalogue the
/// engine has to be able to parse - name segments and a `./`-relative source.
#[test]
fn a_package_at_the_root_unpacks_and_names_its_catalogue() {
    let root = scratch("root");
    let file = archive(&root, "demo.omp.zip", &package_entries("1.2.3"));
    let staging = staging(&root, "one");

    let package = unpack(&file, &staging).expect("unpacked");
    assert_eq!(package.plugin_name, "demo-plugin");
    assert_eq!(package.catalog_name, "demo-plugin-import");
    assert_eq!(package.install_spec, "demo-plugin@demo-plugin-import");
    assert_eq!(package.version.as_deref(), Some("1.2.3"));
    assert_eq!(package.archive_sha256.len(), 64);
    assert!(staging.join(PACKAGE_ROOT_DIR).join("index.js").is_file());

    write_catalog(&staging, &package).expect("catalogue");
    let catalog = catalog_of(&staging);
    assert_eq!(catalog["name"], "demo-plugin-import");
    assert_eq!(catalog["owner"]["name"], CATALOG_OWNER);
    assert_eq!(catalog["plugins"][0]["name"], "demo-plugin");
    assert_eq!(catalog["plugins"][0]["source"], "./package");
    assert_eq!(catalog["plugins"][0]["version"], "1.2.3");
    let _ = fs::remove_dir_all(&root);
}

/// The shape an archive of a folder has: one directory holding the manifest, which the catalog
/// entry then has to address relatively for the engine to resolve it.
#[test]
fn a_package_inside_one_directory_is_found_and_addressed_relatively() {
    let root = scratch("nested");
    let file = archive(
        &root,
        "demo.piplug",
        &[
            entry("demo-plugin/package.json", manifest("demo-plugin", "0.0.1")),
            entry("demo-plugin/skills/one.md", "# one\n"),
        ],
    );
    let staging = staging(&root, "one");

    let package = unpack(&file, &staging).expect("unpacked");
    write_catalog(&staging, &package).expect("catalogue");
    assert_eq!(
        catalog_of(&staging)["plugins"][0]["source"],
        "./package/demo-plugin"
    );
    assert!(staging
        .join(PACKAGE_ROOT_DIR)
        .join("demo-plugin")
        .join("skills")
        .join("one.md")
        .is_file());
    let _ = fs::remove_dir_all(&root);
}

/// A manifest without a usable name is refused here rather than skipped by the engine's catalog
/// parser later, where the user would read "plugin not found" for a package they just picked.
#[test]
fn a_manifest_without_a_usable_name_is_refused() {
    for (tag, body) in [
        ("missing", "{ \"version\": \"1.0.0\" }\n".to_owned()),
        (
            "scoped",
            manifest("demo-plugin", "1.0.0").replace("demo-plugin", "@scope/demo"),
        ),
        ("empty", manifest("", "1.0.0")),
    ] {
        let root = scratch(tag);
        let staging = staging(&root, "one");
        let file = archive(&root, "demo.omp.zip", &[entry("package.json", body)]);
        let refusal = unpack(&file, &staging).expect_err("refused");
        assert!(refusal.message.contains("name"), "{}", refusal.message);
        let _ = fs::remove_dir_all(&root);
    }
    assert!(is_name_segment("demo-plugin"));
    assert!(is_name_segment("Demo.Plugin_2"));
    assert!(!is_name_segment("@scope/demo"));
    assert!(!is_name_segment("-leading"));
    assert!(!is_name_segment(""));
}

/// Two packages in one archive are not a package this application can describe, and an archive
/// holding none is not one either.
#[test]
fn an_archive_without_exactly_one_package_is_refused() {
    let root = scratch("shape");
    let two = archive(
        &root,
        "two.omp.zip",
        &[
            entry("one/package.json", manifest("one-plugin", "1.0.0")),
            entry("two/package.json", manifest("two-plugin", "1.0.0")),
        ],
    );
    let one_staging = staging(&root, "one");
    let refusal = unpack(&two, &one_staging).expect_err("refused");
    assert!(
        refusal.message.contains("exactly one"),
        "{}",
        refusal.message
    );

    let none = archive(&root, "none.omp.zip", &[entry("readme.md", "# nothing\n")]);
    let empty_staging = staging(&root, "two");
    let refusal = unpack(&none, &empty_staging).expect_err("refused");
    assert!(
        refusal.message.contains("package.json"),
        "{}",
        refusal.message
    );
    let _ = fs::remove_dir_all(&root);
}

/// The entry count is bounded before anything is written (spec §2.3), which is what keeps a
/// crafted archive from filling the staging directory with empty files.
#[test]
fn an_archive_over_the_entry_budget_is_refused() {
    let root = scratch("budget");
    let file = root.join("many.omp.zip");
    let writer = File::create(&file).expect("archive");
    let mut zip = zip::write::ZipWriter::new(writer);
    let options = SimpleFileOptions::default();
    zip.start_file("package.json", options).expect("manifest");
    zip.write_all(manifest("many-plugin", "1.0.0").as_bytes())
        .expect("manifest body");
    for index in 0..MAX_ENTRIES {
        zip.start_file(format!("file-{index}.txt"), options)
            .expect("entry");
        zip.write_all(b"x").expect("body");
    }
    zip.finish().expect("finish");

    let staging = staging(&root, "one");
    let refusal = unpack(&file, &staging).expect_err("refused");
    assert!(refusal.message.contains("entries"), "{}", refusal.message);
    let _ = fs::remove_dir_all(&root);
}

/// The package file's own path is checked before it is opened: a relative path, another suffix
/// or a directory never reaches the unpacker.
#[test]
fn the_picked_path_is_checked_before_it_is_read() {
    let root = scratch("path");
    let file = archive(&root, "demo.omp.zip", &package_entries("1.0.0"));
    assert!(archive_path(&file.to_string_lossy()).is_ok());
    assert!(archive_path("relative.omp.zip").is_err());
    assert!(archive_path(&root.to_string_lossy()).is_err());
    assert!(archive_path(&root.join("demo.txt").to_string_lossy()).is_err());
    assert!(archive_path(&root.join("demo.zip").to_string_lossy()).is_err());
    let _ = fs::remove_dir_all(&root);
}

/// Staging directories never collide, and a directory is never reused.
#[test]
fn staging_directories_are_fresh() {
    let root = scratch("staging");
    let import_root = root.join("plugin-import");
    let first = staging_dir(&import_root).expect("first");
    let second = staging_dir(&import_root).expect("second");
    assert_ne!(first, second);
    assert!(first.is_dir() && second.is_dir());
    // A staging directory is never mistaken for a promoted import: imports are named after the
    // catalogue they serve, staging directories start with a dot.
    assert!(
        first
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(".staging-")),
        "{first:?}"
    );
    let _ = fs::remove_dir_all(&root);
}

/// The mode mapping is a pure function, so it is asserted on the Windows development machine too
/// (spec §0.4): only the `chmod` syscall is `#[cfg(unix)]`. Setuid, setgid and sticky never
/// survive the mask.
#[test]
fn an_entry_mode_maps_to_writable_bits() {
    assert_eq!(writable_mode(None), None);
    assert_eq!(writable_mode(Some(0o755)), Some(0o755));
    assert_eq!(writable_mode(Some(0o644)), Some(0o644));
    assert_eq!(
        writable_mode(Some(0o100755)),
        Some(0o755),
        "the file-type bits are not permission bits"
    );
    assert_eq!(
        writable_mode(Some(0o4755)),
        Some(0o755),
        "setuid is dropped"
    );
    assert_eq!(
        writable_mode(Some(0o2755)),
        Some(0o755),
        "setgid is dropped"
    );
    assert_eq!(
        writable_mode(Some(0o1777)),
        Some(0o777),
        "the sticky bit is dropped"
    );
}

/// A leftover staging directory from a crashed import is swept on the way into the next one, and
/// nothing else in the import root is touched. `now` is injected, so the age rule is asserted
/// without waiting a day.
#[test]
fn stale_staging_directories_are_swept_and_fresh_ones_kept() {
    let root = scratch("sweep");
    let stale = root.join(format!("{STAGING_PREFIX}old-1"));
    let fresh = root.join(format!("{STAGING_PREFIX}new-1"));
    let promoted = root.join("demo-plugin-import");
    let not_a_directory = root.join(format!("{STAGING_PREFIX}file-1"));
    for directory in [&stale, &fresh, &promoted] {
        fs::create_dir_all(directory).expect("fixture directory");
    }
    fs::write(&not_a_directory, b"not a directory").expect("fixture file");

    // Nothing is old yet: a sweep at the current time keeps every staging directory, including a
    // concurrent import's.
    sweep_stale_staging(&root, SystemTime::now());
    assert!(stale.is_dir() && fresh.is_dir(), "young staging survives");
    assert!(promoted.is_dir() && not_a_directory.is_file());

    // Two days on, every staging directory is past the age - and only the staging directories
    // are considered: a promoted import and a stray file are not leftovers to sweep.
    sweep_stale_staging(&root, SystemTime::now() + Duration::from_secs(48 * 60 * 60));
    assert!(
        !stale.exists(),
        "a crashed import's staging directory is swept"
    );
    assert!(!fresh.exists(), "the whole staging prefix is swept, by age");
    assert!(promoted.is_dir(), "a promoted import is never a leftover");
    assert!(
        not_a_directory.is_file(),
        "only directories are swept, never a file that shares the prefix"
    );
    let _ = fs::remove_dir_all(&root);
}

/// A re-import replaces the package its catalogue points at, which is what makes the second
/// import an upgrade rather than a second install from a stale source.
#[test]
fn promoting_an_import_replaces_the_earlier_package() {
    let root = scratch("promote");
    let import_root = root.join("plugin-imports");
    let first = staging_dir(&import_root).expect("first");
    fs::create_dir_all(first.join(PACKAGE_ROOT_DIR)).expect("package");
    fs::write(
        first.join(PACKAGE_ROOT_DIR).join("package.json"),
        manifest("demo-plugin", "1.0.0"),
    )
    .expect("manifest");
    let target = import_root.join("demo-plugin-import");
    promote(&first, &target).expect("promoted");
    assert!(target.join(PACKAGE_ROOT_DIR).join("package.json").is_file());
    assert!(
        !first.exists(),
        "the staging directory moved rather than copied"
    );

    let second = staging_dir(&import_root).expect("second");
    fs::create_dir_all(second.join(PACKAGE_ROOT_DIR)).expect("package");
    fs::write(
        second.join(PACKAGE_ROOT_DIR).join("package.json"),
        manifest("demo-plugin", "2.0.0"),
    )
    .expect("manifest");
    promote(&second, &target).expect("replaced");
    let text =
        fs::read_to_string(target.join(PACKAGE_ROOT_DIR).join("package.json")).expect("manifest");
    assert!(text.contains("2.0.0"), "{text}");
    assert!(text.contains("demo-plugin"), "{text}");
    assert!(
        leftovers(&import_root).is_empty(),
        "a completed replacement leaves no staging name: {:?}",
        leftovers(&import_root)
    );
    let _ = fs::remove_dir_all(&root);
}

/// The guards run inside the unpacking, before anything beside them is written: an entry that
/// climbs out of the staging directory leaves no file behind, not even the manifest that came
/// after it.
#[test]
fn the_unpacking_refuses_an_escaping_entry_before_writing_anything() {
    let root = scratch("escape");
    let staging = staging(&root, "one");
    let file = archive(
        &root,
        "escape.omp.zip",
        &[
            entry("../escaped.txt", "outside\n"),
            entry("package.json", manifest("escape-plugin", "1.0.0")),
        ],
    );
    let refusal = unpack(&file, &staging).expect_err("refused");
    assert!(
        refusal.message.contains("escapes the extraction directory"),
        "{}",
        refusal.message
    );
    assert!(!root.join("escaped.txt").exists(), "nothing escaped");
    assert!(
        !staging.join(PACKAGE_ROOT_DIR).join("package.json").exists(),
        "the refusal stopped the entry after it too"
    );
    let _ = fs::remove_dir_all(&root);
}

/// A link entry is refused rather than followed: what a package writes has to be a plain file
/// for the rest of this layer to describe it.
#[test]
fn the_unpacking_refuses_a_link_entry() {
    let root = scratch("link");
    let staging = staging(&root, "one");
    let file = root.join("link.omp.zip");
    let writer = File::create(&file).expect("archive");
    let mut zip = zip::write::ZipWriter::new(writer);
    // `add_symlink` is what writes the mode bits that mark the entry as a symbolic link; the
    // body then names its target.
    zip.add_symlink(
        "package/link",
        "../../outside",
        SimpleFileOptions::default(),
    )
    .expect("link entry");
    let regular = SimpleFileOptions::default();
    zip.start_file("package/package.json", regular)
        .expect("manifest");
    zip.write_all(manifest("link-plugin", "1.0.0").as_bytes())
        .expect("manifest body");
    zip.finish().expect("finish");

    let refusal = unpack(&file, &staging).expect_err("refused");
    assert!(
        refusal.message.contains("link entry"),
        "{}",
        refusal.message
    );
    let _ = fs::remove_dir_all(&root);
}

/// The staging names one directory holds, sorted, so a test can assert that a failed step left
/// nothing half-written behind.
fn leftovers(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(directory)
        .expect("import root")
        .flatten()
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
        .filter(|name| name.starts_with(STAGING_PREFIX))
        .collect();
    names.sort();
    names
}

/// The promotion's rollback, as the rule it is: only a failure *before* the staged tree moved
/// leaves nothing to clean up, and every later failure drops the temporary tree - which is the
/// half-written import.
#[test]
fn a_failed_promotion_drops_only_the_half_written_import() {
    use super::PromoteRollback::*;
    use super::PromoteStep::*;
    assert_eq!(promote_rollback(StageToTemporary), Nothing);
    assert_eq!(promote_rollback(RemovePrevious), DropTemporary);
    assert_eq!(promote_rollback(TemporaryToTarget), DropTemporary);
}

/// A promotion that cannot complete leaves the import that was already installed exactly where it
/// was: the staged tree moves to a temporary name first, so nothing touches the target until the
/// new tree is safely beside it.
#[test]
fn a_failed_promotion_keeps_the_previous_import() {
    let root = scratch("promote-failure");
    let import_root = root.join("plugin-imports");
    let target = import_root.join("demo-plugin-import");
    fs::create_dir_all(target.join(PACKAGE_ROOT_DIR)).expect("previous import");
    fs::write(
        target.join(PACKAGE_ROOT_DIR).join("package.json"),
        manifest("demo-plugin", "1.0.0"),
    )
    .expect("previous manifest");

    // Nothing staged: the very first rename fails, and the installed import is untouched.
    let missing = import_root.join(format!("{STAGING_PREFIX}gone-1"));
    let error = promote(&missing, &target).expect_err("nothing to move");
    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    let text = fs::read_to_string(target.join(PACKAGE_ROOT_DIR).join("package.json"))
        .expect("previous manifest");
    assert!(text.contains("1.0.0"), "{text}");
    assert!(
        leftovers(&import_root).is_empty(),
        "nothing was left behind"
    );

    // A target that cannot be removed (a file, not a directory) fails the second step: the
    // temporary tree is the half-product and goes, and the old name stays where it is.
    let file_target = import_root.join("blocked-import");
    fs::write(&file_target, b"not a directory").expect("blocking file");
    let staged = staging(&import_root, "two");
    fs::write(staged.join("marker"), b"new import").expect("staged tree");
    promote(&staged, &file_target).expect_err("the old name cannot be removed");
    assert!(file_target.is_file(), "the old name is still there");
    assert!(
        !staged.exists(),
        "the staged tree moved to a temporary name rather than staying put"
    );
    assert!(
        leftovers(&import_root).is_empty(),
        "the half-product was dropped: {:?}",
        leftovers(&import_root)
    );
    let _ = fs::remove_dir_all(&root);
}

/// A successful promotion leaves no staging name behind: the tree moves through a temporary name
/// and ends as the target, so the next import's sweep has nothing of this one to take.
#[test]
fn a_completed_promotion_leaves_no_staging_name_behind() {
    let root = scratch("promote-clean");
    let import_root = root.join("plugin-imports");
    let first = staging_dir(&import_root).expect("first");
    fs::write(first.join("marker"), b"1.0.0").expect("staged tree");
    let target = import_root.join("demo-plugin-import");
    promote(&first, &target).expect("promoted");
    assert!(target.join("marker").is_file());
    assert!(
        leftovers(&import_root).is_empty(),
        "{:?}",
        leftovers(&import_root)
    );
    let _ = fs::remove_dir_all(&root);
}

/// The start-up sweep takes every staging name a previous run left - the directory a crashed
/// unpacking wrote, the name a crashed promotion was moving through, and the partial file a
/// crashed download wrote - and nothing else in the import root. It is the *start-up* rule, so
/// unlike the import-time sweep it does not care how old a leftover is.
#[test]
fn the_startup_sweep_removes_every_leftover_of_a_previous_run() {
    let root = scratch("startup-sweep");
    let import_root = root.join("plugin-imports");
    let crashed_unpack = import_root.join(format!("{STAGING_PREFIX}123-0"));
    let crashed_promote = import_root.join(format!("{STAGING_PREFIX}promote-123-1"));
    let crashed_download = download_staging_path(&import_root).expect("a download path");
    let promoted = import_root.join("demo-plugin-import");
    let unrelated = import_root.join("notes.txt");
    for directory in [&crashed_unpack, &crashed_promote, &promoted] {
        fs::create_dir_all(directory).expect("fixture directory");
    }
    fs::write(&crashed_download, b"half a package").expect("fixture download");
    fs::write(&unrelated, b"kept").expect("fixture file");
    let download_name = crashed_download
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_owned();
    assert!(
        download_name.starts_with(".staging-download-"),
        "{download_name}"
    );

    assert_eq!(sweep_staging(&import_root), 3);
    assert!(!crashed_unpack.exists());
    assert!(!crashed_promote.exists());
    assert!(!crashed_download.exists());
    assert!(promoted.is_dir(), "a promoted import is never a leftover");
    assert!(unrelated.is_file(), "only staging names are swept");
    // A second start with nothing left to take removes nothing.
    assert_eq!(sweep_staging(&import_root), 0);
    let _ = fs::remove_dir_all(&root);
}

/// Two download paths never collide, and the name they carry is the staging prefix the sweep
/// looks for rather than a package suffix a user's own file would have.
#[test]
fn download_paths_are_fresh_and_carry_the_staging_prefix() {
    let root = scratch("download-path");
    let import_root = root.join("plugin-imports");
    let first = download_staging_path(&import_root).expect("first");
    let second = download_staging_path(&import_root).expect("second");
    assert_ne!(first, second);
    assert!(first.parent() == Some(import_root.as_path()));
    for path in [&first, &second] {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        assert!(name.starts_with(".staging-download-"), "{name}");
        assert!(!path.exists(), "a fresh path names nothing yet");
    }
    let _ = fs::remove_dir_all(&root);
}

/// The preview reports what the file declares and what the guards found, and nothing else: the
/// permissions and hosts this build serves, the pages and modules the manifest names, and the
/// checksum list's own state - which is a fact rather than a refusal on this path.
#[test]
fn an_inspection_reports_the_manifest_and_the_checksum_state() {
    use sha2::{Digest, Sha256};

    let root = scratch("inspect");
    let module_digest = format!("{:x}", Sha256::digest(MODULE.as_bytes()));
    let body = "{\n  \"name\": \"inspect-plugin\",\n  \"version\": \"2.1.0\",\n  \"description\": \"A fixture\",\n  \"omp\": {\n    \"extensions\": [\"index.js\"],\n    \"desktop\": {\n      \"schemaVersion\": 1,\n      \"permissions\": [\"ui.panel\", \"not.a.permission\"],\n      \"netDomains\": [\"api.example.com\", \"not a host\"],\n      \"panels\": [{\"id\": \"p\", \"entry\": \"index.html\"}],\n      \"sidebarTabs\": [{\"id\": \"t\", \"entry\": \"index.html\"}]\n    }\n  }\n}\n".to_string();
    let file = archive(
        &root,
        "inspect.omp.zip",
        &[
            entry("package.json", body),
            entry("index.js", MODULE),
            entry(
                "checksums.json",
                format!("{{\"files\": {{\"index.js\": \"{module_digest}\"}}}}"),
            ),
        ],
    );
    let staging = staging(&root, "one");
    let inspection = inspect(&file, &staging).expect("inspected");
    assert_eq!(inspection.name, "inspect-plugin");
    assert_eq!(inspection.version.as_deref(), Some("2.1.0"));
    assert_eq!(inspection.description.as_deref(), Some("A fixture"));
    // The two lists are filtered by the rules the plugin row applies: a permission this build
    // does not serve and a name that is not a host are not reported as reachable.
    assert_eq!(inspection.permissions, vec!["ui.panel".to_owned()]);
    assert_eq!(inspection.net_domains, vec!["api.example.com".to_owned()]);
    assert_eq!(inspection.page_count, 2, "one panel and one sidebar tab");
    assert!(inspection.has_extensions);
    assert!(inspection.checksum_verified);
    assert_eq!(inspection.checksum_count, 1);
    assert_eq!(
        inspection.sha256,
        digest_of(&file).expect("the archive's own digest")
    );
    // The preview unpacks; removing the tree is the caller's job, exactly as on the install path.
    assert!(staging.join(PACKAGE_ROOT_DIR).join("index.js").is_file());
    let _ = fs::remove_dir_all(&root);
}

/// A package that ships no checksum list - the ordinary case for a local file - is reported as
/// unverified with nothing listed, and a list that does not match the files it lists is reported
/// the same way: the preview answers, the install path is what refuses.
#[test]
fn an_inspection_reports_an_unverified_package_without_refusing_it() {
    let root = scratch("inspect-checksums");

    // No list at all.
    let plain = archive(&root, "plain.omp.zip", &package_entries("1.0.0"));
    let plain_staging = staging(&root, "plain");
    let inspection = inspect(&plain, &plain_staging).expect("inspected");
    assert!(!inspection.checksum_verified);
    assert_eq!(inspection.checksum_count, 0);
    assert!(
        inspection.has_extensions,
        "the fixture manifest declares `omp.extensions`"
    );
    assert_eq!(inspection.page_count, 0, "it declares no pages");

    // A list whose digest is not the file's: still an answer, still the count the list covers.
    let wrong = archive(
        &root,
        "wrong.omp.zip",
        &[
            entry("package.json", manifest("demo-plugin", "1.0.0")),
            entry("index.js", MODULE),
            entry(
                "checksums.json",
                format!("{{\"files\": {{\"index.js\": \"{}\"}}}}", "0".repeat(64)),
            ),
        ],
    );
    let wrong_staging = staging(&root, "wrong");
    let inspection = inspect(&wrong, &wrong_staging).expect("inspected");
    assert!(!inspection.checksum_verified);
    assert_eq!(inspection.checksum_count, 1);

    // The unpacking guards still run first: an archive that climbs out of the staging directory
    // is refused by the preview exactly as the install refuses it.
    let escaping = archive(
        &root,
        "escaping.omp.zip",
        &[
            entry("../escaped.txt", "outside\n"),
            entry("package.json", manifest("escape-plugin", "1.0.0")),
        ],
    );
    let escaping_staging = staging(&root, "escaping");
    let refusal = inspect(&escaping, &escaping_staging).expect_err("refused");
    assert!(
        refusal.message.contains("escapes the extraction directory"),
        "{}",
        refusal.message
    );
    assert!(!root.join("escaped.txt").exists(), "nothing escaped");
    let _ = fs::remove_dir_all(&root);
}

/// The integration half of the permission behaviour: it reads the bits the filesystem actually
/// carries, so it only exists where the filesystem has Unix permission bits.
///
/// **This module does not run on the Windows development machine.** `cargo test` there covers
/// [`writable_mode`] (the mapping), but the `chmod` in [`apply_entry_mode`] and the assertion
/// below are Unix-only, so the end-to-end permission behaviour must be verified on a Unix CI
/// (spec §0.4: the platform condition wraps the syscall, and this records the gap instead of
/// passing silently).
#[cfg(unix)]
mod unix_tests {
    use super::super::{unpack, PACKAGE_ROOT_DIR};
    use super::{manifest, scratch, staging};
    use std::fs::{self, File};
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    /// A shipped helper is executable where it lands, on the platforms that have the bit: a plugin
    /// whose skills or MCP configuration invoke its own binary is otherwise installed broken.
    #[test]
    fn an_entrys_permissions_are_restored() {
        use std::os::unix::fs::PermissionsExt;

        let root = scratch("mode");
        let file = root.join("mode.omp.zip");
        let writer = File::create(&file).expect("archive");
        let mut zip = zip::write::ZipWriter::new(writer);
        zip.start_file(
            "package.json",
            SimpleFileOptions::default().unix_permissions(0o644),
        )
        .expect("manifest");
        zip.write_all(manifest("mode-plugin", "1.0.0").as_bytes())
            .expect("manifest body");
        zip.start_file(
            "bin/helper",
            SimpleFileOptions::default().unix_permissions(0o755),
        )
        .expect("helper");
        zip.write_all(b"#!/bin/sh\n").expect("helper body");
        zip.start_file(
            "bin/setuid",
            SimpleFileOptions::default().unix_permissions(0o4755),
        )
        .expect("setuid helper");
        zip.write_all(b"#!/bin/sh\n").expect("setuid body");
        zip.finish().expect("finish");

        let staging = staging(&root, "one");
        unpack(&file, &staging).expect("unpacked");
        let helper = staging.join(PACKAGE_ROOT_DIR).join("bin").join("helper");
        let mode = fs::metadata(&helper)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o755, "the entry's mode travels");

        let setuid = staging.join(PACKAGE_ROOT_DIR).join("bin").join("setuid");
        let mode = fs::metadata(&setuid)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o7777;
        assert_eq!(
            mode, 0o755,
            "a privilege bit never reaches an unpacked file"
        );
        let _ = fs::remove_dir_all(&root);
    }
}
