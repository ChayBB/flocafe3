import * as assert from 'node:assert/strict';
import { isAllowedLocalWindowUrl } from '../main/security/url-allowlist';
import {
  applyTitleBarOverlayTheme,
  appendThemeQueryParam,
  attachTitleBarThemeSync,
  isThemeMode,
  resolveInitialIsDark,
  resolveThemeMode,
  resolveTitleBarOverlayColors,
  supportsTitleBarOverlay,
  TITLE_BAR_HEIGHT,
  TITLE_BAR_OVERLAY_COLORS,
} from '../main/title-bar-theme';
import {
  applyWindowControlAction,
  createKdsWindow,
  createLocalWindowOpenHandler,
  computeDefaultWindowBounds,
  createMainWindow,
  fitWindowBounds,
  getMainWindowState,
  isCompactWorkArea,
  resolveMinimumWindowSize,
  resolveTitleBarMode,
  syncMainWindowToDisplay,
} from '../main/window-options';

class FakeBrowserWindow {
  constructor(public readonly options: any) {}
}

const macMainWindow = createMainWindow(FakeBrowserWindow as any, '/tmp/preload.js', 'darwin');
const windowsMainWindow = createMainWindow(FakeBrowserWindow as any, '/tmp/preload.js', 'win32');
const linuxMainWindow = createMainWindow(FakeBrowserWindow as any, '/tmp/preload.js', 'linux');
const darkMainWindow = createMainWindow(
  FakeBrowserWindow as any,
  '/tmp/preload.js',
  'darwin',
  true,
);

assert.equal(macMainWindow.options.name, 'flo-main');
assert.equal(macMainWindow.options.windowStatePersistence, true);
assert.equal(macMainWindow.options.titleBarStyle, 'hiddenInset');
assert.equal(windowsMainWindow.options.titleBarStyle, 'hidden');
assert.equal(linuxMainWindow.options.titleBarStyle, 'hidden');
assert.deepEqual(macMainWindow.options.titleBarOverlay, {
  color: '#ffffff',
  symbolColor: '#0a0a0a',
  height: 40,
});
assert.deepEqual(darkMainWindow.options.titleBarOverlay, {
  color: '#0f0f0f',
  symbolColor: '#fafafa',
  height: 40,
});
assert.equal(macMainWindow.options.webPreferences.preload, '/tmp/preload.js');
assert.equal(macMainWindow.options.webPreferences.contextIsolation, true);
assert.equal(macMainWindow.options.webPreferences.nodeIntegration, false);
assert.equal(macMainWindow.options.webPreferences.sandbox, true);
assert.equal(
  'frame' in macMainWindow.options,
  false,
  'the native-controls design does not remove the window frame',
);

// An options override merges webPreferences: it cannot replace the generated
// preload and isolation settings, and its other keys still apply.
const overriddenOptionsWindow = createMainWindow(
  FakeBrowserWindow as any,
  '/tmp/preload.js',
  'darwin',
  false,
  { width: 1200, webPreferences: { backgroundThrottling: false } },
);
assert.equal(overriddenOptionsWindow.options.width, 1200);
assert.equal(overriddenOptionsWindow.options.webPreferences.preload, '/tmp/preload.js');
assert.equal(overriddenOptionsWindow.options.webPreferences.contextIsolation, true);
assert.equal(overriddenOptionsWindow.options.webPreferences.nodeIntegration, false);
assert.equal(overriddenOptionsWindow.options.webPreferences.sandbox, true);
assert.equal(overriddenOptionsWindow.options.webPreferences.backgroundThrottling, false);

// macOS traffic lights are vertically centered in the 40px bar (buttons are 12px tall).
assert.deepEqual(macMainWindow.options.trafficLightPosition, { x: 16, y: 14 });
assert.equal(
  'trafficLightPosition' in windowsMainWindow.options,
  false,
  'trafficLightPosition is macOS-only',
);
assert.equal(
  'trafficLightPosition' in linuxMainWindow.options,
  false,
  'trafficLightPosition is macOS-only',
);

const localWindowOpenHandler = createLocalWindowOpenHandler(
  isAllowedLocalWindowUrl,
  () => 3001,
  () => '192.168.1.50',
);

// ── Title-bar mode resolution (Phase 2 fallback gating) ───────────────────────

// Captain-verified configuration: Debian + GNOME on real hardware with a
// modern Electron keeps native overlay controls.
assert.equal(
  resolveTitleBarMode({ platform: 'linux', electronVersion: '43.4.0', overlayApiPresent: true }),
  'native-overlay',
);
assert.equal(
  resolveTitleBarMode({ platform: 'darwin', electronVersion: '43.4.0', overlayApiPresent: true }),
  'native-overlay',
);
assert.equal(
  resolveTitleBarMode({ platform: 'darwin', electronVersion: '43.4.0', overlayApiPresent: false }),
  'native-overlay',
  'macOS supplies native traffic lights and resolves to native-overlay even without WCO overlay API',
);
assert.equal(
  resolveTitleBarMode({ platform: 'darwin', electronVersion: '32.0.0', overlayApiPresent: false }),
  'native-overlay',
  'macOS supplies native traffic lights across runtime versions',
);
assert.equal(
  resolveTitleBarMode({ platform: 'win32', electronVersion: '33.0.0', overlayApiPresent: true }),
  'native-overlay',
);
// Pre-33 Electron builds can end up hidden-with-no-controls when the overlay
// silently fails; they must fall back instead.
assert.equal(
  resolveTitleBarMode({ platform: 'linux', electronVersion: '32.3.1', overlayApiPresent: true }),
  'html-fallback',
);
assert.equal(
  resolveTitleBarMode({ platform: 'win32', electronVersion: '32.3.1', overlayApiPresent: true }),
  'html-fallback',
);
// Missing runtime overlay API (defensive probe) forces the fallback on Windows/Linux.
assert.equal(
  resolveTitleBarMode({ platform: 'linux', electronVersion: '43.4.0', overlayApiPresent: false }),
  'html-fallback',
);
assert.equal(
  resolveTitleBarMode({ platform: 'win32', electronVersion: '43.4.0', overlayApiPresent: false }),
  'html-fallback',
);
assert.equal(
  resolveTitleBarMode({ platform: 'freebsd', electronVersion: '43.4.0', overlayApiPresent: true }),
  'html-fallback',
);
// Malformed version strings must fail closed.
assert.equal(
  resolveTitleBarMode({ platform: 'linux', electronVersion: '', overlayApiPresent: true }),
  'html-fallback',
);
assert.equal(
  resolveTitleBarMode({ platform: 'linux', electronVersion: '33oops', overlayApiPresent: true }),
  'html-fallback',
);

const linuxFallbackMainWindow = createMainWindow(
  FakeBrowserWindow as any,
  '/tmp/preload.js',
  'linux',
  'html-fallback',
);
assert.equal(linuxFallbackMainWindow.options.titleBarStyle, 'hidden');
assert.equal(
  'titleBarOverlay' in linuxFallbackMainWindow.options,
  false,
  'fallback mode must not ship hidden-with-no-controls: renderer draws the caption buttons',
);
assert.equal(linuxFallbackMainWindow.options.webPreferences.contextIsolation, true);

// ── Window-control action application (IPC verb set) ─────────────────────────

class FakeWindow {
  calls: string[] = [];
  maximized = false;
  fullscreen = false;
  isDestroyed() {
    return false;
  }
  minimize() {
    this.calls.push('minimize');
  }
  isMaximized() {
    return this.maximized;
  }
  maximize() {
    this.maximized = true;
    this.calls.push('maximize');
  }
  unmaximize() {
    this.maximized = false;
    this.calls.push('unmaximize');
  }
  isFullScreen() {
    return this.fullscreen;
  }
  setFullScreen(val: boolean) {
    this.fullscreen = val;
    this.calls.push(`fullscreen:${val}`);
  }
  close() {
    this.calls.push('close');
  }
}

const win = new FakeWindow();
assert.deepEqual(applyWindowControlAction(win as any, 'minimize'), { success: true });
assert.deepEqual(applyWindowControlAction(win as any, 'toggle-maximize'), { success: true });
assert.equal(win.maximized, true, 'toggle-maximize maximizes a restored window');
assert.deepEqual(applyWindowControlAction(win as any, 'toggle-maximize'), { success: true });
assert.equal(win.maximized, false, 'toggle-maximize restores a maximized window');
win.fullscreen = true;
assert.deepEqual(applyWindowControlAction(win as any, 'toggle-maximize'), { success: true });
assert.equal(win.fullscreen, false, 'toggle-maximize exits fullscreen if window is fullscreen');
assert.deepEqual(applyWindowControlAction(win as any, 'close'), { success: true });
assert.deepEqual(win.calls, ['minimize', 'maximize', 'unmaximize', 'fullscreen:false', 'close']);

const fullHd = { x: 0, y: 0, width: 1920, height: 1040 };
const laptop = { x: 0, y: 0, width: 1366, height: 728 };
const rightMonitor = { x: 1920, y: 0, width: 2560, height: 1400 };
assert.deepEqual(
  computeDefaultWindowBounds(fullHd),
  { x: 192, y: 78, width: 1536, height: 884 },
  'default windowed size is ~80% x 85% of the work area, centred',
);
assert.deepEqual(
  computeDefaultWindowBounds(laptop),
  { x: 137, y: 14, width: 1093, height: 700 },
  'a 1366x768 laptop gets the minimum height and 80% width',
);
assert.deepEqual(
  computeDefaultWindowBounds({ x: 0, y: 0, width: 900, height: 600 }),
  { x: 0, y: 0, width: 900, height: 600 },
  'a work area below the minimum is filled, never exceeded',
);
assert.deepEqual(
  fitWindowBounds({ x: 100, y: 50, width: 1200, height: 800 }, fullHd),
  { x: 100, y: 50, width: 1200, height: 800 },
  'a sensible remembered size is kept',
);
assert.deepEqual(
  fitWindowBounds({ x: 800, y: 300, width: 1200, height: 900 }, laptop),
  { x: 166, y: 0, width: 1200, height: 728 },
  'a remembered size larger than the display is clamped into its work area',
);
assert.deepEqual(
  fitWindowBounds({ x: 0, y: 0, width: 400, height: 300 }, fullHd),
  computeDefaultWindowBounds(fullHd),
  'a tiny remembered window restores to the proportional default',
);
assert.deepEqual(
  fitWindowBounds({ x: 0, y: 0, width: 1920, height: 1040 }, fullHd),
  computeDefaultWindowBounds(fullHd),
  'a near-maximized normal size restores to the proportional default',
);
assert.deepEqual(
  fitWindowBounds({ x: 100, y: 50, width: 1200, height: 800 }, rightMonitor),
  computeDefaultWindowBounds(rightMonitor),
  'bounds from another monitor restore centred on the current one',
);
assert.deepEqual(fitWindowBounds(null, fullHd), computeDefaultWindowBounds(fullHd));

const restoreWin = new FakeWindow() as FakeWindow & {
  bounds?: unknown;
  setBounds: (b: unknown) => void;
};
restoreWin.setBounds = (b) => {
  restoreWin.bounds = b;
  restoreWin.calls.push('setBounds');
};
const restoredBounds = computeDefaultWindowBounds(fullHd);
const restoreOptions = { canRestore: () => true, resolveRestoredBounds: () => restoredBounds };
applyWindowControlAction(restoreWin as any, 'toggle-maximize', restoreOptions);
assert.equal(restoreWin.bounds, undefined, 'maximizing does not resize');
applyWindowControlAction(restoreWin as any, 'toggle-maximize', restoreOptions);
assert.deepEqual(restoreWin.calls, ['maximize', 'unmaximize', 'setBounds']);
assert.deepEqual(restoreWin.bounds, restoredBounds, 'restore applies display-fitted bounds');

for (const bad of ['destroy', '', 'minimize ', 'MAXIMIZE', undefined, null, 42]) {
  assert.deepEqual(
    applyWindowControlAction(win as any, bad),
    { error: 'Unsupported window action' },
    `action ${String(bad)} must be rejected`,
  );
}
assert.deepEqual(
  win.calls,
  ['minimize', 'maximize', 'unmaximize', 'fullscreen:false', 'close'],
  'rejected actions must not touch the window',
);
const printPopup = localWindowOpenHandler({ url: 'about:blank' });
assert.equal(printPopup?.action, 'allow');
assert.deepEqual(printPopup?.overrideBrowserWindowOptions, {
  width: 800,
  height: 600,
  title: 'Print Receipt',
  autoHideMenuBar: true,
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
  },
});
assert.equal('titleBarStyle' in (printPopup?.overrideBrowserWindowOptions || {}), false);
assert.equal('titleBarOverlay' in (printPopup?.overrideBrowserWindowOptions || {}), false);
assert.equal('frame' in (printPopup?.overrideBrowserWindowOptions || {}), false);

const kitchenPopup = localWindowOpenHandler({ url: 'http://localhost:3001/kds' });
assert.equal(kitchenPopup?.action, 'allow');
assert.equal(kitchenPopup?.overrideBrowserWindowOptions.title, 'Flo - Kitchen Display');
assert.equal(kitchenPopup?.overrideBrowserWindowOptions.width, 1280);
assert.equal(kitchenPopup?.overrideBrowserWindowOptions.height, 800);

const kdsWindow = createKdsWindow(FakeBrowserWindow as any);
assert.equal(
  kdsWindow.options.webPreferences.preload,
  undefined,
  'KDS keeps the privileged preload bridge removed',
);
assert.equal(kdsWindow.options.webPreferences.contextIsolation, true);
assert.equal(kdsWindow.options.webPreferences.nodeIntegration, false);
assert.equal('titleBarStyle' in kdsWindow.options, false, 'KDS keeps stock window chrome');
assert.equal('titleBarOverlay' in kdsWindow.options, false, 'KDS keeps stock window chrome');
assert.equal('frame' in kdsWindow.options, false, 'KDS keeps stock window chrome');

console.log('Title-bar main-window options and popup/KDS exclusions are preserved.');

// ── Theme-following overlay colors (#458) ────────────────────────────────────

// The static constructor options use the light tokens.
assert.deepEqual(resolveTitleBarOverlayColors(false), TITLE_BAR_OVERLAY_COLORS.light);
assert.deepEqual(resolveTitleBarOverlayColors(true), TITLE_BAR_OVERLAY_COLORS.dark);
assert.deepEqual(TITLE_BAR_OVERLAY_COLORS.light, { color: '#ffffff', symbolColor: '#0a0a0a' });
assert.deepEqual(TITLE_BAR_OVERLAY_COLORS.dark, { color: '#0f0f0f', symbolColor: '#fafafa' });
assert.equal(TITLE_BAR_HEIGHT, 40);

// Platform gating: overlay updates only where setTitleBarOverlay works.
assert.equal(supportsTitleBarOverlay('darwin'), true);
assert.equal(supportsTitleBarOverlay('win32'), true);
assert.equal(supportsTitleBarOverlay('linux'), false);

function makeOverlaySpy(): { calls: unknown[]; win: unknown } {
  const calls: unknown[] = [];
  return {
    calls,
    win: {
      setTitleBarOverlay(options: unknown) {
        calls.push(options);
      },
    },
  };
}

const darkCall = makeOverlaySpy();
assert.equal(applyTitleBarOverlayTheme(darkCall.win, true, 'darwin'), true);
assert.deepEqual(darkCall.calls, [{ color: '#0f0f0f', symbolColor: '#fafafa', height: 40 }]);

const lightCall = makeOverlaySpy();
assert.equal(applyTitleBarOverlayTheme(lightCall.win, false, 'win32'), true);
assert.deepEqual(lightCall.calls, [{ color: '#ffffff', symbolColor: '#0a0a0a', height: 40 }]);

// Unsupported platform and missing/unusable API must no-op without throwing.
const linuxCall = makeOverlaySpy();
assert.equal(applyTitleBarOverlayTheme(linuxCall.win, true, 'linux'), false);
assert.equal(linuxCall.calls.length, 0);
assert.equal(applyTitleBarOverlayTheme({}, true, 'darwin'), false);
assert.equal(applyTitleBarOverlayTheme(null, true, 'win32'), false);
const throwingWin = {
  setTitleBarOverlay() {
    throw new Error('overlay rejected');
  },
};
assert.equal(
  applyTitleBarOverlayTheme(throwingWin, true, 'darwin'),
  false,
  'runtime rejection degrades to no-op',
);

// Theme sync wiring follows nativeTheme 'updated' events with live state.
function makeFakeNativeTheme(initialDark: boolean): {
  shouldUseDarkColors: boolean;
  listeners: Array<() => void>;
  emitUpdated(): void;
} {
  return {
    shouldUseDarkColors: initialDark,
    listeners: [],
    emitUpdated() {
      for (const listener of this.listeners) listener();
    },
    on(_event: string, listener: () => void) {
      this.listeners.push(listener);
      return this;
    },
    off(_event: string, listener: () => void) {
      this.listeners = this.listeners.filter((l) => l !== listener);
      return this;
    },
  } as any;
}

const syncTheme = makeFakeNativeTheme(false);
const synced = makeOverlaySpy();
const unsubscribe = attachTitleBarThemeSync(syncTheme, () => synced.win, 'darwin');
syncTheme.shouldUseDarkColors = true;
syncTheme.emitUpdated();
assert.deepEqual(synced.calls, [{ color: '#0f0f0f', symbolColor: '#fafafa', height: 40 }]);
syncTheme.shouldUseDarkColors = false;
syncTheme.emitUpdated();
assert.deepEqual(synced.calls[1], { color: '#ffffff', symbolColor: '#0a0a0a', height: 40 });
unsubscribe();
syncTheme.emitUpdated();
assert.equal(synced.calls.length, 2, 'unsubscribed listeners stop receiving updates');

// No listener is registered on unsupported platforms, and missing windows no-op.
const linuxTheme = makeFakeNativeTheme(true);
const linuxUnsubscribe = attachTitleBarThemeSync(linuxTheme, () => null, 'linux');
linuxUnsubscribe(); // must be safe even when nothing was subscribed
assert.equal(linuxTheme.listeners.length, 0, 'Linux does not subscribe to nativeTheme updates');
const missingWindowTheme = makeFakeNativeTheme(true);
attachTitleBarThemeSync(missingWindowTheme, () => null, 'darwin');
missingWindowTheme.emitUpdated(); // must not throw while the window is absent

console.log('Title-bar dynamic theme overlay resolution and platform guards pass.');
console.log(
  'Title-bar main-window options, fallback gating, and popup/KDS exclusions are preserved.',
);

// gh-513: theme-mode helpers
assert.equal(resolveThemeMode(undefined), 'system');
assert.equal(resolveThemeMode(null), 'system');
assert.equal(resolveThemeMode('bogus'), 'system');
assert.equal(resolveThemeMode('light'), 'light');
assert.equal(resolveThemeMode('dark'), 'dark');
assert.equal(resolveThemeMode('system'), 'system');
assert.equal(isThemeMode('light'), true);
assert.equal(isThemeMode('DARK'), false);
assert.equal(isThemeMode(42), false);
assert.equal(resolveInitialIsDark('dark', false), true);
assert.equal(resolveInitialIsDark('system', true), true);
assert.equal(resolveInitialIsDark('system', false), false);
assert.equal(resolveInitialIsDark('light', true), false);
assert.equal(
  appendThemeQueryParam('http://192.168.1.5:3002/kds', true),
  'http://192.168.1.5:3002/kds?theme=dark',
);
assert.equal(
  appendThemeQueryParam('http://192.168.1.5:3002/kds?table=3', false),
  'http://192.168.1.5:3002/kds?table=3&theme=light',
);
assert.equal(
  appendThemeQueryParam('http://192.168.1.5:3002/kds?theme=dark', false),
  'http://192.168.1.5:3002/kds?theme=light',
);
assert.equal(appendThemeQueryParam('not a url', true), 'not a url');
console.log('Theme-mode helpers (gh-513) resolve, validate, and rewrite URLs.');

// Small and 4:3 POS displays (e.g. 15" 1024x768) keep the window maximized.
const posiflex4by3 = { x: 0, y: 0, width: 1024, height: 728 };
const svga = { x: 0, y: 0, width: 800, height: 560 };
assert.equal(isCompactWorkArea(posiflex4by3), true, '1024x768 is too small for a windowed size');
assert.equal(isCompactWorkArea(svga), true, '800x600 is too small for a windowed size');
assert.equal(isCompactWorkArea(laptop), false, '1366x768 keeps a windowed size');
assert.equal(isCompactWorkArea(fullHd), false, '1920x1080 keeps a windowed size');
assert.deepEqual(resolveMinimumWindowSize(svga), { width: 800, height: 560 });
assert.deepEqual(resolveMinimumWindowSize(posiflex4by3), { width: 1024, height: 700 });
assert.deepEqual(resolveMinimumWindowSize(laptop), { width: 1024, height: 700 });
assert.deepEqual(resolveMinimumWindowSize(fullHd), { width: 1024, height: 700 });
for (const workArea of [posiflex4by3, svga]) {
  const bounds = computeDefaultWindowBounds(workArea);
  assert.ok(
    bounds.x >= workArea.x &&
      bounds.y >= workArea.y &&
      bounds.x + bounds.width <= workArea.x + workArea.width &&
      bounds.y + bounds.height <= workArea.y + workArea.height,
    'default bounds never overflow a small display',
  );
}

const compactWin = new FakeWindow();
compactWin.maximized = true;
assert.deepEqual(
  applyWindowControlAction(compactWin as any, 'toggle-maximize', {
    canRestore: () => !isCompactWorkArea(posiflex4by3),
    resolveRestoredBounds: () => computeDefaultWindowBounds(posiflex4by3),
  }),
  { success: true },
);
assert.equal(compactWin.maximized, true, 'shrink is a no-op on a compact display');
assert.deepEqual(compactWin.calls, []);

class SyncWindow {
  maximized = false;
  fullscreen = false;
  minimum: [number, number] | null = null;
  isDestroyed() {
    return false;
  }
  isMaximized() {
    return this.maximized;
  }
  isFullScreen() {
    return this.fullscreen;
  }
  maximize() {
    this.maximized = true;
  }
  setMinimumSize(width: number, height: number) {
    this.minimum = [width, height];
  }
}
const svgaWin = new SyncWindow();
syncMainWindowToDisplay(svgaWin as any, svga);
assert.deepEqual(svgaWin.minimum, [800, 560], 'minimum size clamps to an 800x600 display');
assert.equal(svgaWin.maximized, true, 'compact displays maximize the window');
const laptopWin = new SyncWindow();
syncMainWindowToDisplay(laptopWin as any, laptop);
assert.deepEqual(laptopWin.minimum, [1024, 700]);
assert.equal(laptopWin.maximized, false, '1366x768 leaves a windowed window alone');
const fullHdWin = new SyncWindow();
syncMainWindowToDisplay(fullHdWin as any, fullHd);
assert.equal(fullHdWin.maximized, false, '1920x1080 leaves a windowed window alone');
assert.deepEqual(getMainWindowState(svgaWin as any, svga), {
  isMaximized: true,
  isFullScreen: false,
  canRestore: false,
});
assert.equal(getMainWindowState(fullHdWin as any, fullHd).canRestore, true);
console.log('Main window stays maximized on compact displays and clamps its minimum size.');
