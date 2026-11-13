'use client';

import { useEffect, useState } from 'react';
import {
  Maximize2,
  Minimize2,
  ChefHat,
  LogOut,
  Moon,
  Settings,
  Sun,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useTranslations } from 'use-intl';
import type { ConnectionMode, KdsStation } from '@/hooks/useKdsConnection';
import type { KdsScreenMode } from '@/lib/kds-screen-mode';

export interface KdsHeaderProps {
  userName: string;
  userRole: string;
  connected: boolean;
  connectionMode: ConnectionMode;
  stations: KdsStation[];
  stationId: string;
  onChangeStation: (stationId: string) => void;
  screenMode: KdsScreenMode;
  onScreenMode: (mode: KdsScreenMode) => void;
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
  screenMode,
  onScreenMode,
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

          <button
            type="button"
            data-testid="kds-screen-mode-toggle"
            onClick={() => onScreenMode(screenMode === 'night' ? 'day' : 'night')}
            className="min-w-11 min-h-11 p-2 hover:bg-muted rounded-lg text-muted-foreground ms-2"
            title={screenMode === 'night' ? t('screenModeToDay') : t('screenModeToNight')}
            aria-label={screenMode === 'night' ? t('screenModeToDay') : t('screenModeToNight')}
          >
            {screenMode === 'night' ? <Sun size={20} /> : <Moon size={20} />}
          </button>

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
