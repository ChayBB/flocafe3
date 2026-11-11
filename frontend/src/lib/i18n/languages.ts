export type LanguageDirection = 'ltr' | 'rtl';

export interface LanguageConfig {
  readonly locale: string;
  readonly nativeName: string;
  readonly direction: LanguageDirection;
  readonly selectable: boolean;
  /** Dynamic chunk loader for this language's message bundle (#375). */
  readonly load: () => Promise<{ default: Record<string, unknown> }>;
}

/** Single source of truth for supported UI languages, BCP-47 locale tags,
 * display names, directions, and dynamic chunk loaders. */
export const LANGUAGES = {
  en: {
    locale: 'en',
    nativeName: 'English',
    direction: 'ltr',
    selectable: true,
    load: () => import('./messages/en.json'),
  },
  th: {
    locale: 'th-TH',
    nativeName: 'ไทย',
    direction: 'ltr',
    selectable: true,
    load: () => import('./messages/th.json'),
  },
} as const satisfies Record<string, LanguageConfig>;

export type Language = keyof typeof LANGUAGES;
export type Locale = (typeof LANGUAGES)[Language]['locale'];

/** Returns whether an unknown value is a registered language key. */
export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LANGUAGES, value);
}

/** Reverse map: BCP-47 locale tag to registered language key. */
const LOCALE_TO_LANGUAGE: Record<string, Language> = Object.fromEntries(
  (Object.keys(LANGUAGES) as Language[]).map((lang) => [LANGUAGES[lang].locale, lang]),
);

/** Returns the registered language for a BCP-47 locale tag (undefined when unknown). */
export function getLanguageFromLocale(locale: string): Language | undefined {
  return LOCALE_TO_LANGUAGE[locale];
}

/** Returns the text direction of a UI language (defaults to `ltr`). */
export function getLanguageDirection(lang: Language): LanguageDirection {
  return LANGUAGES[lang]?.direction ?? 'ltr';
}

/** Returns the BCP-47 locale tag of a UI language (defaults to `en`). */
export function getLanguageLocale(lang: Language): string {
  return LANGUAGES[lang]?.locale ?? 'en';
}
