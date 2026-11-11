'use client';

import { useEffect, useState } from 'react';
import { MessageSquare, Sun } from 'lucide-react';
import { useTranslations } from 'use-intl';
import {
  clampKdsReadyDelay,
  KDS_READY_BELLS,
  KDS_READY_DELAY_MAX,
  playKdsReadyBell,
  readKdsReadyBell,
  readKdsReadyDelay,
  writeKdsReadyBell,
  writeKdsReadyDelay,
  type KdsReadyBell,
  type KdsReadyDelay,
} from '@/lib/kds-alert-sound';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { STATUS_CONFIG, STATUS_ORDER, type KitchenStatus } from '@/hooks/useKdsConnection';
import { activeStages } from '@/lib/kds-stages';
import {
  KDS_BRIGHTNESS_MAX,
  KDS_BRIGHTNESS_MIN,
  KDS_SCREEN_MODES,
  type KdsScreenMode,
} from '@/lib/kds-screen-mode';
import {
  isNaturalVoice,
  kdsSpeechLang,
  kdsServerVoices,
  kdsVoicesFor,
  KDS_SERVER_VOICE_PREFIX,
  type KdsServerVoice,
  readKdsVoiceName,
  speakKds,
  writeKdsVoiceName,
  type KdsSoundSetting,
  type KdsSoundSettings,
} from '@/lib/kds-sound-settings';

const SCREEN_MODE_LABELS = {
  day: 'screenModeDay',
  night: 'screenModeNight',
} as const satisfies Record<KdsScreenMode, string>;

const READY_BELL_LABELS = {
  hotel: 'readyBellHotel',
  ding: 'readyBellDing',
  none: 'readyBellNone',
} as const satisfies Record<KdsReadyBell, string>;

const SOUND_ROWS = [
  { setting: 'newOrderAlert' as KdsSoundSetting, labelKey: 'soundNewOrderAlert' as const },
  { setting: 'readAloud' as KdsSoundSetting, labelKey: 'soundReadAloud' as const },
  { setting: 'orderReady' as KdsSoundSetting, labelKey: 'soundOrderReady' as const },
  { setting: 'showBell' as KdsSoundSetting, labelKey: 'soundShowBell' as const },
];

function Switch({
  checked,
  label,
  testId,
  disabled,
  onToggle,
}: {
  checked: boolean;
  label: string;
  testId: string;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={onToggle}
      className="min-w-11 min-h-11 flex items-center justify-center disabled:opacity-40"
    >
      <span
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
          checked ? 'bg-brand' : 'bg-gray-300'
        }`}
      >
        <span
          className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-5 rtl:-translate-x-5' : 'translate-x-0.5 rtl:-translate-x-0.5'
          }`}
        />
      </span>
    </button>
  );
}

/** A seconds box for one ready bell delay, saved when it loses focus or Enter is pressed. */
function ReadyDelayField({
  delay,
  label,
  hint,
  unit,
  disabled,
}: {
  delay: KdsReadyDelay;
  label: string;
  hint: string;
  unit: string;
  disabled: boolean;
}) {
  const [value, setValue] = useState(() => String(readKdsReadyDelay(delay)));
  const id = `kds-ready-${delay}`;
  const commit = () => {
    const seconds =
      value.trim() === '' ? readKdsReadyDelay(delay) : clampKdsReadyDelay(delay, Number(value));
    writeKdsReadyDelay(delay, seconds);
    setValue(String(seconds));
  };
  const tone = disabled ? 'text-muted-foreground' : 'text-foreground';
  return (
    <div className="space-y-1.5 pt-1">
      <label htmlFor={id} className={`block text-sm font-medium ${tone}`}>
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          data-testid={id}
          type="number"
          inputMode="numeric"
          min={0}
          max={KDS_READY_DELAY_MAX}
          step={1}
          disabled={disabled}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => event.key === 'Enter' && commit()}
          aria-describedby={`${id}-hint`}
          className="h-11 w-24 rounded-lg border border-border bg-background px-3 text-sm tabular-nums disabled:opacity-50"
        />
        <span className={`text-sm ${tone}`}>{unit}</span>
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}

/** Display settings in two tabs: the screen (columns, day/night, brightness) and the sounds this display plays. */
export function KdsSettingsDialog({
  open,
  stationName,
  inactiveStatuses,
  onToggleStatus,
  soundSettings,
  onToggleSound,
  screenMode,
  onScreenMode,
  brightness,
  onBrightness,
  onClose,
}: {
  open: boolean;
  stationName: string;
  inactiveStatuses: readonly KitchenStatus[];
  onToggleStatus: (status: KitchenStatus) => void;
  soundSettings: KdsSoundSettings;
  onToggleSound: (setting: KdsSoundSetting) => void;
  screenMode: KdsScreenMode;
  onScreenMode: (mode: KdsScreenMode) => void;
  brightness: number;
  onBrightness: (brightness: number) => void;
  onClose: () => void;
}) {
  const t = useTranslations('kds');
  const active = activeStages(inactiveStatuses);
  const [voices, setVoices] = useState<{ name: string; natural: boolean }[]>([]);
  const [serverVoices, setServerVoices] = useState<KdsServerVoice[]>([]);
  const [voiceName, setVoiceName] = useState(readKdsVoiceName);
  const [readyBell, setReadyBell] = useState<KdsReadyBell>(readKdsReadyBell);
  const readyOn = soundSettings.orderReady;
  const [tab, setTab] = useState('display');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const lang = kdsSpeechLang();
    void kdsVoicesFor(lang).then((list) => {
      if (!cancelled)
        setVoices(list.map((voice) => ({ name: voice.name, natural: isNaturalVoice(voice) })));
    });
    void kdsServerVoices(true).then(({ voices: local }) => {
      if (cancelled) return;
      // Local voice services read Thai only; the Windows voice reads whatever the POS computer has.
      const thai = lang.toLowerCase().startsWith('th');
      setServerVoices([...(thai ? local : []), { id: 'system', name: '' }]);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const chooseReadyBell = (bell: KdsReadyBell) => {
    setReadyBell(bell);
    writeKdsReadyBell(bell);
    void playKdsReadyBell(bell);
  };

  const chooseVoice = (name: string) => {
    setVoiceName(name);
    writeKdsVoiceName(name);
    speakKds(t('voiceSample'), kdsSpeechLang());
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        data-testid="kds-settings-dialog"
        aria-describedby={undefined}
        className="max-h-[90dvh] overflow-y-auto sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>{t('settingsTitle')}</DialogTitle>
        </DialogHeader>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="h-11! w-full">
            <TabsTrigger value="display" data-testid="kds-settings-tab-display">
              {t('settingsTabDisplay')}
            </TabsTrigger>
            <TabsTrigger value="sound" data-testid="kds-settings-tab-sound">
              {t('settingsTabSound')}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="display" className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {t('settingsColumnsHint', { station: stationName })}
            </p>
            <div className="divide-y divide-border">
              {STATUS_ORDER.map((status) => {
                const config = STATUS_CONFIG[status];
                const isActive = active.includes(status);
                // The last active column cannot be switched off.
                const locked = isActive && active.length === 1;
                const stage = t(config.labelKey);
                return (
                  <div key={status} className="flex items-center gap-3 py-3">
                    <span className={`w-2.5 h-2.5 rounded-full ${config.color}`} />
                    <span
                      className={`flex-1 text-sm font-medium ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}
                    >
                      {stage}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {isActive ? t('stageActive') : t('stageSkipped')}
                    </span>
                    <Switch
                      checked={isActive}
                      label={t('stageSwitch', { status: stage })}
                      testId={`kds-stage-switch-${status}`}
                      disabled={locked}
                      onToggle={() => onToggleStatus(status)}
                    />
                  </div>
                );
              })}
              <div className="flex items-center gap-3 py-3">
                <MessageSquare size={12} aria-hidden="true" className="text-muted-foreground" />
                <span
                  className={`flex-1 text-sm font-medium ${
                    soundSettings.showMessages ? 'text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {t('messageBoxLabel')}
                </span>
                <span className="text-xs text-muted-foreground">
                  {soundSettings.showMessages ? t('stageActive') : t('stageSkipped')}
                </span>
                <Switch
                  checked={soundSettings.showMessages}
                  label={t('messageBoxLabel')}
                  testId="kds-display-switch-showMessages"
                  onToggle={() => onToggleSound('showMessages')}
                />
              </div>
            </div>
            <div className="space-y-1.5 pt-2">
              <h3 className="text-sm font-semibold text-foreground">{t('screenModeTitle')}</h3>
              <div
                role="radiogroup"
                aria-label={t('screenModeTitle')}
                className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1"
              >
                {KDS_SCREEN_MODES.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={screenMode === mode}
                    data-testid={`kds-screen-mode-${mode}`}
                    onClick={() => onScreenMode(mode)}
                    className={`min-h-11 rounded-md px-1 text-sm font-medium ${
                      screenMode === mode
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground'
                    }`}
                  >
                    {t(SCREEN_MODE_LABELS[mode])}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3 pt-2">
                <Sun size={18} aria-hidden="true" className="shrink-0 text-muted-foreground" />
                <label
                  htmlFor="kds-brightness"
                  className="shrink-0 text-sm font-medium text-foreground"
                >
                  {t('brightnessLabel')}
                </label>
                <input
                  id="kds-brightness"
                  data-testid="kds-brightness"
                  type="range"
                  min={KDS_BRIGHTNESS_MIN}
                  max={KDS_BRIGHTNESS_MAX}
                  step={1}
                  value={brightness}
                  onChange={(event) => onBrightness(Number(event.target.value))}
                  className="h-11 min-w-0 flex-1 accent-brand"
                />
                <span
                  data-testid="kds-brightness-value"
                  className="w-12 shrink-0 text-end text-sm tabular-nums text-muted-foreground"
                >
                  {brightness}%
                </span>
              </div>
            </div>
          </TabsContent>
          <TabsContent value="sound" className="space-y-2">
            <div className="divide-y divide-border">
              {SOUND_ROWS.map(({ setting, labelKey }) => {
                const on = soundSettings[setting];
                const label = t(labelKey);
                return (
                  <div key={setting} className="flex items-center gap-3 py-3">
                    <span
                      className={`flex-1 text-sm font-medium ${on ? 'text-foreground' : 'text-muted-foreground'}`}
                    >
                      {label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {on ? t('stageActive') : t('stageSkipped')}
                    </span>
                    <Switch
                      checked={on}
                      label={label}
                      testId={`kds-sound-switch-${setting}`}
                      onToggle={() => onToggleSound(setting)}
                    />
                  </div>
                );
              })}
            </div>
            <div className="space-y-1.5 pt-1">
              <label
                htmlFor="kds-ready-bell-select"
                className={`block text-sm font-medium ${readyOn ? 'text-foreground' : 'text-muted-foreground'}`}
              >
                {t('readyBellLabel')}
              </label>
              <select
                id="kds-ready-bell-select"
                data-testid="kds-ready-bell-select"
                disabled={!readyOn}
                value={readyBell}
                onChange={(event) => chooseReadyBell(event.target.value as KdsReadyBell)}
                className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm disabled:opacity-50"
              >
                {(Object.keys(KDS_READY_BELLS) as KdsReadyBell[]).map((bell) => (
                  <option key={bell} value={bell}>
                    {t(READY_BELL_LABELS[bell])}
                  </option>
                ))}
              </select>
            </div>
            <ReadyDelayField
              delay="repeat"
              label={t('readyRepeatLabel')}
              hint={t('readyRepeatHint')}
              unit={t('readyRepeatUnit')}
              disabled={!readyOn}
            />
            <ReadyDelayField
              delay="gap"
              label={t('readyGapLabel')}
              hint={t('readyGapHint')}
              unit={t('readyRepeatUnit')}
              disabled={!readyOn}
            />
            <div className="space-y-1.5 pt-1">
              <label
                htmlFor="kds-voice-select"
                className="block text-sm font-medium text-foreground"
              >
                {t('voiceLabel')}
              </label>
              <select
                id="kds-voice-select"
                data-testid="kds-voice-select"
                value={
                  voices.some((voice) => voice.name === voiceName) ||
                  serverVoices.some((voice) => KDS_SERVER_VOICE_PREFIX + voice.id === voiceName)
                    ? voiceName
                    : ''
                }
                onChange={(event) => chooseVoice(event.target.value)}
                className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm"
              >
                <option value="">{t('voiceAuto')}</option>
                {serverVoices.length > 0 && (
                  <optgroup label={t('voiceGroupServer')}>
                    {serverVoices.map((voice) => (
                      <option key={voice.id} value={KDS_SERVER_VOICE_PREFIX + voice.id}>
                        {voice.id === 'system' ? t('voiceServerSystem') : voice.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {voices.length > 0 && (
                  <optgroup label={t('voiceGroupDevice')}>
                    {voices.map((voice) => (
                      <option key={voice.name} value={voice.name}>
                        {voice.natural ? t('voiceNatural', { name: voice.name }) : voice.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              <p className="text-xs text-muted-foreground">
                {voiceName.startsWith(KDS_SERVER_VOICE_PREFIX)
                  ? t('voiceHintServer')
                  : voices.some((voice) => voice.natural)
                    ? t('voiceHintNatural')
                    : t('voiceHintEdge')}
              </p>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
