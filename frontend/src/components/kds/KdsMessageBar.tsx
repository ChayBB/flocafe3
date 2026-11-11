'use client';

import { useState, useSyncExternalStore } from 'react';
import {
  ArrowLeftRight,
  Ban,
  Check,
  Merge,
  Printer,
  PrinterX,
  ShoppingBag,
  TriangleAlert,
} from 'lucide-react';
import { useTranslations } from 'use-intl';
import { KdsBellButton } from '@/components/kds/KdsBellButton';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  getKdsKotPrompt,
  getServerKdsKotPrompt,
  subscribeKdsMessages,
  type KdsMessage,
} from '@/lib/kds-messages';

const ICONS = {
  move: ArrowLeftRight,
  merge: Merge,
  takeaway: ShoppingBag,
  cancelled: Ban,
  emergency: TriangleAlert,
  kot_unprinted: PrinterX,
} as const;

/**
 * The bar under the board: table moves and merges, items switched to take-away and emergency calls
 * stay here until someone taps to acknowledge them; a kitchen ticket that did not print opens a
 * choice to print it again or drop it. The bell button sits at its end when shown.
 */
const KOT_REASON_KEYS = {
  paper_out: 'kotReasonPaperOut',
  needs_attention: 'kotReasonNeedsAttention',
  offline: 'kotReasonOffline',
  timeout: 'kotReasonOffline',
} as const;

export function KdsMessageBar({
  messages,
  onDismiss,
  onReprintKot,
  onDropKot,
  showMessages,
  showBell,
}: {
  messages: KdsMessage[];
  onDismiss: (id: string) => void;
  /** Resolves false when the ticket still did not print. */
  onReprintKot: (message: KdsMessage) => Promise<boolean>;
  onDropKot: (message: KdsMessage) => void;
  showMessages: boolean;
  showBell: boolean;
}) {
  const t = useTranslations('kds');
  const [kot, setKot] = useState<KdsMessage | null>(null);
  const [printing, setPrinting] = useState(false);
  const [failed, setFailed] = useState(false);
  const openKot = (message: KdsMessage) => {
    setFailed(false);
    setKot(message);
  };
  const kotPrompt = useSyncExternalStore(
    subscribeKdsMessages,
    getKdsKotPrompt,
    getServerKdsKotPrompt,
  );
  // A prompt from before this bar mounted was already offered.
  const [promptSeen, setPromptSeen] = useState(() => getKdsKotPrompt()?.nonce ?? null);
  if (kotPrompt && kotPrompt.nonce !== promptSeen && !printing) {
    const prompted = messages.find((message) => message.id === kotPrompt.id);
    setPromptSeen(kotPrompt.nonce);
    if (prompted) openKot(prompted);
  }
  // The notice can turn ready while its dialog is open.
  const shown = kot ? (messages.find((message) => message.id === kot.id) ?? kot) : null;
  const reasonKey =
    shown?.reason && shown.reason in KOT_REASON_KEYS
      ? KOT_REASON_KEYS[shown.reason as keyof typeof KOT_REASON_KEYS]
      : undefined;
  const reprint = async () => {
    if (!kot) return;
    setPrinting(true);
    setFailed(false);
    const printed = await onReprintKot(kot);
    setPrinting(false);
    if (printed) setKot(null);
    else setFailed(true);
  };
  return (
    <div
      data-testid="kds-message-bar"
      className="mt-3 flex min-h-14 shrink-0 items-stretch justify-end gap-2"
    >
      {showMessages && (
        <div
          data-testid="kds-message-box"
          className="flex min-w-0 flex-1 items-stretch gap-2 overflow-x-auto rounded-lg border border-border bg-card p-1.5"
        >
          {messages.length === 0 ? (
            <span className="flex items-center px-2 text-sm text-muted-foreground">
              {t('messagesEmpty')}
            </span>
          ) : (
            messages.map((message) => {
              const Icon = ICONS[message.kind];
              if (message.kind === 'kot_unprinted') {
                return (
                  <button
                    key={message.id}
                    type="button"
                    data-testid="kds-message"
                    data-kind={message.kind}
                    onClick={() => openKot(message)}
                    className="flex min-h-11 shrink-0 items-center gap-2 rounded-md border border-pink-200 bg-pink-50 px-3 text-sm font-medium text-pink-800 hover:bg-pink-100"
                  >
                    <Icon size={18} className="text-pink-500" />
                    <span className="max-w-[28rem] truncate">{message.text}</span>
                    <span className="text-xs tabular-nums text-pink-700/70">
                      {new Date(message.at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </button>
                );
              }
              const emergency = message.kind === 'emergency';
              return (
                <div
                  key={message.id}
                  data-testid="kds-message"
                  data-kind={message.kind}
                  className={`flex shrink-0 items-center gap-2 rounded-md border ps-3 pe-1 text-sm font-medium ${
                    emergency
                      ? 'border-red-500 bg-red-600 text-white'
                      : 'border-(--kds-pending-line) bg-(--kds-pending-tint) text-foreground'
                  }`}
                >
                  <Icon
                    size={18}
                    className={emergency ? 'text-white' : 'text-(--kds-pending-text)'}
                  />
                  <span className="max-w-[28rem] truncate">{message.text}</span>
                  <span
                    className={`text-xs tabular-nums ${emergency ? 'text-white/80' : 'text-muted-foreground'}`}
                  >
                    {new Date(message.at).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  <button
                    type="button"
                    data-testid="kds-message-dismiss"
                    onClick={() => onDismiss(message.id)}
                    aria-label={t('messageDismiss')}
                    title={t('messageDismiss')}
                    className={`flex min-h-11 min-w-11 items-center justify-center rounded-md ${
                      emergency ? 'hover:bg-white/15' : 'hover:bg-muted'
                    }`}
                  >
                    <Check size={18} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}
      {showBell && <KdsBellButton />}
      <Dialog open={kot !== null} onOpenChange={(open) => !open && !printing && setKot(null)}>
        <DialogContent data-testid="kds-kot-dialog" className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PrinterX size={20} className="text-pink-500" />
              {shown?.text}
            </DialogTitle>
          </DialogHeader>
          {shown?.ready && !failed ? (
            <p data-testid="kds-kot-ready" className="text-sm font-medium text-emerald-700">
              {t('kotPrinterReady')}
            </p>
          ) : (
            reasonKey &&
            !failed && (
              <p data-testid="kds-kot-reason" className="text-sm text-muted-foreground">
                {t(reasonKey)}
              </p>
            )
          )}
          {failed && (
            <p data-testid="kds-kot-failed" className="text-sm text-red-600">
              {t('kotReprintFailed')}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Button
              data-testid="kds-kot-reprint"
              className="h-12"
              disabled={printing || !kot?.ref}
              onClick={reprint}
            >
              <Printer />
              {printing ? t('kotReprinting') : t('kotReprint')}
            </Button>
            <Button
              data-testid="kds-kot-drop"
              variant="outline"
              className="h-12"
              disabled={printing}
              onClick={() => {
                if (kot) onDropKot(kot);
                setKot(null);
              }}
            >
              {t('kotDrop')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
