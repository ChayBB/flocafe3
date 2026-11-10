import { UserRound } from 'lucide-react';
import { useTranslations } from 'use-intl';

type StaffSignInProps = { onClick: () => void } | { href: string; label: string };

export function StaffSignIn(props: StaffSignInProps) {
  const t = useTranslations('auth');
  const className =
    'flex h-12 shrink-0 items-center justify-center gap-2 rounded-full bg-orange-500 text-white shadow-md hover:bg-orange-600';
  const icon = <UserRound size={17} aria-hidden="true" />;
  return 'href' in props ? (
    <a
      href={props.href}
      referrerPolicy="no-referrer"
      title={t('signIn')}
      className={`${className} px-4 text-sm font-semibold`}
      data-testid="server-app-login-button"
    >
      {icon}
      {props.label}
    </a>
  ) : (
    <button
      type="button"
      onClick={props.onClick}
      aria-label={t('signIn')}
      title={t('signIn')}
      className={`${className} w-12`}
      data-testid="server-app-login-button"
    >
      {icon}
    </button>
  );
}
