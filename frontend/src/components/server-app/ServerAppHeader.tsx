'use client';

import type { ReactNode } from 'react';
import { Prompt } from 'next/font/google';
import { ChefHat, LayoutGrid, Moon, Sun } from 'lucide-react';
import { useTranslations } from 'use-intl';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LANGUAGES, type Language } from '@/lib/i18n/languages';
import { LanguageFlag } from './LanguageFlag';

// A soft, rounded Thai and Latin face that keeps the header relaxed and easy to read.
const headerFont = Prompt({ subsets: ['thai', 'latin'], weight: ['400', '500'], display: 'swap' });

const ICON_BUTTON =
  'flex size-11 shrink-0 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15 disabled:opacity-50';

export const HEADER_PILL =
  'flex h-11 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full px-4 text-sm font-medium sm:px-5 sm:text-[15px] shadow-md transition-colors disabled:opacity-50';

export const HEADER_PILL_FILLED = `${HEADER_PILL} border-2 border-white/80 bg-brand text-white hover:brightness-110`;

/**
 * The Server App and table-QR menu header: the table and customer top left, language, tables and
 * theme top right, and the logo with order history, staff and the table QR under the cover.
 */
export function ServerAppHeader({
  logoUrl,
  coverUrl,
  tableText,
  customerName,
  language,
  onLanguage,
  onTables,
  tablesExpanded,
  dark,
  onDark,
  onHistory,
  historyDisabled,
  staffButton,
  onShowQr,
}: {
  logoUrl: string | null;
  coverUrl: string | null;
  tableText: string;
  customerName: ReactNode;
  language: Language;
  onLanguage: (language: Language) => void;
  onTables?: () => void;
  tablesExpanded?: boolean;
  dark?: boolean;
  onDark?: () => void;
  onHistory: () => void;
  historyDisabled: boolean;
  staffButton: ReactNode;
  onShowQr?: () => void;
}) {
  const t = useTranslations('serverApp');
  const tTables = useTranslations('tables');
  const languages = (Object.keys(LANGUAGES) as Language[]).filter(
    (code) => LANGUAGES[code].selectable,
  );
  return (
    <header
      data-testid="server-app-header"
      className={`relative bg-background ${headerFont.className}`}
    >
      <div className="relative flex min-h-48 flex-col overflow-hidden bg-gradient-to-br from-brand to-orange-300 sm:min-h-60">
        {coverUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverUrl}
            alt=""
            data-testid="server-app-header-cover"
            className="absolute inset-0 size-full object-cover"
          />
        )}
        <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/35 to-transparent" />
        <div className="relative mx-auto flex w-full max-w-6xl items-start gap-2 px-3 pt-3">
          <p
            data-testid="server-app-header-table"
            className="flex min-w-0 items-center gap-2.5 rounded-2xl bg-white/95 px-4 py-2 text-[15px] text-neutral-800 shadow-md"
          >
            <span className="truncate">{tableText}</span>
            {customerName && (
              <>
                <span aria-hidden="true" className="h-4 w-px shrink-0 bg-neutral-300" />
                <span data-testid="server-app-header-customer" className="min-w-0 truncate">
                  {customerName}
                </span>
              </>
            )}
          </p>
          <div className="ms-auto flex shrink-0 items-center rounded-full border-2 border-white/80 bg-black/45 px-1 shadow-md">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-testid="server-app-language-button"
                  aria-label={t('changeLanguage')}
                  title={t('changeLanguage')}
                  className={ICON_BUTTON}
                >
                  <LanguageFlag language={language} className="size-8 ring-2 ring-white" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-[60vh] overflow-y-auto">
                {languages.map((code) => (
                  <DropdownMenuItem
                    key={code}
                    onSelect={() => onLanguage(code)}
                    className={`gap-2.5 ${code === language ? 'font-medium text-brand' : ''}`}
                  >
                    <LanguageFlag language={code} className="size-5 ring-1 ring-border" />
                    {LANGUAGES[code].nativeName}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {onTables && (
              <button
                type="button"
                onClick={onTables}
                aria-expanded={tablesExpanded}
                aria-label={t('selectTable')}
                title={t('selectTable')}
                data-testid="server-app-table-button"
                className={ICON_BUTTON}
              >
                <LayoutGrid size={22} />
              </button>
            )}
            {onDark && (
              <button
                type="button"
                onClick={onDark}
                aria-pressed={dark}
                aria-label={t('darkMode')}
                title={t('darkMode')}
                data-testid="server-app-theme-button"
                className={ICON_BUTTON}
              >
                {dark ? <Sun size={22} /> : <Moon size={22} />}
              </button>
            )}
          </div>
        </div>
        <div className="relative mx-auto mt-auto flex w-full max-w-6xl flex-wrap items-end gap-3 px-3 pb-3 pt-3">
          <div className="flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-full border-4 border-white bg-white text-brand shadow-lg sm:size-32">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoUrl}
                alt=""
                data-testid="server-app-header-logo"
                className="size-full object-contain"
              />
            ) : (
              <ChefHat size={44} />
            )}
          </div>
          <div className="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-2 pb-1">
            <button
              type="button"
              data-testid="server-app-history-button"
              onClick={onHistory}
              disabled={historyDisabled}
              aria-label={t('orderHistory')}
              className={HEADER_PILL_FILLED}
            >
              {t('orderHistory')}
            </button>
            {staffButton}
            {onShowQr && (
              <button
                type="button"
                onClick={onShowQr}
                title={tTables('guestQrButton')}
                data-testid="server-app-table-qr-button"
                className={`${HEADER_PILL} border border-white/80 bg-black/45 text-white hover:bg-black/60`}
              >
                {t('showQr')}
              </button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
