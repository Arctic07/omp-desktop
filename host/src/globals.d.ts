/**
 * Minimal ambient declarations for the Bun globals this host uses.
 *
 * `@types/bun` is not a dependency of this repository and the host's package manifest must not
 * declare one, so only the surface the host and its smoke driver actually touch is declared here.
 */

declare global {
  /** A file handle backed by the filesystem or by the compiled binary's embedded assets. */
  interface BunFile {
    readonly size: number
    readonly name: string
    text(): Promise<string>
    arrayBuffer(): Promise<ArrayBuffer>
  }

  interface BunEnv {
    [key: string]: string | undefined
  }

  interface BunStdio {
    stream(): ReadableStream<Uint8Array>
  }

  /** The writable side of a spawned process's stdin. */
  interface BunSubprocessStdin {
    write(data: string): number
    flush(): void
    end(): void
  }

  /** A child process launched with piped stdio. */
  interface BunSubprocess {
    readonly pid: number
    readonly stdin: BunSubprocessStdin
    readonly stdout: ReadableStream<Uint8Array>
    readonly stderr: ReadableStream<Uint8Array>
    readonly exited: Promise<number>
    /** Terminates the child; a child that already exited ignores it. */
    kill(): void
  }

  interface BunSpawnOptions {
    cmd: string[]
    cwd?: string
    env?: Record<string, string>
    stdin?: 'pipe' | 'inherit' | 'ignore'
    stdout?: 'pipe' | 'inherit' | 'ignore'
    stderr?: 'pipe' | 'inherit' | 'ignore'
  }

  /** One diagnostic line the bundler produced. */
  interface BunBuildLog {
    readonly level: string
    readonly message: string
  }

  interface BunBuildOutput {
    readonly success: boolean
    readonly logs: readonly BunBuildLog[]
    /** Files a non-`compile` build wrote, in emission order. */
    readonly outputs?: readonly { readonly path: string; readonly kind: string }[]
  }

  /** Loader callback context handed to a build plugin. */
  interface BunPluginLoaderArgs {
    readonly path: string
  }

  /** Loader result a plugin returns to replace a module's contents. */
  interface BunPluginLoaderResult {
    readonly contents: string
    readonly loader: string
  }

  /** Resolver callback context handed to a build plugin. */
  interface BunPluginResolverArgs {
    readonly path: string
    readonly importer: string
    readonly namespace: string
  }

  interface BunPluginBuilder {
    onLoad(
      filter: { filter: RegExp; namespace?: string },
      callback: (args: BunPluginLoaderArgs) => BunPluginLoaderResult | undefined,
    ): void
    onResolve(
      filter: { filter: RegExp; namespace?: string },
      callback: (args: BunPluginResolverArgs) => { path: string; namespace?: string } | undefined,
    ): void
  }

  interface BunPlugin {
    readonly name: string
    setup(build: BunPluginBuilder): void
  }

  interface BunBuildOptions {
    entrypoints: string[]
    root?: string
    external?: string[]
    define?: Record<string, string>
    bytecode?: boolean
    /** `bun` keeps the bundle runnable by the runtime instead of inlining a browser polyfill set. */
    target?: 'bun' | 'node' | 'browser'
    /** Directory a non-`compile` build writes into; the build names the file after the entry. */
    outdir?: string
    /** Written output for a single-entry build; the plugin-less bundle path uses it. */
    outfile?: string
    minify?: boolean | { identifiers?: boolean; keepNames?: boolean }
    plugins?: BunPlugin[]
    compile?: {
      execArgv?: string[]
      outfile?: string
      target?: string
      executablePath?: string
      autoloadBunfig?: boolean
      autoloadDotenv?: boolean
      autoloadTsconfig?: boolean
      autoloadPackageJson?: boolean
      /**
       * `VERSIONINFO` and icon the Windows executable carries (`bun build --compile --windows-*`).
       *
       * Declared for `host/build.ts`, which must publish the product's own identity rather than
       * Bun's; the shipped host never touches it. `hideConsole` is deliberately absent: this Bun
       * version accepts it through the JS API and produces byte-identical output, so claiming it
       * would be a comment about a flag that does nothing (measured 2026-11-03).
       */
      windows?: {
        icon?: string
        title?: string
        publisher?: string
        version?: string
        description?: string
        copyright?: string
      }
    }
    throw?: boolean
  }

  /**
   * Version comparison, the engine's own rule for plugin updates.
   *
   * `marketplace/manager.ts` treats `order(catalog, installed) > 0` as an update and falls back to
   * inequality when a tag cannot be parsed; `order` throws for such a tag, which is the signal the
   * fallback keys on. `plugins-updates.ts` reuses it so both answers agree.
   */
  interface BunSemver {
    order(left: string, right: string): number
  }

  interface BunStatic {
    readonly version: string
    readonly env: BunEnv
    readonly stdin: BunStdio
    readonly argv: string[]
    readonly main: string
    readonly semver: BunSemver
    file(path: string): BunFile
    write(destination: string | BunFile, data: string | Uint8Array | BunFile): Promise<number>
    /** Zstd frame the `pi-natives` loader reads back with `Bun.zstdDecompressSync`. */
    zstdCompressSync(data: Uint8Array, options?: { level?: number }): Buffer
    /** The inverse, used by `scripts/provenance.ts` to read a frame back out of the built host. */
    zstdDecompressSync(data: Uint8Array): Buffer
    spawn(options: BunSpawnOptions): BunSubprocess
    /** Absolute path of a tool on this process's `PATH`, or `null` when it is not there. */
    which(tool: string): string | null
    build(options: BunBuildOptions): Promise<BunBuildOutput>
    resolveSync(specifier: string, parent: string): string
    /**
     * An HTTP server, declared for the two places that need one: the plugin-socket test and the
     * capability smoke both start a real WebSocket endpoint for the host to connect to (`Bun.serve`'s
     * `fetch`/`websocket` pair). The shipped host never serves anything - it speaks on stdin/stdout -
     * so this is the smallest declaration that lets those two files be type-checked honestly rather
     * than through a cast.
     */
    serve(options: BunServeOptions): BunServeHandle
  }

  interface BunServeOptions {
    readonly port: number
    fetch(request: Request, listener: { upgrade(request: Request): boolean }): Response | undefined
    readonly websocket: Readonly<Record<string, (socket: BunServerSocket, data: never) => void>>
    readonly hostname?: string
  }

  interface BunServeHandle {
    readonly port: number
    readonly url: string
    stop(force?: boolean): void
  }

  interface BunServerSocket {
    send(data: string | Uint8Array): number
    /** Hangs up this one socket; the test's echo endpoint uses it to end a stream. */
    close(code?: number, reason?: string): void
  }

  const Bun: BunStatic

  interface ImportMeta {
    /** Absolute directory of the module; Bun-specific and required by the build driver. */
    readonly dir: string
    /** Absolute path of the module. */
    readonly path: string
  }
}

export {}
