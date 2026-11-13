'use client';

import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { MAX_RAW_FILE_SIZE, fitImage } from '@/lib/image-utils';
import { getThermalPreviewDataUrl, processReceiptLogoFile } from '@/lib/printer/logo-processor';

type Kind = 'logo' | 'cover';

/** Window event fired after the logo or cover is saved, so other views can refresh. */
export const STORE_BRANDING_CHANGED = 'flocafe:store-branding-changed';

const FIELD: Record<Kind, 'store_logo' | 'store_cover'> = {
  logo: 'store_logo',
  cover: 'store_cover',
};
// Mirrors the backend caps in main/lib/store-branding.ts.
const LIMITS: Record<Kind, { side: number; length: number }> = {
  logo: { side: 512, length: 300_000 },
  cover: { side: 1600, length: 1_500_000 },
};

/** The store logo and cover photo shown in the Server App and table-QR menu header. */
export function StoreBrandingCard({
  readOnly = false,
  onReceiptLogoChange,
}: {
  readOnly?: boolean;
  onReceiptLogoChange?: (logo: string, raster: string) => void;
}) {
  const t = useTranslations('settings');
  const [images, setImages] = useState<Record<Kind, string>>({ logo: '', cover: '' });
  const [saving, setSaving] = useState<Kind | null>(null);
  const [receiptRaster, setReceiptRaster] = useState('');
  const thermalPreview = getThermalPreviewDataUrl(receiptRaster);
  const inputs = { logo: useRef<HTMLInputElement>(null), cover: useRef<HTMLInputElement>(null) };

  useEffect(() => {
    api
      .get<{
        store_logo: string;
        store_cover: string;
        receipt_logo: string;
        receipt_logo_raster: string;
      }>('/settings/branding')
      .then(({ data }) => {
        setImages({ logo: data.store_logo || data.receipt_logo, cover: data.store_cover });
        setReceiptRaster(data.receipt_logo_raster);
      })
      .catch(() => {});
  }, []);

  const save = async (kind: Kind, value: string, raster = '', receiptLogo = value) => {
    setSaving(kind);
    try {
      const { data } = await api.put<{
        store_logo: string;
        store_cover: string;
        receipt_logo: string;
      }>('/settings/branding', {
        [FIELD[kind]]: value,
        ...(kind === 'logo' ? { receipt_logo: receiptLogo, receipt_logo_raster: raster } : {}),
      });
      setImages({ logo: data.store_logo || data.receipt_logo, cover: data.store_cover });
      if (kind === 'logo') {
        setReceiptRaster(raster);
        onReceiptLogoChange?.(receiptLogo, raster);
      }
      window.dispatchEvent(new Event(STORE_BRANDING_CHANGED));
      toast.success(t('allSaved'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(null);
    }
  };

  const pick = async (kind: Kind, file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_RAW_FILE_SIZE) {
      toast.error(t('menuImageTooLarge'));
      return;
    }
    const dataUri = await fitImage(file, LIMITS[kind].side, LIMITS[kind].length);
    if (!dataUri) {
      toast.error(t('menuImageTooLarge'));
      return;
    }
    try {
      if (kind === 'logo') {
        const receipt = await processReceiptLogoFile(file);
        await save(kind, dataUri, receipt.rasterJson, receipt.originalDataUrl);
      } else {
        await save(kind, dataUri);
      }
    } catch {
      toast.error(t('saveFailed'));
    }
  };

  const slot = (kind: Kind) => (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">
        {kind === 'logo' ? t('menuLogo') : t('menuCover')}
      </p>
      <div
        className={`flex items-center justify-center overflow-hidden rounded-lg border border-dashed border-border bg-muted/40 ${kind === 'logo' ? 'size-24 rounded-full' : 'aspect-[3/1] w-full max-w-md'}`}
      >
        {images[kind] ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={images[kind]}
            alt=""
            className={`size-full ${kind === 'logo' ? 'object-contain' : 'object-cover'}`}
          />
        ) : (
          <ImagePlus size={22} className="text-muted-foreground" />
        )}
      </div>
      {!readOnly && (
        <input
          ref={inputs[kind]}
          type="file"
          accept={
            kind === 'logo'
              ? 'image/*,.bmp,.svg,.webp,.png,.jpg,.jpeg,.gif,.avif'
              : 'image/png,image/jpeg,image/webp'
          }
          className="hidden"
          data-testid={`settings-store-${kind}-input`}
          onChange={(e) => {
            void pick(kind, e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      )}
      {kind === 'logo' && thermalPreview && (
        <img
          src={thermalPreview}
          alt={`${t('storeLogo')} (1-bit)`}
          className="max-h-16 max-w-[200px] rounded-lg border border-border bg-white p-2"
        />
      )}
      {!readOnly && (
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={saving !== null}
            onClick={() => inputs[kind].current?.click()}
          >
            <ImagePlus size={15} className="me-1.5" />
            {images[kind] ? t('menuImageChange') : t('menuImageUpload')}
          </Button>
          {images[kind] && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={saving !== null}
              onClick={() => void save(kind, '')}
              aria-label={t('menuImageRemove')}
              title={t('menuImageRemove')}
            >
              <Trash2 size={15} />
            </Button>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div data-testid="settings-store-branding" className="border-t border-border pt-6">
      <p className="font-medium text-foreground">{t('menuBranding')}</p>
      <p className="mb-4 text-sm text-muted-foreground">{t('menuBrandingHint')}</p>
      <div className="grid gap-6 sm:grid-cols-[auto_1fr]">
        {slot('logo')}
        {slot('cover')}
      </div>
    </div>
  );
}
