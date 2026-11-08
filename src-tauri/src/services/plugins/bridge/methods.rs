//! The method names this build's bridge serves: one table, three questions about it.
//!
//! [`BridgeMethod`] is the closed vocabulary of `bridge.rs`: `parse` turns one string into one
//! method (exact comparison - a method name is a token, and a near miss is a call this build does not
//! serve), `takes_params` says which of them arrive as a `POST` body rather than a query, and `judge`
//! (in `super`) decides what each one may do. The table lives in its own file because it is the *only*
//! place the vocabulary is written down: every surface - a page's `fetch('/__bridge')`, a worker's
//! `worker_invoke`, the tests - names a method through this file or not at all, and a change to the
//! set of served methods shows up here as one diff rather than as a search across modules.

/// One method this build serves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BridgeMethod {
    /// The page announcing itself; answered so a page can tell a reachable bridge from a broken one.
    Ready,
    /// A panel page asking for its own window to close.
    Close,
    /// One file inside the installation, read through the four gates (spec §6.3).
    FsRead,
    /// One network request, on the hosts the manifest lists and no others (spec §6.4).
    NetFetch,
    /// The system clipboard's text, read once the user has answered for it (spec §6.2).
    ClipboardRead,
    /// The system clipboard's text, replaced once the user has answered for it.
    ClipboardWrite,
    /// A notice the plugin wants the user to see (spec §6.2: in this application, and the system's
    /// own when the window is not what the user is looking at).
    Notify,
    /// One file inside the installation, replaced through the same four gates (spec §6.3).
    FsWrite,
    /// One file inside the installation, moved to the system's trash through the same gates.
    FsDelete,
    /// What is at one path: its kind, its size, when it was last written (`omp.desktop` API 0.3.0).
    ///
    /// It is the read gate's reach with a directory allowed, because a plugin that may reach a whole
    /// disk still has no way to learn what is on it from `fs.read` and `fs.list` alone - and the two
    /// are the difference between a reach that is granted and a reach that is usable.
    FsStat,
    /// The entries directly inside one directory, bounded (API 0.3.0).
    FsList,
    /// Every entry a `/`-separated pattern names, below the pattern's own literal prefix
    /// (`omp.desktop` API 0.3.0).
    ///
    /// It is the second half of the reach `fs.stat` and `fs.list` opened: walking a tree one
    /// directory at a time is a reach that exists but cannot be used, and a pattern is how a plugin
    /// asks "what is under here" in one call. The pattern language is the manifest's own
    /// `fs.read.scope` language (`gates::validate_scope_pattern`, `gates::scope_matches`), so an
    /// author who declared a scope already knows how to spell one.
    FsGlob,
    /// One byte range of one file, read through the read gate (API 0.3.0).
    ///
    /// `fs.read` answers a whole file or refuses it as too large; a plugin that wants a header, a
    /// tail or a slice out of a large file had no way to ask for one, and reading the whole file to
    /// take 4 KiB of it is the one shape the byte ceiling cannot serve.
    FsReadRange,
    /// One path handed to the system's *default program* (API 0.3.0). High risk in the one way this
    /// surface has: the default handler for an executable extension is the program itself, so the
    /// path is the thing being trusted. It has its own permission, its own gates and its own
    /// refusal, and never shares `fs.read`'s sentence.
    FsOpenDefault,
    /// One path shown to the user in this machine's own file manager (API 0.3.0).
    ///
    /// The harmless half of the pair above - nothing is launched but the shell's own window - and a
    /// separate permission for that reason: a plugin that wants to point at a file does not have to
    /// ask for the ability to hand one to a program.
    FsReveal,
    /// One line the plugin wants in this application's own log (`services::log`): what a page cannot
    /// reach through a console nobody can see.
    Log,
    /// The conversation index this application already lists (API 0.2.0): read-only, paged.
    SessionList,
    /// One conversation's metadata.
    SessionGet,
    /// One conversation's messages, paged, with bodies only as far as the caller asks for by name.
    SessionMessages,
    /// One conversation's title, changed (API 0.3.0).
    ///
    /// The first half of the session surface that *writes*. High risk in the plain sense: it changes
    /// something the user owns, so it has its own permission (`session.write`), never shares
    /// `session.read`'s sentence, and is consented separately.
    SessionRename,
    /// One conversation, deleted (API 0.3.0): its files leave the disk.
    SessionDelete,
    /// The token and cost accounting this application already computes from the engine's session
    /// entries, one row per model call.
    UsageTurns,
    /// One completion on the models this application is already configured with (API 0.2.0). High
    /// risk: it spends the user's money, so it has its own first-use question.
    AgentComplete,
    /// One message on the plugin bus, inside the publisher's own `plugin:<owner>/…` namespace.
    BusPublish,
    /// The topics this installation wants delivered. Resident processes only.
    BusSubscribe,
    /// One WebSocket, opened through this application's client on an address `net.domains` allows.
    WebSocketConnect,
    /// One text frame on a socket this installation opened.
    WebSocketSend,
    /// One socket, closed by this application.
    WebSocketClose,
    /// Whatever a socket has buffered, waiting at most the caller's `waitMs`.
    WebSocketReceive,
    /// One address handed to the system's own browser (API 0.2.0): the machine's default handler,
    /// not a page this application hosts.
    ShellOpenExternal,
    /// One of the seven browser verbs, answered by this application's **own** built-in browser
    /// (`services::browser`, API 0.3.0).
    ///
    /// It is a reach the desktop already has and the agent already uses; what is new is that a
    /// plugin may ask for it. The plugin gets a page of its own — never the reader's tab, never
    /// another conversation's — and the address it opens is held to its own `net.domains` list, so
    /// "the browser I can drive" is an egress like every other one. One permission (`browser.use`)
    /// covers the seven, because they are one page: snapshotting what `navigate` opened is not a
    /// second capability.
    BrowserNavigate,
    /// Answers whether the plugin's own browser page exists; the work panel draws nothing for an
    /// installation (`capabilities::BrowserRequest::Reveal`).
    BrowserReveal,
    /// The accessibility tree of the plugin's page.
    BrowserSnapshot,
    /// One image of the plugin's page.
    BrowserScreenshot,
    /// One expression evaluated in the plugin's page.
    BrowserEvaluate,
    /// What the plugin's page has logged.
    BrowserConsole,
    /// One navigation action (`back`, `forward`, `reload`, `stop`).
    BrowserAction,
    /// The one directory this installation may write freely (`omp.desktop` API 0.3.0).
    ///
    /// It is the answer to the question every plugin that remembers anything has to ask: a worker's
    /// working directory is its own package inside a versioned install cache, and its environment
    /// carries no home, so before this method there was no directory a plugin owned and no place it
    /// could put a cache, a database or a downloaded file that would survive an upgrade. Like
    /// [`Self::Ready`] and [`Self::Close`] it carries no permission: the directory is this
    /// application's own, holding nothing the plugin did not write there itself.
    PluginDataDir,
}

impl BridgeMethod {
    /// The method one name spells, or `None` when it names none this build serves.
    ///
    /// The comparison is exact - no trimming, no case folding - because a method name is a token of
    /// this API and a near miss is a call this build does not serve.
    pub(crate) fn parse(name: &str) -> Option<Self> {
        match name {
            "ready" => Some(Self::Ready),
            "close" => Some(Self::Close),
            "fs.read" => Some(Self::FsRead),
            "net.fetch" => Some(Self::NetFetch),
            "clipboard.read" => Some(Self::ClipboardRead),
            "clipboard.write" => Some(Self::ClipboardWrite),
            "notify" => Some(Self::Notify),
            "fs.write" => Some(Self::FsWrite),
            "fs.delete" => Some(Self::FsDelete),
            "fs.stat" => Some(Self::FsStat),
            "fs.list" => Some(Self::FsList),
            "fs.glob" => Some(Self::FsGlob),
            "fs.readRange" => Some(Self::FsReadRange),
            "fs.openDefault" => Some(Self::FsOpenDefault),
            "fs.reveal" => Some(Self::FsReveal),
            "log" => Some(Self::Log),
            // The P1 capability names (`omp.desktop` API 0.2.0). Every one of them is a name a
            // plugin from `host/src/plugin-worker/api.ts` spells, and the comparison is exact for
            // the reason the older ones are: `session.list` is not `session.listS`.
            "session.list" => Some(Self::SessionList),
            "session.get" => Some(Self::SessionGet),
            "session.messages" => Some(Self::SessionMessages),
            "session.rename" => Some(Self::SessionRename),
            "session.delete" => Some(Self::SessionDelete),
            "usage.turns" => Some(Self::UsageTurns),
            "agent.complete" => Some(Self::AgentComplete),
            "bus.publish" => Some(Self::BusPublish),
            "bus.subscribe" => Some(Self::BusSubscribe),
            "net.websocket.connect" => Some(Self::WebSocketConnect),
            "net.websocket.send" => Some(Self::WebSocketSend),
            "net.websocket.close" => Some(Self::WebSocketClose),
            "net.websocket.receive" => Some(Self::WebSocketReceive),
            "shell.openExternal" => Some(Self::ShellOpenExternal),
            "browser.navigate" => Some(Self::BrowserNavigate),
            "browser.reveal" => Some(Self::BrowserReveal),
            "browser.snapshot" => Some(Self::BrowserSnapshot),
            "browser.screenshot" => Some(Self::BrowserScreenshot),
            "browser.evaluate" => Some(Self::BrowserEvaluate),
            "browser.console" => Some(Self::BrowserConsole),
            "browser.action" => Some(Self::BrowserAction),
            "plugin.dataDir" => Some(Self::PluginDataDir),
            _ => None,
        }
    }

    /// Whether this method carries parameters, and therefore arrives as a `POST` body rather than a
    /// query string. A parameter-carrying method asked for through a query is refused, because there
    /// is no shape of query string this build would read as its parameters.
    pub(crate) fn takes_params(self) -> bool {
        matches!(
            self,
            Self::FsRead
                | Self::NetFetch
                | Self::ClipboardWrite
                | Self::Notify
                | Self::FsWrite
                | Self::FsDelete
                | Self::FsStat
                | Self::FsList
                | Self::FsGlob
                | Self::FsReadRange
                | Self::FsOpenDefault
                | Self::FsReveal
                | Self::Log
                // Every P1 method reads its parameters, including the three that only name a
                // socket: a `GET` names none of them, and a call with no parameters is refused
                // there rather than answered with defaults the caller never asked for.
                | Self::SessionList
                | Self::SessionGet
                | Self::SessionMessages
                | Self::SessionRename
                | Self::SessionDelete
                | Self::UsageTurns
                | Self::AgentComplete
                | Self::BusPublish
                | Self::BusSubscribe
                | Self::WebSocketConnect
                | Self::WebSocketSend
                | Self::WebSocketClose
                | Self::WebSocketReceive
                | Self::ShellOpenExternal
                | Self::BrowserNavigate
                | Self::BrowserReveal
                | Self::BrowserSnapshot
                | Self::BrowserScreenshot
                | Self::BrowserEvaluate
                | Self::BrowserConsole
                | Self::BrowserAction
        )
    }
}
