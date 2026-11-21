'use client';

import { useEffect } from 'react';

const KEEP_AWAKE_VIDEO = '/kds-keep-awake.webm';

/**
 * Keeps the screen from sleeping while mounted, so a kitchen display stays awake to read out orders.
 * Always plays a tiny silent looping video, which browsers keep the screen awake for, and also holds
 * a Screen Wake Lock where the page is a secure context (a display opened by LAN IP over http is not).
 */
export function useKeepScreenAwake(): void {
  useEffect(() => {
    let disposed = false;
    let lock: WakeLockSentinel | null = null;
    let video: HTMLVideoElement | null = null;
    const canLock = window.isSecureContext && 'wakeLock' in navigator;

    const playVideo = () => {
      if (!video) {
        video = document.createElement('video');
        video.src = KEEP_AWAKE_VIDEO;
        video.loop = true;
        video.muted = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.setAttribute('aria-hidden', 'true');
        video.dataset.testid = 'keep-screen-awake';
        Object.assign(video.style, {
          position: 'fixed',
          bottom: '0',
          right: '0',
          width: '1px',
          height: '1px',
          opacity: '0.01',
          pointerEvents: 'none',
        });
        document.body.appendChild(video);
      }
      if (video.paused) void video.play().catch(() => {});
    };

    const acquire = async () => {
      if (disposed || document.visibilityState !== 'visible') return;
      playVideo();
      if (!canLock || (lock && !lock.released)) return;
      try {
        lock = await navigator.wakeLock.request('screen');
        if (disposed) void lock.release().catch(() => {});
      } catch {}
    };

    const onVisible = () => void acquire();
    void acquire();
    // Browsers that refuse to start the video without a tap get it on the first touch or key.
    document.addEventListener('visibilitychange', onVisible);
    document.addEventListener('pointerdown', onVisible);
    document.addEventListener('keydown', onVisible);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('pointerdown', onVisible);
      document.removeEventListener('keydown', onVisible);
      if (lock) void lock.release().catch(() => {});
      if (video) {
        video.pause();
        video.remove();
      }
    };
  }, []);
}
