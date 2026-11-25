'use client';

import { useState, type ReactNode } from 'react';
import { ArrowLeft, CalendarDays, ChevronRight, UserRound } from 'lucide-react';
import { useTranslations } from 'use-intl';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';
import { useStaffEntryGesture } from '@/hooks/useStaffEntryGesture';
import { STAFF_ENTRY_TAPS } from '@/lib/staff-entry-gesture';

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
  onStaffProfile,
  staffMenuOpen = false,
  onStaffMenuClose,
}: {
  children: ReactNode;
  onStaffLogin: () => void;
  /** Signed-in staff open their profile from the Staff card instead of signing in again. */
  onStaffProfile?: () => void;
  /** Opens straight on the Other page, as staff land on it after signing in. */
  staffMenuOpen?: boolean;
  onStaffMenuClose?: () => void;
}) {
  const t = useTranslations('serverApp');
  const tCommon = useTranslations('common');
  const [openState, setOpen] = useState(false);
  const [otherState, setOther] = useState(false);
  const open = openState || staffMenuOpen;
  const other = otherState || staffMenuOpen;
  const [staffUnlocked, setStaffUnlocked] = useState(false);
  const close = () => {
    setOpen(false);
    setOther(false);
    setStaffUnlocked(false);
    onStaffMenuClose?.();
  };
  const enterStaff = () => {
    close();
    (onStaffProfile ?? onStaffLogin)();
  };
  const staffGesture = useStaffEntryGesture(() => setStaffUnlocked(true));
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
        if (next) setOpen(true);
        else close();
      }}
    >
      <DrawerTrigger asChild>{children}</DrawerTrigger>
      <DrawerContent
        data-testid="service-menu"
        showHandle={false}
        className="mx-auto h-[85svh] max-h-[85svh] w-full max-w-sm rounded-t-[20px] bg-white font-sans text-[#444444]"
      >
        <button
          type="button"
          data-vaul-no-drag=""
          data-testid="service-menu-staff-handle"
          aria-label={t('serviceMenuStaffHandle')}
          aria-pressed={staffUnlocked}
          {...staffGesture.handlers}
          className={`mx-auto mt-3 flex h-8 w-40 shrink-0 touch-none select-none items-center justify-center rounded-[12px] border-2 transition-colors focus-visible:outline-2 focus-visible:outline-brand ${
            staffUnlocked || staffGesture.holding || staffGesture.tapCount > 0
              ? 'border-brand'
              : 'border-transparent'
          }`}
        >
          <span
            aria-hidden="true"
            className={`pointer-events-none h-1.5 w-[100px] rounded-full transition-colors ${staffUnlocked ? 'bg-brand' : 'bg-[#B5B5B5]'}`}
          />
        </button>
        <div
          data-testid="service-menu-staff-taps"
          aria-hidden="true"
          className="mt-2 flex shrink-0 justify-center gap-2"
        >
          {Array.from({ length: STAFF_ENTRY_TAPS }, (_, i) => (
            <span
              key={i}
              data-active={staffUnlocked || i < staffGesture.tapCount ? 'true' : undefined}
              className="flex size-7 items-center justify-center rounded-full bg-[#FFF1E8] text-xs font-semibold text-brand data-[active=true]:bg-brand data-[active=true]:text-white"
            >
              {i + 1}
            </span>
          ))}
        </div>
        <p className="mt-1.5 shrink-0 px-4 text-center text-[11px] leading-4 text-[#626B7C]">
          {t('serviceMenuStaffGestureHint')}
        </p>
        <DrawerHeader className="shrink-0 items-center gap-1 px-4 pb-5 pt-2 text-center">
          {other && (
            <button
              type="button"
              onClick={() => {
                setOther(false);
                if (staffMenuOpen) {
                  setOpen(true);
                  onStaffMenuClose?.();
                }
              }}
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
                  onClick={enterStaff}
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
                  onClick={close}
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
            {!other && staffUnlocked && (
              <button
                type="button"
                data-testid="service-menu-staff-area"
                onClick={enterStaff}
                className="col-span-2 flex items-center gap-3 self-start rounded-[12px] border border-brand/40 bg-[#FFF4EE] px-4 py-3 text-start focus-visible:outline-2 focus-visible:outline-brand"
              >
                <UserRound size={22} className="shrink-0 text-brand" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold leading-5 text-[#222222]">
                    {t('serviceMenuStaffArea')}
                  </span>
                  <span className="block text-[13px] leading-5 text-green-700">
                    {t('serviceMenuStaffAreaHint')}
                  </span>
                </span>
                <ChevronRight size={18} className="shrink-0 text-[#444444]" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
