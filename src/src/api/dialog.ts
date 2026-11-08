import { open } from "@tauri-apps/plugin-dialog";

/**
 * The desktop's own folder picker.
 *
 * The one thing in this app that needs a path the reader cannot type: which folder to work in. The
 * dialog belongs to the system, so it arrives with the desktop's own places, history and keyboard
 * handling, and this only reports which folder was pointed at — or `null`, for a dialog dismissed.
 * Every guard on the path stays where it was: the desktop decides whether it will take it.
 */
export async function chooseFolder(title: string): Promise<string | null> {
  const chosen = await open({ directory: true, multiple: false, title });
  return typeof chosen === "string" ? chosen : null;
}

/**
 * The desktop's own file picker, for the files a prompt carries.
 *
 * `defaultPath` is where the dialog opens, and the composer passes the folder of the workspace the
 * conversation is in — a file picked for a project should start in that project rather than wherever
 * the dialog was last opened. The paths are all this reports: whether one of them may be attached is
 * `import_composer_files`' own answer, and a dialog that was dismissed is an empty list.
 */
export async function chooseFiles(title: string, defaultPath?: string): Promise<string[]> {
  const chosen = await open({ directory: false, multiple: true, title, defaultPath });
  if (Array.isArray(chosen)) return chosen;
  return chosen === null ? [] : [chosen];
}

/**
 * The package file an import reads: one of the two archives this build installs from.
 *
 * `.omp.zip` is the primary spelling and `.piplug` is read for packages written for the reference client;
 * the filter is a convenience, not a guard — the host unpacks and bounds whatever it is handed, so
 * a file picked through "All files" is still checked on that side.
 */
export async function choosePluginPackage(title: string): Promise<string | null> {
  const chosen = await open({
    directory: false,
    multiple: false,
    title,
    filters: [
      { name: "Plugin package", extensions: ["zip", "piplug"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return typeof chosen === "string" ? chosen : null;
}
