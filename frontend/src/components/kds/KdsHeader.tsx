'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Maximize2,
  Minimize2,
  ChefHat,
  LogOut,
  Minus,
  Plus,
  Settings,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useTranslations } from 'use-intl';
import type { ConnectionMode, KdsStation } from '@/hooks/useKdsConnection';
import { KDS_FONT_SCALE_MAX, KDS_FONT_SCALE_MIN, KDS_FONT_SCALE_STEP } from '@/lib/kds-screen-mode';

export interface KdsHeaderProps {
  userName: string;
  userRole: string;
  connected: boolean;
  connectionMode: ConnectionMode;
  stations: KdsStation[];
  stationId: string;
  onChangeStation: (stationId: string) => void;
  fontScale: number;
  onFontScale: (scale: number) => void;
  onOpenSettings: () => void;
  onLogout: () => void;
}

export function KdsHeader({
  userName,
  userRole,
  connected,
  connectionMode,
  stations,
  stationId,
  onChangeStation,
  fontScale,
  onFontScale,
  onOpenSettings,
  onLogout,
}: KdsHeaderProps) {
  const t = useTranslations('kds');
  const tNav = useTranslations('nav');
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const sync = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  return (
    <div className="shrink-0 mb-4">
      <div className="flex items-center gap-3 mb-3">
        <ChefHat size={24} className="text-muted-foreground" />
        <div>
          <h1 className="text-xl font-bold text-foreground">{t('title')}</h1>
          <p className="text-xs text-muted-foreground">
            {userName} ({userRole})
          </p>
        </div>
        <div className="ms-auto flex items-center gap-2">
          {connectionMode === 'websocket' ? (
            <span title={t('wsConnected')}>
              <Wifi size={16} className="text-green-500" />
            </span>
          ) : connectionMode === 'rest' ? (
            <span title={t('restPolling')}>
              <WifiOff size={16} className="text-amber-500" />
            </span>
          ) : null}
          <span
            className={`w-2.5 h-2.5 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`}
          />
          <span className="text-xs text-gray-400">
            {connected
              ? connectionMode === 'websocket'
                ? t('connectionLive')
                : null
              : t('connectionConnecting')}
          </span>

          <select
            data-testid="kds-station-select"
            aria-label={t('stationFilter')}
            title={t('stationFilter')}
            value={stationId}
            disabled={stations.length === 0}
            onChange={(e) => onChangeStation(e.target.value)}
            className="min-h-11 ms-2 px-2.5 text-xs font-medium rounded-lg border border-border bg-card text-foreground disabled:opacity-60"
          >
            <option value="">{stations.length === 0 ? t('noStations') : t('allStations')}</option>
            {stations.map((station) => (
              <option key={station.id} value={station.id}>
                {station.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            data-testid="kds-fullscreen"
            onClick={() => {
              if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
              else {
                const target = document.documentElement;
                void target.requestFullscreen?.().catch(() => {});
              }
            }}
            aria-label={fullscreen ? t('exitFullscreen') : t('enterFullscreen')}
            title={fullscreen ? t('exitFullscreen') : t('enterFullscreen')}
            className="flex min-h-12 min-w-12 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:bg-muted"
          >
            {fullscreen ? <Minimize2 size={22} /> : <Maximize2 size={22} />}
          </button>

          <KdsFontSizeButton fontScale={fontScale} onFontScale={onFontScale} />

          <button
            type="button"
            data-testid="kds-settings-button"
            onClick={onOpenSettings}
            className="min-w-11 min-h-11 p-2 hover:bg-muted rounded-lg text-muted-foreground ms-2"
            title={t('settingsTitle')}
            aria-label={t('settingsTitle')}
          >
            <Settings size={20} />
          </button>

          <button
            onClick={onLogout}
            className="min-w-11 min-h-11 p-2 hover:bg-muted rounded-lg text-muted-foreground ms-2"
            title={tNav('logout')}
          >
            <LogOut size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}

const FONT_STEP_BUTTON =
  'flex size-11 items-center justify-center rounded-full border border-border bg-card text-foreground hover:bg-muted disabled:opacity-40';

/** The header's AA shortcut: a small panel to shrink or grow the board's text without opening settings. */
function KdsFontSizeButton({
  fontScale,
  onFontScale,
}: {
  fontScale: number;
  onFontScale: (scale: number) => void;
}) {
  const t = useTranslations('kds');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === 'Escape'
          : !wrapRef.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative ms-2">
      <button
        type="button"
        data-testid="kds-font-size-button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={t('fontSizeLabel')}
        title={t('fontSizeLabel')}
        className="flex min-h-11 min-w-11 items-end justify-center gap-px rounded-lg px-2 pb-2.5 font-bold leading-none text-muted-foreground hover:bg-muted aria-expanded:bg-muted aria-expanded:text-foreground"
      >
        <span aria-hidden="true" className="text-[11px]">
          A
        </span>
        <span aria-hidden="true" className="text-xl leading-[0.8]">
          A
        </span>
      </button>
      {open && (
        <div
          role="group"
          aria-label={t('fontSizeLabel')}
          data-testid="kds-font-size-panel"
          className="absolute end-0 top-full z-[60] mt-2 flex items-center gap-2 rounded-xl border border-border bg-card p-2 shadow-lg"
        >
          <button
            type="button"
            data-testid="kds-header-font-smaller"
            aria-label={t('fontSizeSmaller')}
            disabled={fontScale <= KDS_FONT_SCALE_MIN}
            onClick={() => onFontScale(fontScale - KDS_FONT_SCALE_STEP)}
            className={FONT_STEP_BUTTON}
          >
            <Minus size={18} aria-hidden="true" />
          </button>
          <span
            data-testid="kds-header-font-scale-value"
            aria-live="polite"
            className="w-12 text-center text-sm tabular-nums text-muted-foreground"
          >
            {fontScale}%
          </span>
          <button
            type="button"
            data-testid="kds-header-font-larger"
            aria-label={t('fontSizeLarger')}
            disabled={fontScale >= KDS_FONT_SCALE_MAX}
            onClick={() => onFontScale(fontScale + KDS_FONT_SCALE_STEP)}
            className={FONT_STEP_BUTTON}
          >
            <Plus size={18} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
