import { useId } from 'react';
import type { Language } from '@/lib/i18n/languages';

/** A round national flag for a language, drawn inline since Windows shows no flag emoji. */
export function LanguageFlag({
  language,
  className = '',
}: {
  language: Language;
  className?: string;
}) {
  const id = useId();
  const frame = `block overflow-hidden rounded-full ${className}`;
  if (language === 'th') {
    return (
      <svg viewBox="0 0 6 6" aria-hidden="true" className={frame}>
        <rect width="6" height="6" fill="#A51931" />
        <rect y="1" width="6" height="4" fill="#F4F5F8" />
        <rect y="2" width="6" height="2" fill="#2D2A4A" />
      </svg>
    );
  }
  if (language === 'en') {
    return (
      <svg
        viewBox="0 0 60 30"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
        className={frame}
      >
        <clipPath id={`${id}-cross`}>
          <path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z" />
        </clipPath>
        <rect width="60" height="30" fill="#012169" />
        <path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" strokeWidth="6" />
        <path
          d="M0,0 L60,30 M60,0 L0,30"
          clipPath={`url(#${id}-cross)`}
          stroke="#C8102E"
          strokeWidth="4"
        />
        <path d="M30,0 v30 M0,15 h60" stroke="#fff" strokeWidth="10" />
        <path d="M30,0 v30 M0,15 h60" stroke="#C8102E" strokeWidth="6" />
      </svg>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`${frame} flex items-center justify-center bg-neutral-200 text-[10px] font-medium uppercase text-neutral-700`}
    >
      {language}
    </span>
  );
}
