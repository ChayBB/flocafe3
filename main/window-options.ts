import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { resolveTitleBarOverlayColors, TITLE_BAR_HEIGHT } from './title-bar-theme';

/** How the main window's caption controls are supplied. */
export type TitleBarMode = 'native-overlay' | 'html-fallback';

/** The single narrow window-control verb set exposed over IPC. */
export type WindowControlAction = 'minimize' | 'toggle-maximize' | 'close';

export type BrowserWindowConstructor = new (
  options: BrowserWindowConstructorOptions,
) => BrowserWindow;

// Centers 12px macOS traffic-light buttons in the 40px custom title bar.
export const MAC_TRAFFIC_LIGHT_POSITION = { x: 16, y: 14 } as const;

/** Minimum Electron major version with dependable Window Controls Overlay APIs. */
const MIN_OVERLAY_ELECTRON_MAJOR = 33;

/** Resolves whether to use native titleBarOverlay or fallback to HTML caption buttons. */
export function resolveTitleBarMode(probe: {
  platform: NodeJS.Platform;
  electronVersion: string;
  overlayApiPresent: boolean;
}): TitleBarMode {
  if (probe.platform !== 'darwin' && probe.platform !== 'win32' && probe.platform !== 'linux') {
    return 'html-fallback';
  }
  if (probe.platform === 'darwin') {
    // macOS supplies native traffic lights via titleBarStyle: 'hiddenInset'.
    // It never needs HTML fallback caption buttons.
    return 'native-overlay';
  }
  const versionMatch =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      probe.electronVersion,
    );
  const major = versionMatch ? Number(versionMatch[1]) : Number.NaN;
  if (!Number.isSafeInteger(major) || major < MIN_OVERLAY_ELECTRON_MAJOR) return 'html-fallback';
  if (!probe.overlayApiPresent) return 'html-fallback';
  return 'native-overlay';
}

export function createMainWindow(
  BrowserWindowConstructor: BrowserWindowConstructor,
  preload: string,
  platform: NodeJS.Platform = process.platform,
  isDarkOrTitleBarMode: boolean | TitleBarMode = false,
  titleBarModeOrOptions?: TitleBarMode | Partial<BrowserWindowConstructorOptions>,
  options?: Partial<BrowserWindowConstructorOptions>,
): BrowserWindow {
  const isDark = typeof isDarkOrTitleBarMode === 'boolean' ? isDarkOrTitleBarMode : false;
  const resolvedTitleBarMode: TitleBarMode =
    typeof titleBarModeOrOptions === 'string'
      ? titleBarModeOrOptions
      : typeof isDarkOrTitleBarMode === 'string'
        ? isDarkOrTitleBarMode
        : 'native-overlay';
  const resolvedOptions =
    typeof titleBarModeOrOptions === 'object' && titleBarModeOrOptions !== null
      ? titleBarModeOrOptions
      : options;
  // Merge webPreferences instead of replacing it, so overriding one preference
  // cannot drop the generated preload or the isolation settings it enables.
  const { webPreferences: webPreferencesOverrides, ...windowOptions } = resolvedOptions ?? {};
  return new BrowserWindowConstructor({
    name: 'flo-main',
    windowStatePersistence: true,
    width: 1400,
    height: 900,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    title: 'Flo',
    titleBarStyle: platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(resolvedTitleBarMode === 'native-overlay'
      ? {
          titleBarOverlay: {
            ...resolveTitleBarOverlayColors(isDark),
            height: TITLE_BAR_HEIGHT,
          },
        }
      : {}),
    ...(platform === 'darwin' ? { trafficLightPosition: MAC_TRAFFIC_LIGHT_POSITION } : {}),
    webPreferences: {
      ...(webPreferencesOverrides ?? {}),
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The POS sounds bill-request alerts without anyone tapping it first.
      autoplayPolicy: 'no-user-gesture-required',
    },
    show: false,
    ...windowOptions,
  });
}

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MAIN_WINDOW_MIN_WIDTH = 1024;
export const MAIN_WINDOW_MIN_HEIGHT = 700;
const RESTORED_WIDTH_RATIO = 0.8;
const RESTORED_HEIGHT_RATIO = 0.85;
// A restored size this close to the work area is a maximized window in disguise.
const NEAR_MAXIMIZED_RATIO = 0.95;

function clampSize(value: number, min: number, max: number): number {
  return Math.max(Math.min(min, max), Math.min(Math.round(value), max));
}

function clampPosition(value: number, start: number, span: number, size: number): number {
  return Math.round(Math.min(Math.max(value, start), start + span - size));
}

/** Windowed bounds proportional to the display work area, centred on it. */
export function computeDefaultWindowBounds(workArea: WindowRect): WindowRect {
  const width = clampSize(
    workArea.width * RESTORED_WIDTH_RATIO,
    MAIN_WINDOW_MIN_WIDTH,
    workArea.width,
  );
  const height = clampSize(
    workArea.height * RESTORED_HEIGHT_RATIO,
    MAIN_WINDOW_MIN_HEIGHT,
    workArea.height,
  );
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
}

/** BrowserWindow minimum size, never larger than the display work area. */
export function resolveMinimumWindowSize(workArea: WindowRect): { width: number; height: number } {
  return {
    width: Math.min(MAIN_WINDOW_MIN_WIDTH, workArea.width),
    height: Math.min(MAIN_WINDOW_MIN_HEIGHT, workArea.height),
  };
}

/** True when a windowed size would cover the display anyway, so the window stays maximized. */
export function isCompactWorkArea(workArea: WindowRect): boolean {
  const { width, height } = computeDefaultWindowBounds(workArea);
  return (
    width >= workArea.width * NEAR_MAXIMIZED_RATIO &&
    height >= workArea.height * NEAR_MAXIMIZED_RATIO
  );
}

export interface MainWindowState {
  isMaximized: boolean;
  isFullScreen: boolean;
  canRestore: boolean;
}

export function getMainWindowState(
  win: Pick<BrowserWindow, 'isMaximized' | 'isFullScreen'>,
  workArea: WindowRect,
): MainWindowState {
  return {
    isMaximized: win.isMaximized(),
    isFullScreen: win.isFullScreen(),
    canRestore: !isCompactWorkArea(workArea),
  };
}

/** Clamps the minimum size to the display and keeps compact displays maximized. */
export function syncMainWindowToDisplay(
  win: Pick<
    BrowserWindow,
    'isDestroyed' | 'isMaximized' | 'isFullScreen' | 'maximize' | 'setMinimumSize'
  >,
  workArea: WindowRect,
): void {
  if (win.isDestroyed()) return;
  const minimum = resolveMinimumWindowSize(workArea);
  win.setMinimumSize(minimum.width, minimum.height);
  if (isCompactWorkArea(workArea) && !win.isMaximized() && !win.isFullScreen()) win.maximize();
}

/**
 * Keeps a remembered windowed size when it is sensible on this display, clamped into the work
 * area; otherwise (missing, tiny, near-maximized or off this display) falls back to the default.
 */
export function fitWindowBounds(
  current: WindowRect | null | undefined,
  workArea: WindowRect,
): WindowRect {
  const valid =
    current &&
    [current.x, current.y, current.width, current.height].every(Number.isFinite) &&
    current.width >= Math.min(MAIN_WINDOW_MIN_WIDTH, workArea.width) &&
    current.height >= Math.min(MAIN_WINDOW_MIN_HEIGHT, workArea.height);
  if (!valid) return computeDefaultWindowBounds(workArea);
  const nearMaximized =
    current.width >= workArea.width * NEAR_MAXIMIZED_RATIO &&
    current.height >= workArea.height * NEAR_MAXIMIZED_RATIO;
  const intersects =
    current.x < workArea.x + workArea.width &&
    current.x + current.width > workArea.x &&
    current.y < workArea.y + workArea.height &&
    current.y + current.height > workArea.y;
  if (nearMaximized || !intersects) return computeDefaultWindowBounds(workArea);
  const width = Math.min(Math.round(current.width), workArea.width);
  const height = Math.min(Math.round(current.height), workArea.height);
  return {
    x: clampPosition(current.x, workArea.x, workArea.width, width),
    y: clampPosition(current.y, workArea.y, workArea.height, height),
    width,
    height,
  };
}

/** Minimal window surface needed to service a window-control action. */
export type WindowControlTarget = Pick<
  BrowserWindow,
  'isDestroyed' | 'minimize' | 'isMaximized' | 'maximize' | 'unmaximize' | 'close'
> & {
  isFullScreen?: () => boolean;
  setFullScreen?: (flag: boolean) => void;
  setBounds?: (bounds: WindowRect) => void;
};

/** Applies a window action (minimize, toggle-maximize, close) preserving close-to-tray. */
export function applyWindowControlAction(
  win: WindowControlTarget,
  action: unknown,
  restore: {
    canRestore?: () => boolean;
    resolveRestoredBounds?: () => WindowRect | null;
  } = {},
): { success: true } | { error: string } {
  if (action !== 'minimize' && action !== 'toggle-maximize' && action !== 'close') {
    return { error: 'Unsupported window action' };
  }
  switch (action) {
    case 'minimize':
      win.minimize();
      break;
    case 'toggle-maximize':
      if (typeof win.isFullScreen === 'function' && win.isFullScreen()) {
        if (typeof win.setFullScreen === 'function') {
          win.setFullScreen(false);
        } else {
          win.unmaximize();
        }
      } else if (win.isMaximized()) {
        if (restore.canRestore && !restore.canRestore()) break;
        // Resolve before unmaximizing so the display is the one the maximized window fills.
        const restored = restore.resolveRestoredBounds?.() ?? null;
        win.unmaximize();
        if (restored && typeof win.setBounds === 'function') win.setBounds(restored);
      } else {
        win.maximize();
      }
      break;
    case 'close':
      win.close();
      break;
  }
  return { success: true };
}

export function getPopupWindowOptions(isBlank: boolean): BrowserWindowConstructorOptions {
  return {
    width: isBlank ? 800 : 1280,
    height: isBlank ? 600 : 800,
    title: isBlank ? 'Print Receipt' : 'Flo - Kitchen Display',
    autoHideMenuBar: isBlank,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
}

export function getKdsWindowOptions(): BrowserWindowConstructorOptions {
  return {
    width: 1200,
    height: 800,
    title: 'Flo - Kitchen Display',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // The kitchen display must sound its alerts without anyone tapping it first.
      autoplayPolicy: 'no-user-gesture-required',
    },
  };
}

export function createKdsWindow(BrowserWindowConstructor: BrowserWindowConstructor): BrowserWindow {
  return new BrowserWindowConstructor(getKdsWindowOptions());
}

type LocalWindowUrlChecker = (rawUrl: string, port: number, localIp?: string) => boolean;

export function createLocalWindowOpenHandler(
  isAllowedLocalWindowUrl: LocalWindowUrlChecker,
  getServerPort: () => number,
  getLocalIP: () => string,
): (details: {
  url: string;
}) => { action: 'allow'; overrideBrowserWindowOptions: BrowserWindowConstructorOptions } | null {
  return ({ url }) => {
    const isBlank = url === 'about:blank' || url === '';
    if (!isAllowedLocalWindowUrl(url, getServerPort(), getLocalIP())) return null;

    return {
      action: 'allow',
      overrideBrowserWindowOptions: getPopupWindowOptions(isBlank),
    };
  };
}

/**
 * Creates a will-navigate event handler for the privileged main window.
 * Allows safe local application URLs, delegates safe external HTTP/HTTPS URLs
 * to the default system browser via shell.openExternal, and blocks unsafe schemes.
 */
export function createMainWindowWillNavigateHandler(
  isAllowedLocalWindowUrl: LocalWindowUrlChecker,
  getServerPort: () => number,
  getLocalIP: () => string,
  isSafeExternalUrl: (rawUrl: string) => boolean,
  openExternal: (url: string) => Promise<unknown> | unknown,
  warn: (message: string, ...args: unknown[]) => void = console.warn,
): (event: { preventDefault: () => void }, url: string) => void {
  return (event, url) => {
    if (isAllowedLocalWindowUrl(url, getServerPort(), getLocalIP())) {
      return;
    }
    event.preventDefault();
    if (isSafeExternalUrl(url)) {
      try {
        const res = openExternal(url);
        if (res && typeof (res as Promise<unknown>).catch === 'function') {
          (res as Promise<unknown>).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            warn('[Flo] Failed to open external URL:', message);
          });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        warn('[Flo] Failed to open external URL:', message);
      }
    } else {
      warn('[Flo] Blocked unsafe navigation URL:', url);
    }
  };
}

export interface ChildWindowWebContentsTarget {
  setWindowOpenHandler: (handler: (details: { url: string }) => { action: 'deny' }) => void;
  on: (
    event: 'will-navigate',
    listener: (event: { preventDefault: () => void }, url: string) => void,
  ) => unknown;
}

export interface ParentWebContentsTarget {
  on: (
    event: 'did-create-window',
    listener: (childWindow: { webContents: ChildWindowWebContentsTarget }) => void,
  ) => unknown;
}

/**
 * Attaches lifecycle guards to child windows spawned from the main window so
 * nested popups are denied and child-window navigation is confined by the same
 * local allowlist and external-browser routing as the main window.
 */
export function attachChildWindowLifecycleGuards(
  parentWebContents: ParentWebContentsTarget,
  willNavigateHandler: (event: { preventDefault: () => void }, url: string) => void,
): void {
  parentWebContents.on('did-create-window', (childWindow) => {
    childWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    childWindow.webContents.on('will-navigate', willNavigateHandler);
  });
}
