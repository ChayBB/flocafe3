'use client';

import { Search, X } from 'lucide-react';
import { useTranslations } from 'use-intl';

export function KdsSearchBox({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations('kds');

  return (
    <div className="shrink-0 mb-4 relative">
      <Search
        size={18}
        aria-hidden="true"
        className="pointer-events-none absolute start-4 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
      <input
        type="search"
        data-testid="kds-search-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        enterKeyHint="search"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onChange('');
          // On a tablet, the keyboard's search key closes the keyboard so the results show at once.
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        placeholder={t('searchPlaceholder')}
        aria-label={t('searchPlaceholder')}
        autoComplete="off"
        className="w-full min-h-11 rounded-full border-2 border-border bg-muted/50 ps-11 pe-11 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          data-testid="kds-search-clear"
          onClick={() => onChange('')}
          title={t('searchClear')}
          aria-label={t('searchClear')}
          className="absolute end-1 top-1/2 -translate-y-1/2 min-w-11 min-h-11 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
        >
          <X size={18} />
        </button>
      )}
    </div>
  );
}
