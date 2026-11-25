'use client';

import { useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  BadgePercent,
  ChevronRight,
  Coins,
  Crown,
  Ticket,
  UserPlus,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'use-intl';
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
  'flex min-h-28 flex-col items-center justify-center gap-1.5 rounded-2xl border border-[#F1F1F1] bg-white p-3 text-center text-[15px] leading-snug text-[#222222] shadow-[0_2px_4px_rgba(0,0,0,0.12)]';

const PRIVILEGES: {
  key:
    | 'serviceMenuMemberSignup'
    | 'serviceMenuPoints'
    | 'serviceMenuPromotions'
    | 'serviceMenuCoupons'
    | 'serviceMenuVip';
  icon: LucideIcon;
  color: string;
}[] = [
  { key: 'serviceMenuMemberSignup', icon: UserPlus, color: 'text-[#2F80ED]' },
  { key: 'serviceMenuPoints', icon: Coins, color: 'text-[#F2A007]' },
  { key: 'serviceMenuPromotions', icon: BadgePercent, color: 'text-[#EB5757]' },
  { key: 'serviceMenuCoupons', icon: Ticket, color: 'text-[#27AE60]' },
  { key: 'serviceMenuVip', icon: Crown, color: 'text-[#9B51E0]' },
];

const SERVICES = ['cutlery', 'condiments', 'drink', 'other'] as const;

// White cards with the same type as the menu's dish names.
const SERVICE_CARD =
  'flex min-h-36 flex-col items-center justify-end gap-1 rounded-2xl border border-[#F1F1F1] bg-white px-2 pt-4 pb-3 text-center shadow-[0_2px_4px_rgba(0,0,0,0.12)]';

// The bilingual subtitle is part of the card design, so it stays English under the Thai title.
const SERVICE_SUBTITLE = {
  cutlery: 'Request Cutlery',
  condiments: 'Request Condiments',
  drink: 'Refill Drinks',
  other: 'Services & Privileges',
} as const;

function ServiceIllustration({ kind }: { kind: (typeof SERVICES)[number] }) {
  return (
    <svg viewBox="0 0 48 48" className="size-14" aria-hidden="true">
      {kind === 'cutlery' && (
        <>
          <path
            d="M18 9q-2-2 0-4t0-4M24 9q-2-2 0-4t0-4M30 9q-2-2 0-4t0-4"
            fill="none"
            stroke="#F08A24"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <circle cx="24" cy="15" r="2.5" fill="#F5A524" />
          <path d="M6 34a18 18 0 0 1 36 0Z" fill="#F7B733" />
          <path
            d="M11 27a14 14 0 0 1 8-8"
            fill="none"
            stroke="#FFE08A"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <rect x="3" y="34" width="42" height="5" rx="2.5" fill="#F08A24" />
        </>
      )}
      {kind === 'condiments' && (
        <>
          <rect x="11" y="3" width="6" height="5" rx="1" fill="#C62828" />
          <path d="M10 8h8l3 7v27a3 3 0 0 1-3 3h-8a3 3 0 0 1-3-3V15Z" fill="#F4511E" />
          <rect x="31" y="3" width="6" height="5" rx="1" fill="#E69500" />
          <path d="M30 8h8l3 7v27a3 3 0 0 1-3 3h-8a3 3 0 0 1-3-3V15Z" fill="#FFC107" />
          <path d="M10 20h8M30 20h8" stroke="#FFFFFF" strokeOpacity="0.5" strokeWidth="2" />
        </>
      )}
      {kind === 'drink' && (
        <>
          <path d="M21 6h17l-2 6v28a4 4 0 0 1-4 4H23a4 4 0 0 1-4-4V12Z" fill="#7FD3F7" />
          <path
            d="M36 15h4a5 5 0 0 1 5 5v6a5 5 0 0 1-5 5h-4"
            fill="none"
            stroke="#4FB8E8"
            strokeWidth="3"
          />
          <path d="M20 22h16v18a3 3 0 0 1-3 3H23a3 3 0 0 1-3-3Z" fill="#3DA9DF" />
          <path d="M3 25h14l-1.5 18a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2Z" fill="#B9E6FA" />
          <path d="M4 31h12l-1 12H5Z" fill="#4FB8E8" />
        </>
      )}
      {kind === 'other' && (
        <>
          <path
            d="M24 14q-4-9-10-7t2 7ZM24 14q4-9 10-7t-2 7Z"
            fill="none"
            stroke="#E5484D"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
          <rect x="7" y="14" width="34" height="9" rx="2" fill="#F0645A" />
          <rect x="9" y="23" width="30" height="20" rx="2" fill="#FF8A80" />
          <rect x="21" y="14" width="6" height="29" fill="#FFC542" />
          <path
            d="m35 27 1.2 2.4 2.6.4-1.9 1.8.5 2.6-2.4-1.2-2.4 1.2.5-2.6-1.9-1.8 2.6-.4Z"
            fill="#FFF6D6"
          />
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
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [other, setOther] = useState(false);
  const [staffUnlocked, setStaffUnlocked] = useState(false);
  const close = () => {
    setOpen(false);
    setOther(false);
    setStaffUnlocked(false);
  };
  const enterStaff = () => {
    close();
    onStaffLogin();
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
            staffUnlocked ? 'border-brand' : 'border-transparent'
          }`}
        >
          <span
            aria-hidden="true"
            className={`pointer-events-none h-1.5 w-[100px] rounded-full transition-colors ${staffUnlocked ? 'bg-brand' : 'bg-[#B5B5B5]'}`}
          />
        </button>
        {/* The bar stays plain grey until the staff gesture completes, so guests see no hint of it. */}
        <div
          data-testid="service-menu-staff-taps"
          aria-hidden="true"
          className="mt-2 flex shrink-0 justify-center gap-2"
        >
          {Array.from({ length: STAFF_ENTRY_TAPS }, (_, i) => (
            <span
              key={i}
              data-active={staffUnlocked || i < staffGesture.tapCount ? 'true' : undefined}
              className={`flex size-7 items-center justify-center rounded-full bg-brand text-xs font-semibold text-white ${staffUnlocked ? '' : 'invisible'}`}
            >
              {i + 1}
            </span>
          ))}
        </div>
        <DrawerHeader className="shrink-0 items-center gap-1 px-4 pb-5 pt-2 text-center">
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
          <div data-testid="service-menu-grid" className="grid grid-cols-2 content-start gap-4">
            {other ? (
              <>
                {PRIVILEGES.map(({ key, icon: Icon, color }, index) => (
                  <button
                    key={key}
                    type="button"
                    disabled
                    data-testid="service-menu-privilege"
                    className={`${CARD_STYLE} cursor-not-allowed ${index === PRIVILEGES.length - 1 ? 'col-span-2' : ''}`}
                  >
                    <Icon size={34} strokeWidth={1.8} className={color} aria-hidden="true" />
                    <span>{t(key)}</span>
                    <span className="text-[11px] leading-4 text-[#9CA3AF]">
                      {t('serviceMenuComingSoon')}
                    </span>
                  </button>
                ))}
              </>
            ) : (
              SERVICES.map((kind) => {
                const content = (
                  <>
                    <ServiceIllustration kind={kind} />
                    <span className="text-[15px] leading-snug font-normal text-[#222222]">
                      {labels[kind]}
                    </span>
                    {locale !== 'en' && (
                      <span lang="en" className="max-w-full truncate text-[13px] text-[#6B7280]">
                        {SERVICE_SUBTITLE[kind]}
                      </span>
                    )}
                  </>
                );
                const cardClass = SERVICE_CARD;
                return kind === 'other' ? (
                  <button
                    key={kind}
                    type="button"
                    data-testid="service-menu-card"
                    onClick={() => setOther(true)}
                    className={`${cardClass} focus-visible:outline-2 focus-visible:outline-brand`}
                  >
                    {content}
                  </button>
                ) : (
                  <div key={kind} data-testid="service-menu-card" className={cardClass}>
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
