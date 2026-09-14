// Interface language. One dictionary per language keyed on the English text,
// so the English strings in the components are the source and a language only
// has to say what it does differently. A key with no entry falls back to the
// English, so a missing translation is a visible English string rather than a
// blank — and `src/i18n.test.ts` scans the renderer for every key and fails on
// any the Chinese dictionary does not carry.
import { createContext, useContext } from 'react'
import { zh } from './locales/zh'

export type Language = 'en' | 'zh'

export const LANGUAGES: Array<{ id: Language; label: string; native: string }> = [
  { id: 'en', label: 'English', native: 'English' },
  { id: 'zh', label: 'Chinese (Simplified)', native: '简体中文' },
]

export const LANGUAGE_STORAGE_KEY = 'moodprep.language'

const DICTIONARIES: Record<Language, Record<string, string>> = { en: {}, zh }

// A per-machine working preference, like the library sort: never written into
// the folder's project.json.
export function readStoredLanguage(): Language {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY)
    return LANGUAGES.some((language) => language.id === stored) ? stored as Language : 'en'
  } catch {
    return 'en'
  }
}

export function storeLanguage(language: Language) {
  try { window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language) } catch { /* A blocked storage quota must not break the setting. */ }
}

export type Vars = Record<string, string | number>

// `{name}` placeholders are filled from `vars`; the English key keeps them so a
// translation can put them in a different order.
export function translate(language: Language, key: string, vars?: Vars) {
  const text = DICTIONARIES[language][key] ?? key
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) => name in vars ? String(vars[name]) : match)
}

export type Translate = (key: string, vars?: Vars) => string

export const LanguageContext = createContext<{ language: Language; t: Translate }>({ language: 'en', t: (key, vars) => translate('en', key, vars) })

export function useLanguage() {
  return useContext(LanguageContext)
}

// The locale used for dates and other formatted values.
export function localeFor(language: Language) {
  return language === 'zh' ? 'zh-CN' : undefined
}
