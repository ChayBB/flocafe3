'use client';

import { useState } from 'react';
import { useTranslations } from 'use-intl';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface OwnerOverrideInput {
  pin: string;
  reason: string;
}

/** Display codes the backend returns when an owner override is refused. */
export const OWNER_OVERRIDE_REFUSAL_CODES = new Set([
  'owner_pin_invalid',
  'owner_override_reason_required',
  'pin_rate_limited',
]);

export function ownerOverrideRefusalMessage(
  code: string,
  t: ReturnType<typeof useTranslations>,
): string {
  if (code === 'owner_override_reason_required') return t('ownerOverrideReasonRequired');
  if (code === 'pin_rate_limited') return t('ownerOverrideRateLimited');
  return t('ownerOverridePinInvalid');
}

/**
 * Owner PIN plus reason for one cash action that the shift gate refused. The
 * backend verifies the PIN and records the use; this dialog only collects it.
 */
export function OwnerOverrideDialog({
  open,
  note,
  error,
  submitting,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  note?: string;
  error?: string | null;
  submitting?: boolean;
  onCancel: () => void;
  onConfirm: (input: OwnerOverrideInput) => void;
}) {
  const t = useTranslations('pos');
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const close = () => {
    setPin('');
    setReason('');
    setLocalError(null);
    onCancel();
  };

  const submit = () => {
    if (!/^\d{4,6}$/.test(pin)) {
      setLocalError(t('ownerOverridePinInvalid'));
      return;
    }
    if (reason.trim().length < 3) {
      setLocalError(t('ownerOverrideReasonRequired'));
      return;
    }
    setLocalError(null);
    onConfirm({ pin, reason: reason.trim() });
  };

  const shownError = localError || error;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !submitting && close()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('ownerOverrideTitle')}</DialogTitle>
          <DialogDescription>{t('ownerOverrideDescription')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="owner-override-pin">{t('ownerOverridePin')}</Label>
            <Input
              id="owner-override-pin"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="owner-override-reason">{t('ownerOverrideReason')}</Label>
            <Input
              id="owner-override-reason"
              maxLength={200}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          {note && <p className="text-xs text-muted-foreground">{note}</p>}
          {shownError && (
            <p role="alert" className="text-sm text-destructive">
              {shownError}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} disabled={submitting}>
              {t('ownerOverrideCancel')}
            </Button>
            <Button type="submit" disabled={submitting}>
              {t('ownerOverrideConfirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
