'use client';

import { useState, type ReactNode } from 'react';
import { ArrowLeft, CalendarDays, UserRound } from 'lucide-react';
import { useTranslations } from 'use-intl';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';

const CARD_STYLE =
  'flex flex-col items-center justify-center gap-1 rounded-[12px] border border-[#F1F1F1] bg-white p-2 text-center text-[10px] leading-4 shadow-[0_2px_4px_rgba(0,0,0,0.18)]';

const SERVICES = ['cutlery', 'condiments', 'drink', 'other'] as const;

function ServiceIllustration({ kind }: { kind: (typeof SERVICES)[number] }) {
  return (
    <svg viewBox="0 0 48 48" className="size-12" aria-hidden="true">
      {kind === 'cutlery' && (
        <>
          <path
            d="M9 5v10q0 6 6 6t6-6V5M15 5v15"
            fill="none"
            stroke="#C5D5E1"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <rect x="12" y="23" width="6" height="21" rx="3" fill="#FF784C" />
          <ellipse cx="33" cy="12" rx="7" ry="10" fill="#C5D5E1" />
          <rect x="30" y="23" width="6" height="21" rx="3" fill="#FF784C" />
        </>
      )}
      {kind === 'condiments' && (
        <>
          <path d="m8 15 3-8h4l3 8v26H8Z" fill="#F34E50" />
          <rect x="10" y="4" width="6" height="5" rx="1" fill="#D52D31" />
          <path d="m21 18 3-12h4l3 12v23H21Z" fill="#FFC332" />
          <rect x="24" y="3" width="4" height="5" fill="#EBA31B" />
          <path d="m33 16 3-11h4l3 11v25H33Z" fill="#F99818" />
          <path d="m36 5 2-5 2 5" fill="#E85618" />
          <path d="M11 24h4M24 27h4M36 24h4M24 31h4" stroke="#A44B26" strokeWidth="2" />
        </>
      )}
      {kind === 'drink' && (
        <>
          <path d="M17 4h20l-3 36H20Z" fill="#E6F9FF" />
          <path d="M36 13h8v13q0 7-9 7" fill="none" stroke="#9BE9FF" strokeWidth="3" />
          <path d="M20 23h14l-1 14H21Z" fill="#64DDF8" />
          <path d="M5 25h14v18H5Z" fill="#71E3FB" />
          <path d="M7 29h10v12H7Z" fill="#2FCBF1" />
        </>
      )}
      {kind === 'other' && (
        <>
          <path d="M7 22V17a17 17 0 0 1 34 0v5" fill="#48556B" />
          <ellipse cx="24" cy="20" rx="14" ry="15" fill="#FFE0D5" />
          <path d="M9 14Q17 3 36 15V8H11Z" fill="#48556B" />
          <path d="M9 46V35q15-9 30 0v11" fill="#DCE4ED" />
          <path d="m20 34 4 3 4-3v9l-4-3-4 3Z" fill="#F06170" />
          <path d="M17 18v3M29 18v3" stroke="#48556B" strokeWidth="2" strokeLinecap="round" />
          <path d="M32 30a7 7 0 0 1 14 0Z" fill="#969FB4" />
          <path d="M31 32h16" stroke="#737F96" strokeWidth="2" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

export function ServiceMenu({
  children,
  onStaffLogin,
}: {
  children: ReactNode;
  onStaffLogin: () => void;
}) {
  const t = useTranslations('serverApp');
  const tCommon = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [other, setOther] = useState(false);
  const labels = {
    cutlery: t('serviceMenuCutlery'),
    condiments: t('serviceMenuCondiments'),
    drink: t('serviceMenuDrink'),
    other: t('serviceMenuOther'),
  };
  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setOther(false);
      }}
    >
      <DrawerTrigger asChild>{children}</DrawerTrigger>
      <DrawerContent
        data-testid="service-menu"
        className="mx-auto h-[85svh] max-h-[85svh] w-full max-w-sm rounded-t-[20px] bg-white font-sans text-[#444444]"
      >
        <DrawerHeader className="shrink-0 items-center gap-1 px-4 pb-5 pt-4 text-center">
          {other && (
            <button
              type="button"
              onClick={() => setOther(false)}
              aria-label={tCommon('back')}
              className="absolute start-4 top-6 rounded-full p-2 text-[#444444] focus-visible:outline-2 focus-visible:outline-brand"
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <DrawerTitle className="text-sm font-semibold leading-5">
            {other ? t('serviceMenuOther') : t('serviceMenuTitle')}
          </DrawerTitle>
          <DrawerDescription className="text-center text-[11px] leading-4 text-[#626B7C]">
            {t('serviceMenuHint')}
          </DrawerDescription>
        </DrawerHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
          <div
            data-testid="service-menu-grid"
            className="grid grid-cols-[repeat(2,116px)] grid-rows-[repeat(8,116px)] justify-center gap-4"
          >
            {other ? (
              <>
                <button
                  type="button"
                  data-testid="service-menu-staff"
                  className={`${CARD_STYLE} focus-visible:outline-2 focus-visible:outline-brand`}
                  onClick={() => {
                    setOpen(false);
                    setOther(false);
                    onStaffLogin();
                  }}
                >
                  <UserRound size={42} className="text-red-600" aria-hidden="true" />
                  <span>{t('staffButton')}</span>
                </button>
                <button
                  type="button"
                  disabled
                  data-testid="service-menu-leave"
                  className={`${CARD_STYLE} cursor-not-allowed`}
                >
                  <CalendarDays size={42} className="text-slate-400" aria-hidden="true" />
                  <span>{t('serviceMenuLeaveRequest')}</span>
                </button>
                <button
                  type="button"
                  data-testid="service-menu-exit"
                  onClick={() => {
                    setOpen(false);
                    setOther(false);
                  }}
                  className="col-span-2 flex h-11 items-center justify-center self-start rounded-[12px] border border-[#F1F1F1] bg-white text-sm font-medium text-red-600 shadow-[0_2px_4px_rgba(0,0,0,0.18)] focus-visible:outline-2 focus-visible:outline-brand"
                >
                  {t('serviceMenuExit')}
                </button>
              </>
            ) : (
              SERVICES.map((kind) => {
                const content = (
                  <>
                    <ServiceIllustration kind={kind} />
                    <span>{labels[kind]}</span>
                  </>
                );
                return kind === 'other' ? (
                  <button
                    key={kind}
                    type="button"
                    data-testid="service-menu-card"
                    onClick={() => setOther(true)}
                    className={`${CARD_STYLE} focus-visible:outline-2 focus-visible:outline-brand`}
                  >
                    {content}
                  </button>
                ) : (
                  <div key={kind} data-testid="service-menu-card" className={CARD_STYLE}>
                    {content}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
