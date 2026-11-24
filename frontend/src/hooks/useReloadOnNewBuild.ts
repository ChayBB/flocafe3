'use client';

import { useEffect, useRef } from 'react';
import { reopenPage } from '@/lib/reopen-page';

const BUILD_CHECK_MS = 60_000;

/**
 * Reloads a page left open on a phone or tablet once the POS serves a newer frontend, checked every
 * minute and whenever the page comes back into view. It waits while `canReload` is false, such as
 * while unsent items are on the ticket.
 */
export function useReloadOnNewBuild(infoPath: string, canReload: boolean): void {
  const firstBuildRef = useRef<string | null>(null);
  const pendingRef = useRef(false);
  const canReloadRef = useRef(canReload);

  useEffect(() => {
    canReloadRef.current = canReload;
    if (canReload && pendingRef.current) reopenPage();
  }, [canReload]);

  useEffect(() => {
    let stopped = false;
    const check = async () => {
      try {
        const response = await fetch(infoPath, { cache: 'no-store' });
        if (!response.ok) return;
        const build = (await response.json())?.frontend_build;
        if (stopped || typeof build !== 'string' || !build) return;
        if (firstBuildRef.current === null) {
          firstBuildRef.current = build;
          return;
        }
        if (build === firstBuildRef.current) return;
        pendingRef.current = true;
        if (canReloadRef.current) reopenPage();
      } catch {}
    };
    void check();
    const timer = window.setInterval(() => void check(), BUILD_CHECK_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [infoPath]);
}
