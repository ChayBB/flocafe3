'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import { ChefHat } from 'lucide-react';
import { useAuthStore } from '@/store/auth';
import { STORE_BRANDING_CHANGED } from '@/components/settings/StoreBrandingCard';

export default function PosStoreBanner() {
  const tenant = useAuthStore((state) => state.currentTenant);
  const [images, setImages] = useState({ store_logo: '', store_cover: '' });

  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading || document.visibilityState === 'hidden') return;
      loading = true;
      try {
        const { data } = await api.get('/settings/branding', { signal: controller.signal });
        if (!controller.signal.aborted) setImages(data);
      } catch {
        // Branding must never interrupt taking orders offline.
      } finally {
        loading = false;
      }
    };
    void load();
    window.addEventListener(STORE_BRANDING_CHANGED, load);
    window.addEventListener('focus', load);
    document.addEventListener('visibilitychange', load);
    return () => {
      controller.abort();
      window.removeEventListener(STORE_BRANDING_CHANGED, load);
      window.removeEventListener('focus', load);
      document.removeEventListener('visibilitychange', load);
    };
  }, [tenant?.id]);

  if (!images.store_logo && !images.store_cover) return null;

  return (
    <header
      data-testid="pos-store-banner"
      className="relative -mx-3 -mt-2 shrink-0 bg-background sm:-mx-4 sm:-mt-2.5"
    >
      <div className="relative h-48 overflow-hidden bg-gradient-to-br from-brand to-orange-300 sm:h-60">
        {images.store_cover && (
          <img
            src={images.store_cover}
            alt=""
            data-testid="pos-store-cover"
            className="absolute inset-0 size-full object-cover"
          />
        )}
        <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/35 to-transparent" />
      </div>
      <div className="relative -mt-14 flex flex-col items-center px-4 pb-4 sm:-mt-16">
        <div className="flex size-28 items-center justify-center overflow-hidden rounded-full border-4 border-white bg-white text-brand shadow-lg sm:size-32">
          {images.store_logo ? (
            <img
              src={images.store_logo}
              alt={tenant?.business_name || ''}
              data-testid="pos-store-logo"
              className="size-full object-contain"
            />
          ) : (
            <ChefHat size={44} />
          )}
        </div>
        <p className="mt-3 max-w-full truncate text-center text-2xl font-bold text-foreground">
          {tenant?.business_name}
        </p>
      </div>
    </header>
  );
}
