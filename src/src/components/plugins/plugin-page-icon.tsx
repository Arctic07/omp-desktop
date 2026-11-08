import type { LucideIcon } from 'lucide-react'
import {
  Book,
  Bug,
  Calendar,
  ChartColumn,
  ClipboardList,
  Code,
  Database,
  Download,
  File,
  Folder,
  GitBranch,
  Globe,
  Home,
  Image,
  Key,
  List,
  MessageSquare,
  Music,
  Plug,
  Search,
  Settings,
  Shield,
  Sparkles,
  SquareTerminal,
  Star,
  Toolbox,
  Upload,
  Video,
  Wrench,
} from 'lucide-react'

/**
 * The semantic icon tokens a plugin may name, and what each one draws.
 *
 * A token is a word, not an icon name: the manifest says `git`, this table decides that means the
 * branch glyph, and a future redesign changes one row here instead of every plugin in the world.
 * The set is closed by convention, not by validation — an unknown token is not an error (spec §3.2),
 * it falls back to the plugin glyph, because an icon the author meant is not worth refusing a whole
 * page over. New tokens are additive: they may be added to this table, never removed or repointed,
 * so an installed plugin keeps drawing what its author chose.
 */
const TOKEN_ICONS: Readonly<Record<string, LucideIcon>> = {
  browser: Globe,
  globe: Globe,
  folder: Folder,
  file: File,
  terminal: SquareTerminal,
  search: Search,
  settings: Settings,
  plug: Plug,
  git: GitBranch,
  code: Code,
  list: List,
  clipboard: ClipboardList,
  message: MessageSquare,
  book: Book,
  chart: ChartColumn,
  shield: Shield,
  star: Star,
  tool: Wrench,
  toolbox: Toolbox,
  key: Key,
  database: Database,
  calendar: Calendar,
  image: Image,
  music: Music,
  video: Video,
  download: Download,
  upload: Upload,
  home: Home,
  bug: Bug,
  sparkles: Sparkles,
}

/** The glyph one page's manifest token stands for; the plugin glyph when it named none this build knows. */
export function PluginPageIcon({
  token,
  className,
}: {
  token: string | null
  className?: string
}) {
  const Icon = (token === null ? undefined : TOKEN_ICONS[token]) ?? Plug
  return <Icon aria-hidden="true" className={className} />
}
