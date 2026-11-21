'use client';

import type { ReactNode } from 'react';
import { Prompt } from 'next/font/google';
import { ChefHat, History, Moon, Sun, UtensilsCrossed } from 'lucide-react';
import { useTranslations } from 'use-intl';
import type { Language } from '@/lib/i18n/languages';
import { LanguageFlag } from './LanguageFlag';
import { ServiceMenu } from './ServiceMenu';
import { TableUserSelector } from './TableUserSelector';

// A soft, rounded Thai and Latin face that keeps the header relaxed and easy to read.
const headerFont = Prompt({ subsets: ['thai', 'latin'], weight: ['400', '500'], display: 'swap' });

const ICON_BUTTON =
  'flex size-[38px] shrink-0 items-center justify-center rounded-full bg-white/85 p-[7px] transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2';

export const HEADER_PILL =
  'flex h-11 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full px-4 text-sm font-medium sm:px-5 sm:text-[15px] shadow-md transition-colors disabled:opacity-50';

export const HEADER_PILL_FILLED = `${HEADER_PILL} border-2 border-white/80 bg-brand text-white hover:brightness-110`;

export const HEADER_WHITE_ACTION =
  'flex h-9 shrink-0 items-center justify-center gap-1 rounded-full bg-white/85 px-2.5 font-sans text-[13px] font-medium leading-5 tracking-normal text-[#111111] shadow-md focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50 sm:gap-2 sm:px-5 sm:text-sm';

/** Shared branding and controls for the Server App and table-QR menu. */
export function ServerAppHeader({
  logoUrl,
  coverUrl,
  tableText,
  selectedTableName,
  customerName,
  language,
  onLanguage,
  onStaffLogin,
  staffLoginLabel,
  staffName,
  tablesExpanded,
  onShowTables,
  tableSelectionDisabled,
  dark,
  onDark,
  onHistory,
  historyDisabled,
  staffButton,
}: {
  logoUrl: string | null;
  coverUrl: string | null;
  tableText: string;
  /** The picked table, shown in bold after Select Table. */
  selectedTableName?: string;
  customerName: ReactNode;
  language: Language;
  onLanguage: (language: Language) => void;
  onStaffLogin: () => void;
  staffLoginLabel: string;
  staffName?: string;
  tablesExpanded?: boolean;
  onShowTables?: () => void;
  tableSelectionDisabled?: boolean;
  dark?: boolean;
  onDark?: () => void;
  onHistory: () => void;
  historyDisabled: boolean;
  staffButton: ReactNode;
}) {
  const t = useTranslations('serverApp');
  return (
    <header
      data-testid="server-app-header"
      className={`relative bg-background ${headerFont.className}`}
    >
      <div className="relative flex min-h-[205px] flex-col overflow-hidden bg-[#F3D4A8] sm:min-h-60">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={coverUrl || '/images/server-app-cover-1920x1080.jpg'}
          alt=""
          data-testid={coverUrl ? 'server-app-header-cover' : 'server-app-header-default-cover'}
          className="absolute inset-0 size-full object-cover"
        />
        <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-[#FFF4DD]/35 to-transparent" />
        <div className="relative flex w-full items-start gap-3 px-3 pt-[7px]">
          <TableUserSelector
            tableName={tableText}
            userName={customerName}
            label={t('selectTable')}
          />
          <div className="ms-auto flex shrink-0 items-center gap-3">
            {staffName && (
              <button
                type="button"
                onClick={onStaffLogin}
                disabled={tableSelectionDisabled}
                aria-label={staffLoginLabel}
                data-testid="server-app-staff-name"
                title={staffName}
                className="max-w-12 truncate font-sans text-sm font-medium leading-5 text-white drop-shadow-sm sm:max-w-32"
              >
                {staffName}
              </button>
            )}
            <div data-testid="server-app-header-circles" className="flex items-center gap-2">
              <button
                type="button"
                data-testid="server-app-language-button"
                aria-label={t('changeLanguage')}
                title={t('changeLanguage')}
                onClick={() => onLanguage(language === 'th' ? 'en' : 'th')}
                className={ICON_BUTTON}
              >
                <LanguageFlag language={language} className="size-[21.6px]" />
              </button>
              {onDark ? (
                <button
                  type="button"
                  onClick={onDark}
                  aria-pressed={dark}
                  aria-label={t('darkMode')}
                  title={t('darkMode')}
                  data-testid="server-app-theme-button"
                  className={`${ICON_BUTTON} text-[#111111]`}
                >
                  {dark ? <Sun size={19.8} /> : <Moon size={19.8} />}
                </button>
              ) : (
                <span
                  data-testid="server-app-header-empty-circle"
                  aria-hidden="true"
                  className="size-[38px] shrink-0 rounded-full bg-white/85"
                />
              )}
              <ServiceMenu onStaffLogin={onStaffLogin}>
                <button
                  data-testid="server-app-header-grid-circle"
                  type="button"
                  aria-label={t('serviceMenuTitle')}
                  className={`${ICON_BUTTON} text-[#111111]`}
                >
                  <svg
                    aria-hidden="true"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M4 7h16 M4 17h10" />
                  </svg>
                </button>
              </ServiceMenu>
            </div>
          </div>
        </div>
        {/* The logo sits 14px below the table name; the cover is tall enough to keep it clear of the bottom row. */}
        <div className="pointer-events-none absolute inset-x-0 top-[59px] mx-auto w-full max-w-6xl px-3">
          <div
            data-testid="server-app-header-logo-frame"
            className="flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-full border-4 border-white bg-white text-brand shadow-lg sm:size-32"
          >
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
        </div>
        <div className="relative mx-auto mt-auto flex w-full max-w-6xl items-end px-3 pb-3 pt-3">
          {/* Sits as far from the bottom edge as the round buttons sit from the top. */}
          <div className="flex w-full min-w-0 translate-y-[9px] items-center gap-1.5 pb-1 sm:gap-2">
            {onShowTables && (
              <button
                type="button"
                onClick={onShowTables}
                disabled={tableSelectionDisabled}
                aria-label={t('selectTable')}
                title={t('selectTable')}
                aria-expanded={tablesExpanded}
                aria-controls="server-app-table-picker"
                data-testid="server-app-table-button"
                className={`${HEADER_WHITE_ACTION} min-w-0 max-w-[11rem]`}
              >
                <UtensilsCrossed size={17} aria-hidden="true" className="shrink-0 text-brand" />
                <span className="truncate">
                  {t('tablesButton')}
                  {selectedTableName && (
                    <b data-testid="server-app-table-button-name" className="ms-1 font-bold">
                      {selectedTableName}
                    </b>
                  )}
                </span>
              </button>
            )}
            <div className="ms-auto flex min-w-0 items-center justify-end gap-1.5 sm:gap-2">
              <button
                type="button"
                data-testid="server-app-history-button"
                onClick={onHistory}
                disabled={historyDisabled}
                aria-label={t('orderHistory')}
                className={HEADER_WHITE_ACTION}
              >
                <History size={17} aria-hidden="true" className="shrink-0 text-brand" />
                {t('orderHistory')}
              </button>
              {staffButton}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
