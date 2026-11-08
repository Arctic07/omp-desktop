import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

/**
 * The app's two languages, and the one place the chosen one lives.
 *
 * A surface keeps its own wording as a `Localized<T>` record beside it (`COPY` in each settings
 * section), and reads the record for the current language with `useCopy`. Nothing else in the app
 * branches on the language.
 *
 * The words themselves are the desktop app's own (`src/i18nCopyZh.ts` and the per-surface
 * `*Copy.ts` files in the Vue frontend), so the two frontends read the same in Chinese.
 */
export type Language = 'en' | 'zh'

/** One value per language: the shape a surface's copy is written in. */
export type Localized<T> = Readonly<Record<Language, T>>

const STORAGE_KEY = 'omp-desktop.language'

interface LanguageContextValue {
  language: Language
  setLanguage: (language: Language) => void
}

const LanguageContext = createContext<LanguageContextValue | null>(null)

function isLanguage(value: string | null): value is Language {
  return value === 'en' || value === 'zh'
}

/**
 * The stored choice, or the system's own language — the app writes in `en` and `zh` only, and any
 * Chinese tag resolves to `zh`. Storage may be unavailable (private mode), which is not an error:
 * the system's answer is the default either way.
 */
function readStoredLanguage(): Language {
  const system: Language =
    typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return isLanguage(stored) ? stored : system
  } catch {
    return system
  }
}

function storeLanguage(language: Language): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, language)
  } catch {
    // A choice that cannot be stored still applies to this session.
  }
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(readStoredLanguage)

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next)
    storeLanguage(next)
  }, [])

  // The document's own language, so the browser's spell check, hyphenation and screen readers
  // follow the interface rather than the markup's `lang="en"`.
  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
  }, [language])

  const value = useMemo<LanguageContextValue>(
    () => ({ language, setLanguage }),
    [language, setLanguage],
  )

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export function useLanguage(): LanguageContextValue {
  const value = useContext(LanguageContext)
  if (value === null) {
    throw new Error('useLanguage must be used inside <LanguageProvider>')
  }
  return value
}

/** The copy of the current language, out of a surface's own `Localized` record. */
export function useCopy<T>(copy: Localized<T>): T {
  return copy[useLanguage().language]
}
