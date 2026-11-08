'use client';

import { useState } from 'react';
import { QrCode } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/hooks/use-confirm';
import { QrRelayPairing } from '@/components/settings/QrRelayPairing';
import TableStickerSheet from '@/components/tables/TableStickerSheet';

/** How customers reach table-QR ordering from outside the shop network, table stickers, and retiring every table QR. */
export function GuestQrNetworkSettings({
  disabled,
  showRelayPairing = true,
}: {
  disabled: boolean;
  showRelayPairing?: boolean;
}) {
  const t = useTranslations('settings');
  const { confirm, ConfirmDialog } = useConfirm();
  const [stickersOpen, setStickersOpen] = useState(false);

  const rotate = async () => {
    const ok = await confirm(t('qrRotateConfirm'), {
      title: t('qrRotate'),
      confirmLabel: t('qrRotate'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.post('/settings/guest-qr/rotate');
      toast.success(t('qrRotated'));
    } catch {
      toast.error(t('saveFailed'));
    }
  };

  return (
    <div data-testid="settings-qr-network" className="space-y-3 ps-7">
      <QrRelayPairing disabled={disabled} showRelayPairing={showRelayPairing} />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={disabled}
          onClick={() => setStickersOpen(true)}
          data-testid="settings-table-stickers"
        >
          <QrCode size={15} className="me-1.5" />
          {t('qrTableStickers')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void rotate()}
        >
          {t('qrRotate')}
        </Button>
      </div>
      {stickersOpen && <TableStickerSheet onClose={() => setStickersOpen(false)} />}
      {ConfirmDialog}
    </div>
  );
}
