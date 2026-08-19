/**
 * @name SplitView
 * @author SplitView Contributors
 * @description Docked split-view for Discord — pin a Discord channel/thread alongside your main view.
 * @version 0.1.103
 * @source https://github.com/DylDigitals/Splitview-BD
 * @updateUrl https://raw.githubusercontent.com/DylDigitals/Splitview-BD/main/SplitView.plugin.js
 */

const PLUGIN_NAME = 'SplitView';
const PLUGIN_VERSION = '0.1.103';
const SETTINGS_KEY = 'settings';
const LOCAL_STORAGE_KEY = `${PLUGIN_NAME}:settings`;
const SESSION_ACTIVE_KEY = `${PLUGIN_NAME}:activeChannelId`;
const CRASH_LOG_KEY = `${PLUGIN_NAME}:crashLog`;
const MAX_CRASH_LOG_EVENTS = 160;
const DEFAULT_WIDTH = 480;
const MIN_WIDTH = 280;
const MIN_FLOATING_HEIGHT = 360;
const DEFAULT_FLOATING_RECT = { left: 96, top: 72, width: 520, height: 680 };

// Product contract: SplitView piggybacks on Discord's existing routing model.
// Primary target is real threads, but the context-menu affordance must also work
// from normal guild text/announcement channels because that is where users start.
// DMs, group DMs, forums, voice, and synthetic panes remain out of scope.
const SPLIT_TARGET_TYPES = new Set([0, 5, 10, 11, 12]);
const THREAD_TYPES = new Set([10, 11, 12]);

function normalizeFloatingRect(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    left: Number.isFinite(value.left) ? value.left : DEFAULT_FLOATING_RECT.left,
    top: Number.isFinite(value.top) ? value.top : DEFAULT_FLOATING_RECT.top,
    width: Number.isFinite(value.width) ? Math.max(MIN_WIDTH, value.width) : DEFAULT_FLOATING_RECT.width,
    height: Number.isFinite(value.height) ? Math.max(MIN_FLOATING_HEIGHT, value.height) : DEFAULT_FLOATING_RECT.height,
  };
}

function hasSavedFloatingRect(raw) {
  return !!raw && typeof raw === 'object' &&
    Number.isFinite(raw.left) && Number.isFinite(raw.top) &&
    Number.isFinite(raw.width) && Number.isFinite(raw.height);
}

module.exports = class SplitView {
  constructor() {
    this._settings = null;
    this._modules = {};
    this._unpatchers = [];
    this._splitChannelId = null;
    this._paneEl = null;
    this._paneTitle = null;
    this._paneBody = null;
    this._titlebarDragStrip = null;
    this._titlebarSyncRaf = null;
    this._resizing = false;
    this._resizeStartX = 0;
    this._resizeStartWidth = 0;
    this._floatingDragStart = null;
    this._floatingResizeStart = null;
    this._floatingSaveTimer = null;
    this._hasSavedFloatingRect = false;
    // Native render state
    this._renderMode = 'none'; // 'none' | 'placeholder' | 'native'
    this._reactRoot = null;    // createRoot handle or { _legacy, _el } sentinel
    this._SsvErrorBoundary = null; // lazily created fallback ErrorBoundary class
    this._layoutObserver = null;
    this._remountTimer = null;
    this._nativeRenderTimers = new Set();
    this._redockTimers = new Set();
    this._restoreTimer = null;
    this._restoreAttempt = 0;
    this._memberListTimer = null;
    this._scrollTimers = new Set();
    this._selectedChannelListener = null;
    this._lastMainChannelId = null;
    this._lastMainGuildId = null;
    this._contextChannelCache = new Map();
    this._breakouts = new Map();
    this._breakoutCounter = 0;
    this._dispatcher = null;
    this._onBreakoutMessage = null;
    this._origSidebarInput = null;
    this._debugAPI = null;
    this._crashLog = [];
    this._crashHandlers = null;
    this._allowDuplicateChannelForDiagnostics = false;
    this._nativeRenderVariant = 'sidebar';
    this._stopped = true;
  }

  // ─── Settings (width + debug only for MVP) ──────────────────────────────────

  _getBrowserStorage(kind) {
    try {
      const root = typeof window !== 'undefined' ? window : globalThis;
      const storage = root?.[kind];
      return storage && typeof storage.getItem === 'function' ? storage : null;
    } catch {
      return null;
    }
  }

  _getLocalStorage() {
    return this._getBrowserStorage('localStorage');
  }

  _getSessionStorage() {
    return this._getBrowserStorage('sessionStorage');
  }

  _readSavedSettings() {
    let saved = {};
    try { saved = BdApi.Data.load(PLUGIN_NAME, SETTINGS_KEY) ?? {}; } catch (e) { this._dbg('BdApi settings load failed:', e.message); }

    if (!hasSavedFloatingRect(saved.floatingRect)) {
      try {
        const local = this._getLocalStorage();
        const fallback = local ? JSON.parse(local.getItem(LOCAL_STORAGE_KEY) || '{}') : {};
        if (fallback && typeof fallback === 'object') saved = { ...fallback, ...saved, floatingRect: saved.floatingRect ?? fallback.floatingRect };
      } catch (e) {
        this._dbg('localStorage settings load failed:', e.message);
      }
    }

    return saved && typeof saved === 'object' ? saved : {};
  }

  _readSessionActiveSplit() {
    try {
      const session = this._getSessionStorage();
      const value = session?.getItem?.(SESSION_ACTIVE_KEY);
      return typeof value === 'string' && value.length > 0 ? value : null;
    } catch (e) {
      this._dbg('sessionStorage active split load failed:', e.message);
      return null;
    }
  }

  _writeSessionActiveSplit(channelId) {
    try {
      const session = this._getSessionStorage();
      if (!session) return;
      if (channelId) session.setItem(SESSION_ACTIVE_KEY, channelId);
      else session.removeItem(SESSION_ACTIVE_KEY);
    } catch (e) {
      this._dbg('sessionStorage active split save failed:', e.message);
    }
  }

  _serializeSettings() {
    return {
      currentWidth: this._settings.currentWidth,
      debug: this._settings.debug,
      // Active split targets are session-only: reload restores, full app restart does not.
      activeChannelId: null,
      paneMode: this._settings.paneMode === 'floating' ? 'floating' : 'docked',
      floatingRect: normalizeFloatingRect(this._settings.floatingRect),
    };
  }

  _loadSettings() {
    const saved = this._readSavedSettings();
    this._hasSavedFloatingRect = hasSavedFloatingRect(saved.floatingRect);
    return {
      currentWidth: typeof saved.currentWidth === 'number' ? saved.currentWidth : DEFAULT_WIDTH,
      debug: typeof saved.debug === 'boolean' ? saved.debug : false,
      activeChannelId: this._readSessionActiveSplit(),
      paneMode: saved.paneMode === 'floating' ? 'floating' : 'docked',
      floatingRect: normalizeFloatingRect(saved.floatingRect),
    };
  }

  _saveSettings() {
    const settings = this._serializeSettings();
    try { BdApi.Data.save(PLUGIN_NAME, SETTINGS_KEY, settings); } catch (e) { this._dbg('BdApi settings save failed:', e.message); }
    try { this._getLocalStorage()?.setItem?.(LOCAL_STORAGE_KEY, JSON.stringify(settings)); } catch (e) { this._dbg('localStorage settings save failed:', e.message); }
  }

  _scheduleFloatingRectSave() {
    if (this._floatingSaveTimer) return;
    this._floatingSaveTimer = window.setTimeout(() => {
      this._floatingSaveTimer = null;
      if (!this._stopped && this._settings?.paneMode === 'floating') this._persistFloatingRect(this._settings.floatingRect);
    }, 250);
  }

  // ─── Logging ─────────────────────────────────────────────────────────────────

  _log(...a) { console.log('[SplitView]', ...a); this._recordCrashEvent?.('log', { args: this._stringifyLogArgs(a) }); }
  _dbg(...a) { if (this._settings?.debug) console.log('[SplitView:dbg]', ...a); this._recordCrashEvent?.('debug', { args: this._stringifyLogArgs(a) }); }
  _err(...a) { console.error('[SplitView]', ...a); this._recordCrashEvent?.('error', { args: this._stringifyLogArgs(a) }); }

  _stringifyLogArgs(args) {
    return args.map(arg => {
      if (arg instanceof Error) return { name: arg.name, message: arg.message, stack: arg.stack };
      if (typeof arg === 'string' || typeof arg === 'number' || typeof arg === 'boolean' || arg == null) return arg;
      try { return JSON.parse(JSON.stringify(arg)); } catch { return String(arg); }
    });
  }

  _collectStatusSnapshot() {
    const modules = Object.fromEntries(
      Object.entries(this._modules || {}).map(([k, v]) => [k, v != null])
    );
    return {
      ts: new Date().toISOString(),
      pluginVersion: PLUGIN_VERSION,
      stopped: this._stopped,
      paneActive: !!this._paneEl,
      paneAttached: this._isPaneAttached?.() ?? false,
      splitChannelId: this._splitChannelId ?? null,
      activeChannelId: this._settings?.activeChannelId ?? null,
      selectedMainChannelId: this._getSelectedChannelId?.() ?? null,
      selectedMainGuildId: this._getSelectedGuildId?.() ?? null,
      splitGuildId: this._getChannelGuildId?.(this._splitChannelId) ?? null,
      renderMode: this._renderMode,
      nativeRenderVariant: this._nativeRenderVariant,
      paneMode: this._settings?.paneMode ?? 'docked',
      allowDuplicateChannelForDiagnostics: this._allowDuplicateChannelForDiagnostics,
      modules,
    };
  }

  _readCrashLog() {
    try {
      const parsed = JSON.parse(this._getLocalStorage()?.getItem?.(CRASH_LOG_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.slice(-MAX_CRASH_LOG_EVENTS) : [];
    } catch {
      return [];
    }
  }

  _persistCrashLog() {
    try { this._getLocalStorage()?.setItem?.(CRASH_LOG_KEY, JSON.stringify(this._crashLog.slice(-MAX_CRASH_LOG_EVENTS))); } catch { /* ignore */ }
  }

  _recordCrashEvent(type, detail = {}) {
    if (!this._crashLog) this._crashLog = this._readCrashLog();
    const event = {
      ts: new Date().toISOString(),
      type,
      detail,
      snapshot: this._collectStatusSnapshot?.() ?? null,
    };
    this._crashLog.push(event);
    if (this._crashLog.length > MAX_CRASH_LOG_EVENTS) this._crashLog = this._crashLog.slice(-MAX_CRASH_LOG_EVENTS);
    this._persistCrashLog();
    return event;
  }

  _installCrashDiagnostics() {
    if (this._crashHandlers) return;
    this._crashLog = this._readCrashLog();
    const onError = (event) => {
      this._recordCrashEvent('window-error', {
        message: event?.message,
        source: event?.filename,
        line: event?.lineno,
        column: event?.colno,
        error: event?.error ? this._stringifyLogArgs([event.error])[0] : null,
      });
    };
    const onUnhandledRejection = (event) => {
      this._recordCrashEvent('unhandled-rejection', {
        reason: this._stringifyLogArgs([event?.reason])[0],
      });
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    this._crashHandlers = { onError, onUnhandledRejection };
    this._recordCrashEvent('diagnostics-installed');
  }

  _removeCrashDiagnostics() {
    if (!this._crashHandlers) return;
    window.removeEventListener('error', this._crashHandlers.onError);
    window.removeEventListener('unhandledrejection', this._crashHandlers.onUnhandledRejection);
    this._crashHandlers = null;
    this._recordCrashEvent('diagnostics-removed');
  }

  _getCrashLog() {
    this._crashLog = this._readCrashLog();
    return {
      generatedAt: new Date().toISOString(),
      currentStatus: this._collectStatusSnapshot(),
      events: this._crashLog,
    };
  }

  _formatCrashLog() {
    return JSON.stringify(this._getCrashLog(), null, 2);
  }

  _toast(msg, type = 'info') {
    try { BdApi.UI?.showToast?.(`[SplitView] ${msg}`, { type }); } catch { /* ignore */ }
  }

  // ─── Module discovery ────────────────────────────────────────────────────────

  discoverModules() {
    const W = BdApi.Webpack;
    if (!W) {
      this._err('BdApi.Webpack unavailable — module discovery skipped');
      return {};
    }

    const F = W.Filters;
    const discovered = {};

    const tryGet = (name, fn) => {
      try {
        const result = fn();
        discovered[name] = result ?? null;
        this._dbg(`[${result != null ? '✓' : '✗'}] ${name}`);
      } catch (e) {
        discovered[name] = null;
        this._dbg(`[!] ${name}: ${e.message}`);
      }
    };

    // React / ReactDOM — prefer BdApi's direct accessors, fall back to webpack
    tryGet('React',    () => BdApi.React    ?? W.getModule(F.byKeys('createElement', 'useEffect', 'useRef')));
    tryGet('ReactDOM', () => BdApi.ReactDOM ?? W.getModule(F.byKeys('createRoot', 'render', 'unmountComponentAtNode')));

    // Discord's ErrorBoundary (optional — we create a fallback if absent)
    tryGet('ErrorBoundary', () => W.getModule(m =>
      typeof m === 'function' &&
      m.prototype?.componentDidCatch != null &&
      typeof m.prototype?.render === 'function'
    ));

    // Stores — BD exposes these directly
    tryGet('ChannelStore',         () => W.getStore?.('ChannelStore'));
    tryGet('GuildStore',           () => W.getStore?.('GuildStore'));
    tryGet('SelectedChannelStore', () => W.getStore?.('SelectedChannelStore'));
    tryGet('UserStore',            () => W.getStore?.('UserStore'));

    // Action modules
    tryGet('ChatInputTypes',    () => W.getModule(F.byKeys('FORM', 'SIDEBAR'), { searchExports: true }));
    tryGet('NavigationUtils',   () => W.getModule(m => typeof m?.transitionTo === 'function' && typeof m?.replaceWith === 'function'));
    tryGet('ChannelActions',    () => W.getModule(F.byKeys('selectChannel', 'selectPrivateChannel')));

    // Patch targets
    tryGet('ThreadGuardModule', () => W.getWithKey?.(F.byStrings('Thread must have a parent ID')));

    // Internal chat component used by Discord sidebar-style chat surfaces
    tryGet('SplitViewComponent', () => W.getModule(e =>
      e?.$$typeof?.toString?.() === 'Symbol(react.memo)' &&
      /chatInputType/.test(e.type?.toString?.()) &&
      /filterAfterTimestamp/.test(e.type?.toString?.())
    ));

    const headerLike = (m) => typeof m === 'function' && m.Icon && m.Title && m.Divider && m.Caret;

    // MiniChat-style external popout modules. These are optional: SplitView stays
    // stable when any of them are missing, while Breakout Chat reports diagnostics.
    tryGet('PopoutActions', () => W.getModule(F.byKeys('open', 'close', 'setAlwaysOnTop')));
    tryGet('PopoutWindow', () => W.getModule(e => {
      try {
        const s = e?.render?.toString?.() || '';
        return s.includes('guestWindow') && s.includes('windowKey');
      } catch { return false; }
    }));
    tryGet('PopoutWindowStore', () => W.getStore?.('PopoutWindowStore'));
    tryGet('Native', () => W.getModule(m => m?.setAlwaysOnTop?.toString?.()?.includes?.('window.setAlwaysOnTop')));
    tryGet('Header', () => W.getModule(m => headerLike(m) && m.toString?.().includes('isAuthenticated')));
    tryGet('Bar', () => W.getModule(m => headerLike(m) && !m.toString?.().includes('isAuthenticated')));
    tryGet('IconUtils', () => W.getModule(F.byKeys('getGuildIconURL')));
    tryGet('AckActions', () => W.getModule(F.byKeys('ack')));
    tryGet('UserGuildSettingsStore', () => W.getStore?.('UserGuildSettingsStore'));

    this._modules = discovered;

    const found = Object.values(discovered).filter(v => v != null).length;
    const total = Object.keys(discovered).length;
    this._log(`Module discovery: ${found}/${total} found`);
    if (this._settings?.debug) {
      console.table(
        Object.fromEntries(Object.entries(discovered).map(([k, v]) => [k, v != null ? '✓' : '✗']))
      );
    }

    return discovered;
  }

  // ─── CSS ─────────────────────────────────────────────────────────────────────

  installStyles() {
    const w = this._settings.currentWidth;
    BdApi.DOM.addStyle(PLUGIN_NAME, `
      :root { --ssv-split-width: ${w}px; }

      .ssv-pane {
        display: flex;
        flex-direction: row;
        width: var(--ssv-split-width);
        min-width: ${MIN_WIDTH}px;
        max-width: 80vw;
        flex: 0 0 auto;
        position: relative;
        background: var(--background-primary, #313338);
        border-left: 1px solid var(--background-modifier-accent, #3f4147);
        overflow: hidden;
      }



      .ssv-pane.ssv-floating {
        position: fixed;
        z-index: 10000;
        min-height: ${MIN_FLOATING_HEIGHT}px;
        max-width: calc(100vw - 24px);
        max-height: calc(100vh - 24px);
        border: 1px solid var(--background-modifier-accent, #3f4147);
        border-radius: 8px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
      }

      .ssv-pane.ssv-floating .ssv-pane-header {
        cursor: grab;
      }

      .ssv-pane.ssv-floating.ssv-floating-dragging .ssv-pane-header {
        cursor: grabbing;
      }

      .ssv-breakout-root {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        background: var(--background-primary, #313338);
      }

      .ssv-breakout-root > * {
        min-width: 0;
        min-height: 0;
      }

      .ssv-breakout-header {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 10px;
        min-height: 44px;
        padding: 0 10px 0 14px;
        border-bottom: 1px solid var(--background-modifier-accent, rgba(255,255,255,0.08));
        background: var(--background-secondary, #2b2d31);
        color: var(--header-primary, #f2f3f5);
        font: 600 14px/1.2 var(--font-primary, sans-serif);
        user-select: none;
      }

      .ssv-breakout-title-stack {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .ssv-breakout-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .ssv-breakout-subtitle {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-muted, #949ba4);
        font-size: 11px;
        font-weight: 500;
      }

      .ssv-breakout-close {
        flex: 0 0 auto;
        width: 28px;
        height: 28px;
        border: 0;
        border-radius: 6px;
        color: var(--interactive-normal, #b5bac1);
        background: transparent;
        font: 18px/1 var(--font-primary, sans-serif);
        cursor: pointer;
      }

      .ssv-breakout-close:hover {
        color: var(--interactive-hover, #dbdee1);
        background: var(--background-modifier-hover, rgba(255,255,255,0.08));
      }

      .ssv-breakout-body {
        flex: 1;
        display: flex;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
      }

      .ssv-breakout-body > * {
        flex: 1 1 auto;
        min-width: 0;
        min-height: 0;
        width: 100%;
      }

      .ssv-breakout-diagnostic {
        padding: 16px;
        color: var(--text-normal, #dbdee1);
        font: 13px/1.4 var(--font-primary, sans-serif);
        white-space: pre-wrap;
      }

      .ssv-titlebar-drag-strip {
        position: fixed;
        top: 0;
        height: 32px;
        z-index: 999;
        pointer-events: auto;
        -webkit-app-region: drag;
        app-region: drag;
        background: transparent;
      }

      .ssv-titlebar-drag-strip[hidden] {
        display: none !important;
      }

      .ssv-titlebar-drag-strip.ssv-titlebar-probe {
        background: color-mix(in srgb, var(--brand-experiment, #5865f2) 18%, transparent);
        outline: 1px dashed color-mix(in srgb, var(--brand-experiment, #5865f2) 70%, transparent);
      }

      .ssv-floating-resize-corner {
        display: none;
      }

      .ssv-pane.ssv-floating .ssv-floating-resize-corner {
        display: block;
        position: absolute;
        right: 0;
        bottom: 0;
        width: 16px;
        height: 16px;
        cursor: nwse-resize;
        z-index: 11;
        background: linear-gradient(135deg, transparent 50%, var(--interactive-muted, #6d6f78) 50%);
        opacity: 0.65;
      }

      .ssv-pane.ssv-floating .ssv-floating-resize-corner:hover,
      .ssv-pane.ssv-floating.ssv-floating-resizing .ssv-floating-resize-corner {
        opacity: 1;
      }

      .ssv-resize-handle {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 4px;
        cursor: ew-resize;
        z-index: 10;
        background: transparent;
        transition: background 0.15s;
      }

      .ssv-resize-handle:hover,
      .ssv-resize-handle.ssv-resizing {
        background: var(--brand-experiment, #5865f2);
      }

      .ssv-pane.ssv-floating > .ssv-resize-handle {
        display: none;
      }

      .ssv-pane-inner {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        margin-left: 4px;
      }

      .ssv-pane-header {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 0 8px;
        height: 48px;
        flex: 0 0 auto;
        background: var(--background-primary, #313338);
        border-bottom: 1px solid var(--background-modifier-accent, #3f4147);
      }

      .ssv-pane-header-title {
        flex: 1;
        font-size: 15px;
        font-weight: 600;
        color: var(--header-primary, #f2f3f5);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .ssv-pane-header-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: none;
        background: transparent;
        color: var(--interactive-normal, #b5bac1);
        cursor: pointer;
        border-radius: 4px;
        font-size: 18px;
        flex: 0 0 auto;
        padding: 0;
        line-height: 1;
      }

      .ssv-pane-header-btn:hover {
        color: var(--interactive-hover, #dcddde);
        background: var(--background-modifier-hover, rgba(79,84,92,0.16));
      }

      .ssv-pane-body {
        flex: 1;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        justify-content: stretch;
        min-width: 0;
        min-height: 0;
        gap: 0;
        color: var(--text-muted, #949ba4);
        font-size: 13px;
      }

      .ssv-pane-body.ssv-placeholder {
        align-items: center;
        justify-content: center;
      }

      .ssv-pane-body.ssv-native > * {
        flex: 1 1 auto;
        width: 100%;
        min-width: 0;
        min-height: 0;
      }

      .ssv-pane-body.ssv-native,
      .ssv-pane-body.ssv-native :is([class*="chat"], [class*="chatContent"], [class*="messagesWrapper"], [class*="scroller"], [class*="form"], [role="log"]) {
        max-width: none !important;
        width: 100% !important;
        min-width: 0 !important;
        box-sizing: border-box;
      }

      .ssv-pane-body.ssv-native :is([class*="chat"], [class*="chatContent"], [class*="messagesWrapper"]) {
        flex: 1 1 auto;
        align-self: stretch;
      }

      .ssv-pane.ssv-duplicate-main-channel .ssv-pane-body.ssv-native :is(
        [class*="channelTextArea"],
        [class*="typing"]
      ) {
        visibility: hidden !important;
        pointer-events: none !important;
      }

      .ssv-pane.ssv-duplicate-main-channel .ssv-pane-body.ssv-native :is(
        [class*="channelTextArea"],
        [class*="typing"]
      ) * {
        pointer-events: none !important;
      }

      .ssv-pane.ssv-duplicate-main-channel .ssv-pane-body {
        position: relative;
      }

      .ssv-pane.ssv-duplicate-main-channel .ssv-pane-body::after {
        content: 'Same channel — SplitView keeps its own scroll; send from the focused main composer';
        position: absolute;
        left: 12px;
        right: 12px;
        bottom: 12px;
        padding: 6px 9px;
        border-radius: 6px;
        background: color-mix(in srgb, var(--background-floating, #111214) 88%, transparent);
        color: var(--text-muted, #949ba4);
        font-size: 11px;
        line-height: 1.3;
        text-align: center;
        pointer-events: none;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
        z-index: 20;
        opacity: 0.72;
      }

      .ssv-pane.ssv-native-composerless .ssv-pane-body.ssv-native :is(
        [class*="channelTextArea"],
        [class*="typing"],
        form[class*="form"]
      ) {
        display: none !important;
        pointer-events: none !important;
      }

      .ssv-pane.ssv-native-composerless .ssv-pane-body {
        position: relative;
      }

      .ssv-pane.ssv-native-composerless .ssv-pane-body::after {
        content: 'Composerless fallback active; writable sidebar mode is the default in v${PLUGIN_VERSION}';
        position: absolute;
        left: 12px;
        right: 12px;
        bottom: 12px;
        padding: 6px 9px;
        border-radius: 6px;
        background: color-mix(in srgb, var(--background-floating, #111214) 88%, transparent);
        color: var(--text-muted, #949ba4);
        font-size: 11px;
        line-height: 1.3;
        text-align: center;
        pointer-events: none;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
        z-index: 20;
        opacity: 0.72;
      }

      .ssv-placeholder-icon {
        font-size: 32px;
        opacity: 0.4;
      }

      .ssv-placeholder-heading {
        font-size: 14px;
        font-weight: 600;
        color: var(--header-secondary, #b5bac1);
      }

      .ssv-placeholder-detail {
        text-align: center;
        line-height: 1.5;
        white-space: pre-line;
        max-width: 220px;
      }

      .ssv-placeholder-diagnostic {
        font-family: monospace;
        font-size: 11px;
        opacity: 0.7;
        margin-top: 8px;
      }

      body.ssv-resizing,
      body.ssv-resizing *,
      body.ssv-floating-resizing,
      body.ssv-floating-resizing * {
        user-select: none !important;
      }

      body.ssv-resizing,
      body.ssv-resizing * {
        cursor: ew-resize !important;
      }

      body.ssv-floating-resizing,
      body.ssv-floating-resizing * {
        cursor: nwse-resize !important;
      }
    `);
  }

  removeStyles() {
    BdApi.DOM.removeStyle(PLUGIN_NAME);
  }

  // ─── Layout container ────────────────────────────────────────────────────────

  _queryMainDiscordElement(selectors) {
    for (const selector of selectors) {
      const matches = Array.from(document.querySelectorAll(selector));
      const match = matches.find(el => !el.closest('[data-ssv="pane"]'));
      if (match) return match;
    }
    return null;
  }

  _findLayoutContainer() {
    // Discord uses hashed classnames and inserts its native thread/sidebar pane
    // beside the main chat. Do not stop at the first chat ancestor: when a native
    // thread preview opens there can be multiple chat surfaces. Score all row
    // ancestors and choose the widest app-row so SplitView becomes the rightmost
    // third instead of being trapped between the main chat and Discord's thread.
    const anchors = [];
    for (const selector of [
      '[class*="chatContent"]',
      '[class*="chat-"][class*="content"]',
      '[class*="messagesWrapper"]',
    ]) {
      try {
        document.querySelectorAll(selector).forEach(el => {
          if (!el.closest('[data-ssv="pane"]')) anchors.push(el);
        });
      } catch { /* selector unsupported */ }
    }

    const candidates = new Map();
    for (const anchor of anchors) {
      let node = anchor?.parentElement;
      while (node && node !== document.body) {
        try {
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          if (style.display.includes('flex') && style.flexDirection === 'row' && rect.width > 500 && rect.height > 300) {
            const children = Array.from(node.children ?? []);
            const containsPane = this._paneEl && node.contains(this._paneEl);
            const score = (rect.width * 2) + rect.height + (children.length * 120) + (containsPane ? 400 : 0);
            const previous = candidates.get(node) ?? 0;
            candidates.set(node, Math.max(previous, score));
          }
        } catch { /* stale node during Discord route changes */ }
        node = node.parentElement;
      }
    }

    const best = Array.from(candidates.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    if (best && best !== document.body && best !== document.documentElement) {
      this._dbg('Layout container:', best.tagName, String(best.className).split(' ')[0]);
      return best;
    }

    this._err('Layout container not found — refusing to mount instead of falling back to document.body');
    return null;
  }

  _applyDockedLayout(container = null) {
    if (this._settings?.paneMode === 'floating' || !this._paneEl) return;
    const row = container && container !== document.body ? container : this._paneEl.parentElement;
    const chatSurfaceCount = row ? Array.from(row.querySelectorAll?.('[class*="chatContent"], [class*="chat-"][class*="content"]') ?? [])
      .filter(el => el instanceof HTMLElement && !el.closest('[data-ssv="pane"]')).length : 0;
    const baseWidth = this._settings.currentWidth;
    const thirdWidth = row?.clientWidth ? Math.floor(row.clientWidth / 3) : baseWidth;
    // When Discord has its own thread/sidebar open, cap SplitView to one third
    // of the row. This preserves the native layout: main channel | thread preview | SplitView.
    const nextWidth = chatSurfaceCount >= 2 ? Math.max(MIN_WIDTH, Math.min(baseWidth, thirdWidth)) : baseWidth;
    this._applyWidth(nextWidth);
    this._scheduleTitlebarDragStripSync('docked-layout');
  }

  _scheduleDockedRight(reason = 'layout-check') {
    if (!this._splitChannelId || this._settings?.paneMode === 'floating') return;
    if (this._redockTimers.size > 0) return;
    for (const delay of [40, 140, 320, 700]) {
      const timer = window.setTimeout(() => {
        this._redockTimers.delete(timer);
        if (!this._stopped) this._ensurePaneDockedRight(`${reason}+${delay}ms`);
      }, delay);
      this._redockTimers.add(timer);
    }
  }

  _ensurePaneDockedRight(reason = 'layout-check') {
    if (!this._splitChannelId || !this._paneEl || !document.body.contains(this._paneEl)) return false;
    if (this._settings?.paneMode === 'floating') return false;

    const container = this._findLayoutContainer();
    if (!container || container === document.body) return false;

    const isWrongParent = this._paneEl.parentElement !== container;
    const isNotRightmost = this._paneEl.nextElementSibling !== null;
    if (!isWrongParent && !isNotRightmost) {
      this._applyDockedLayout(container);
      return false;
    }

    // Discord may insert the native thread preview/sidebar after our pane during
    // navigation. Move the existing pane back to the end of the current chat row
    // instead of destroying/remounting React; this preserves the split target and
    // keeps the layout stable as main channel | thread preview | SplitView.
    container.appendChild(this._paneEl);
    document.body.classList.add('ssv-active');
    this._applyDockedLayout(container);
    this._scheduleTitlebarDragStripSync(`redock:${reason}`);
    this._dbg(`Re-docked split pane to the right after ${reason}`);
    this._scheduleScrollToBottom('both', `${reason}:redock`);
    return true;
  }

  // ─── Discord titlebar drag continuation ──────────────────────────────────────

  _getDiscordTitlebarRect() {
    const candidates = Array.from(document.querySelectorAll('[class*="bar_"]'))
      .filter(el => el instanceof HTMLElement && !el.closest('[data-ssv="pane"]'))
      .map(el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return { el, rect, style };
      })
      .filter(({ rect, style }) => rect.y <= 2 && rect.height >= 24 && rect.height <= 40 && rect.width > 300 && style.webkitAppRegion === 'drag')
      .sort((a, b) => b.rect.width - a.rect.width);

    return candidates[0]?.rect ?? null;
  }

  _ensureTitlebarDragStrip() {
    if (this._titlebarDragStrip && document.body.contains(this._titlebarDragStrip)) return this._titlebarDragStrip;
    const strip = document.createElement('div');
    strip.className = 'ssv-titlebar-drag-strip';
    strip.setAttribute('data-ssv', 'titlebar-drag-strip');
    strip.setAttribute('aria-hidden', 'true');
    strip.title = 'SplitView titlebar drag continuation';
    document.body.appendChild(strip);
    this._titlebarDragStrip = strip;
    return strip;
  }

  _removeTitlebarDragStrip() {
    if (this._titlebarSyncRaf) {
      window.cancelAnimationFrame(this._titlebarSyncRaf);
      this._titlebarSyncRaf = null;
    }
    this._titlebarDragStrip?.remove?.();
    this._titlebarDragStrip = null;
  }

  _scheduleTitlebarDragStripSync(reason = 'sync') {
    if (this._titlebarSyncRaf) return;
    this._titlebarSyncRaf = window.requestAnimationFrame(() => {
      this._titlebarSyncRaf = null;
      this._syncTitlebarDragStrip(reason);
    });
  }

  _syncTitlebarDragStrip(reason = 'sync') {
    if (this._stopped || this._settings?.paneMode === 'floating' || !this._paneEl || !document.body.contains(this._paneEl)) {
      this._removeTitlebarDragStrip();
      return null;
    }

    const titlebarRect = this._getDiscordTitlebarRect();
    const paneRect = this._paneEl.getBoundingClientRect();
    const reservedRight = 160; // keep Discord update/min/max/close controls clickable.
    const left = Math.max(0, Math.round(paneRect.left));
    const right = Math.min(Math.round(paneRect.right), Math.max(0, window.innerWidth - reservedRight));
    const width = Math.max(0, right - left);
    const height = Math.max(24, Math.min(40, Math.round(titlebarRect?.height || 32)));

    if (!titlebarRect || width < 24) {
      this._titlebarDragStrip?.setAttribute('hidden', 'true');
      return { visible: false, reason, titlebarFound: !!titlebarRect, left, right, width, height };
    }

    const strip = this._ensureTitlebarDragStrip();
    strip.hidden = false;
    strip.style.left = `${left}px`;
    strip.style.width = `${width}px`;
    strip.style.height = `${height}px`;
    strip.style.top = `${Math.max(0, Math.round(titlebarRect.y))}px`;

    const result = { visible: true, reason, left, right, width, height, reservedRight, titlebarClass: titlebarRect ? 'detected' : null };
    this._dbg('Titlebar drag strip synced:', result);
    return result;
  }

  _inspectTitlebarDragStrip() {
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName,
        cls: String(el.className || '').slice(0, 220),
        aria: el.getAttribute?.('aria-label'),
        role: el.getAttribute?.('role'),
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        display: cs.display,
        position: cs.position,
        zIndex: cs.zIndex,
        pointerEvents: cs.pointerEvents,
        appRegion: cs.webkitAppRegion,
      };
    };
    const titlebarRect = this._getDiscordTitlebarRect();
    const sync = this._syncTitlebarDragStrip('debug-inspect');
    const stripRect = this._titlebarDragStrip?.getBoundingClientRect?.();
    const hitPoints = stripRect ? [
      [stripRect.left + 8, stripRect.top + 8],
      [stripRect.left + Math.max(12, stripRect.width / 2), stripRect.top + 8],
      [stripRect.right - 8, stripRect.top + 8],
    ].map(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return { x: Math.round(x), y: Math.round(y), hit: rect(hit), isStrip: hit === this._titlebarDragStrip };
    }) : [];
    const result = {
      status: this._collectStatusSnapshot(),
      titlebar: titlebarRect ? { x: Math.round(titlebarRect.x), y: Math.round(titlebarRect.y), w: Math.round(titlebarRect.width), h: Math.round(titlebarRect.height) } : null,
      pane: rect(this._paneEl),
      strip: rect(this._titlebarDragStrip),
      sync,
      hitPoints,
    };
    console.log('[SplitView] Titlebar drag strip:', result);
    return result;
  }

  _setTitlebarDragStripProbe(enabled) {
    const sync = this._syncTitlebarDragStrip('debug-probe');
    if (this._titlebarDragStrip) this._titlebarDragStrip.classList.toggle('ssv-titlebar-probe', !!enabled);
    return { probe: !!enabled, sync };
  }

  // ─── Scroll stabilization ────────────────────────────────────────────────────

  _getMainChatScope() {
    return this._queryMainDiscordElement([
      '[class*="chatContent"]',
      '[class*="chat-"][class*="content"]',
    ]);
  }

  _findScrollableMessages(scope) {
    if (!scope) return [];

    const selectors = [
      '[data-list-id*="chat-messages"]',
      '[class*="messagesWrapper"] [class*="scroller"]',
      '[class*="chatContent"] [class*="scroller"]',
      '[class*="scrollerInner"]',
      '[role="log"]',
    ];

    const candidates = new Set([scope]);
    for (const selector of selectors) {
      try {
        scope.querySelectorAll(selector).forEach(el => {
          candidates.add(el);
          if (el.parentElement) candidates.add(el.parentElement);
        });
      } catch { /* selector unsupported in this Discord build */ }
    }

    return Array.from(candidates).filter(el => {
      if (!el || !(el instanceof HTMLElement)) return false;
      if (!scope.contains(el) && el !== scope) return false;
      if (scope !== this._paneBody && el.closest('[data-ssv="pane"]')) return false;
      const style = getComputedStyle(el);
      const canScroll = /(auto|scroll)/.test(style.overflowY) || el.scrollHeight > el.clientHeight;
      return canScroll && el.scrollHeight > el.clientHeight + 8;
    });
  }

  _scrollScopeToBottom(scope, reason) {
    const scrollers = this._findScrollableMessages(scope);
    for (const el of scrollers) {
      try {
        el.scrollTop = el.scrollHeight;
        el.lastElementChild?.scrollIntoView?.({ block: 'end', inline: 'nearest' });
      } catch { /* ignore stale DOM during Discord route changes */ }
    }
    if (scrollers.length) this._dbg(`Scrolled ${scrollers.length} message scroller(s) to bottom after ${reason}`);
    return scrollers.length;
  }

  _scrollToBottom(target = 'both', reason = 'navigation') {
    if (target === 'main' || target === 'both') this._scrollScopeToBottom(this._getMainChatScope(), `${reason}:main`);
    if ((target === 'split' || target === 'both') && this._paneBody) this._scrollScopeToBottom(this._paneBody, `${reason}:split`);
  }

  _scheduleScrollToBottom(target = 'both', reason = 'navigation') {
    // Discord restores/render-loads messages asynchronously. Run a short series
    // of bottom-scroll attempts so both the default chat and the split pane land
    // on the most recent messages after tab/channel switches.
    for (const delay of [60, 180, 420, 900]) {
      const timer = window.setTimeout(() => {
        this._scrollTimers.delete(timer);
        if (!this._stopped) this._scrollToBottom(target, reason);
      }, delay);
      this._scrollTimers.add(timer);
    }
  }

  // ─── Pane DOM ────────────────────────────────────────────────────────────────

  createDockedPane() {
    if (this._paneEl) return this._paneEl;

    const floating = this._settings?.paneMode === 'floating';
    const container = floating ? document.body : this._findLayoutContainer();
    if (!container) {
      this._err('Cannot create SplitView pane: safe layout container not found');
      this._toast('SplitView could not find a safe Discord chat row to mount into', 'error');
      return null;
    }

    const pane = document.createElement('div');
    pane.className = floating ? 'ssv-pane ssv-floating' : 'ssv-pane';
    pane.setAttribute('data-ssv', 'pane');

    // Resize handle on the left edge
    const handle = document.createElement('div');
    handle.className = 'ssv-resize-handle';
    handle.setAttribute('aria-hidden', 'true');
    handle.addEventListener('mousedown', this._onResizeStart);

    const floatingResizeCorner = document.createElement('div');
    floatingResizeCorner.className = 'ssv-floating-resize-corner';
    floatingResizeCorner.setAttribute('aria-hidden', 'true');
    floatingResizeCorner.addEventListener('mousedown', this._onFloatingResizeStart);

    // Inner flex column
    const inner = document.createElement('div');
    inner.className = 'ssv-pane-inner';

    // Header row
    const header = document.createElement('div');
    header.className = 'ssv-pane-header';

    const modeBtn = document.createElement('button');
    modeBtn.className = 'ssv-pane-header-btn';
    modeBtn.title = 'Open MiniChat-style Breakout window';
    modeBtn.setAttribute('aria-label', 'Open MiniChat-style Breakout window');
    modeBtn.textContent = '↗';
    modeBtn.addEventListener('click', () => this.openBreakout(this._splitChannelId || this._settings?.activeChannelId));

    const title = document.createElement('span');
    title.className = 'ssv-pane-header-title';
    title.textContent = 'Split View';
    this._paneTitle = title;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ssv-pane-header-btn';
    closeBtn.title = 'Close split view';
    closeBtn.setAttribute('aria-label', 'Close split view');
    closeBtn.textContent = '×'; // ×
    closeBtn.addEventListener('click', () => this.close());

    header.addEventListener('mousedown', this._onFloatingDragStart);
    header.append(modeBtn, title, closeBtn);

    // Body — placeholder until native Discord chat mounts
    const body = document.createElement('div');
    body.className = 'ssv-pane-body ssv-placeholder';
    this._paneBody = body;
    this._renderPlaceholder('No split target selected', 'Right-click a channel or thread and choose\n"Open in Split View"');

    inner.append(header, body);
    pane.append(handle, inner, floatingResizeCorner);
    container.appendChild(pane);

    this._paneEl = pane;
    document.body.classList.add('ssv-active');
    this._applyPanePlacement();
    this._scheduleTitlebarDragStripSync('pane-created');

    this._log('Pane created');
    return pane;
  }

  destroyDockedPane() {
    if (!this._paneEl) return;

    // Unmount any React root before removing the DOM node
    this._unmountReactRoot();

    // Clean up any in-progress resize to avoid listener leaks
    if (this._resizing) {
      this._resizing = false;
      document.body.classList.remove('ssv-resizing');
      document.removeEventListener('mousemove', this._onResizeMove);
      document.removeEventListener('mouseup', this._onResizeEnd);
      window.removeEventListener('blur', this._cancelResize);
    }

    const handle = this._paneEl.querySelector('.ssv-resize-handle');
    if (handle) handle.removeEventListener('mousedown', this._onResizeStart);
    const floatingResizeCorner = this._paneEl.querySelector('.ssv-floating-resize-corner');
    if (floatingResizeCorner) floatingResizeCorner.removeEventListener('mousedown', this._onFloatingResizeStart);
    const header = this._paneEl.querySelector('.ssv-pane-header');
    if (header) header.removeEventListener('mousedown', this._onFloatingDragStart);
    this._cancelFloatingDrag();
    this._cancelFloatingResize();
    this._removeTitlebarDragStrip();

    this._paneEl.remove();
    this._paneEl = null;
    this._paneTitle = null;
    this._paneBody = null;
    document.body.classList.remove('ssv-active');

    this._log('Pane destroyed');
  }

  _scheduleRemount(reason = 'layout-change', force = false) {
    if (!this._splitChannelId) return;
    if (this._remountTimer) window.clearTimeout(this._remountTimer);

    this._remountTimer = window.setTimeout(() => {
      this._remountTimer = null;
      const channelId = this._splitChannelId;
      if (!channelId) return;

      const paneMissing = !this._paneEl || !document.body.contains(this._paneEl);
      if (!paneMissing) {
        this._ensurePaneDockedRight(reason);
        if (!force) return;
      }

      this._dbg(`Remounting split pane after ${reason}: ${channelId}`);
      this.destroyDockedPane();
      this.open(channelId);
      this._scheduleScrollToBottom('both', `${reason}:remount`);
    }, 150);
  }

  _installLayoutPersistence() {
    if (this._layoutObserver || typeof MutationObserver !== 'function') return;

    this._layoutObserver = new MutationObserver(() => {
      if (!this._splitChannelId) return;
      if (!this._paneEl || !document.body.contains(this._paneEl)) {
        this._scheduleRemount('discord-navigation');
      } else {
        this._scheduleDockedRight('discord-navigation');
      }
    });

    this._layoutObserver.observe(document.body, { childList: true, subtree: true });
    this._dbg('Layout persistence observer installed');
  }

  _removeLayoutPersistence() {
    if (this._remountTimer) {
      window.clearTimeout(this._remountTimer);
      this._remountTimer = null;
    }
    for (const timer of this._redockTimers) window.clearTimeout(timer);
    this._redockTimers.clear();
    this._layoutObserver?.disconnect?.();
    this._layoutObserver = null;
    this._removeTitlebarDragStrip();
  }

  _clearDeferredTimers() {
    if (this._restoreTimer) {
      window.clearTimeout(this._restoreTimer);
      this._restoreTimer = null;
      this._restoreAttempt = 0;
    }
    if (this._memberListTimer) {
      window.clearTimeout(this._memberListTimer);
      this._memberListTimer = null;
    }
    for (const timer of this._redockTimers) window.clearTimeout(timer);
    this._redockTimers.clear();
    for (const timer of this._nativeRenderTimers) window.clearTimeout(timer);
    this._nativeRenderTimers.clear();
    if (this._floatingSaveTimer) {
      window.clearTimeout(this._floatingSaveTimer);
      this._floatingSaveTimer = null;
    }
    for (const timer of this._scrollTimers) window.clearTimeout(timer);
    this._scrollTimers.clear();
    if (this._titlebarSyncRaf) {
      window.cancelAnimationFrame(this._titlebarSyncRaf);
      this._titlebarSyncRaf = null;
    }
  }

  _getSelectedChannelId() {
    const store = this._modules.SelectedChannelStore;
    try {
      return store?.getChannelId?.() ?? store?.getVoiceChannelId?.() ?? null;
    } catch {
      return null;
    }
  }

  _cacheChannelSnapshot(channel) {
    if (!channel?.id) return null;
    this._contextChannelCache.set(channel.id, channel);
    return channel;
  }

  _getChannel(channelOrId) {
    if (!channelOrId) return null;
    if (typeof channelOrId === 'object') return this._cacheChannelSnapshot(channelOrId);
    return this._modules.ChannelStore?.getChannel?.(channelOrId)
      ?? this._contextChannelCache.get(channelOrId)
      ?? null;
  }

  _getChannelGuildId(channelOrId) {
    const channel = this._getChannel(channelOrId);
    if (!channel) return null;
    if (channel.guild_id) return channel.guild_id;
    if (channel.parent_id) return this._getChannel(channel.parent_id)?.guild_id ?? null;
    return null;
  }

  _getSelectedGuildId(selectedChannelId = this._getSelectedChannelId()) {
    const store = this._modules.SelectedChannelStore;
    try {
      const direct = store?.getGuildId?.() ?? store?.getLastSelectedGuildId?.() ?? null;
      if (direct) return direct;
    } catch { /* fall through to selected channel lookup */ }
    return selectedChannelId ? this._getChannelGuildId(selectedChannelId) : null;
  }

  _closeForGuildChange(previousGuildId, nextGuildId) {
    if (!this._splitChannelId && !this._settings?.activeChannelId) return;
    this._dbg('Closing SplitView after guild/server change:', previousGuildId, '→', nextGuildId);
    this.close();
  }

  _isDuplicateMainSplitChannel(channelId = this._splitChannelId) {
    return !!channelId && channelId === this._getSelectedChannelId();
  }

  _applyDuplicateChannelMode(reason = 'update') {
    const duplicate = this._isDuplicateMainSplitChannel();
    this._paneEl?.classList.toggle('ssv-duplicate-main-channel', duplicate);
    if (duplicate) {
      this._recordCrashEvent('duplicate-main-split-independent-scroll-mode', {
        channelId: this._splitChannelId,
        reason,
      });
      this._dbg('Same channel is open in main view and SplitView; keeping SplitView scrollable while suppressing only its composer:', this._splitChannelId);
    }
    return duplicate;
  }

  _installSelectedChannelPersistence() {
    const store = this._modules.SelectedChannelStore;
    if (!store || this._selectedChannelListener) return;

    this._lastMainChannelId = this._getSelectedChannelId();
    this._lastMainGuildId = this._getSelectedGuildId(this._lastMainChannelId);
    this._selectedChannelListener = () => {
      const previousChannelId = this._lastMainChannelId;
      const previousGuildId = this._lastMainGuildId;
      const next = this._getSelectedChannelId();
      const nextGuildId = this._getSelectedGuildId(next);
      if (next === previousChannelId && nextGuildId === previousGuildId) return;

      this._lastMainChannelId = next;
      this._lastMainGuildId = nextGuildId;

      if (previousGuildId && nextGuildId && previousGuildId !== nextGuildId) {
        this._closeForGuildChange(previousGuildId, nextGuildId);
        return;
      }

      const splitGuildId = this._getChannelGuildId(this._splitChannelId);
      if (this._splitChannelId && nextGuildId && splitGuildId && splitGuildId !== nextGuildId) {
        this._closeForGuildChange(splitGuildId, nextGuildId);
        return;
      }

      this._applyDuplicateChannelMode('main-channel-change');

      if (this._splitChannelId) {
        // Discord may replace the main chat layout during navigation inside the
        // same server. Reattach the saved SplitView pane only if that route
        // change actually detached it. Do not force-scroll the split pane on
        // ordinary main-chat navigation; same-channel mode is specifically for
        // keeping an independent right-side scroll position.
        this._scheduleRemount('main-channel-change');
      }
    };

    try {
      store.addChangeListener?.(this._selectedChannelListener);
      this._dbg('Selected channel persistence listener installed');
    } catch (e) {
      this._dbg('Selected channel listener unavailable:', e.message);
      this._selectedChannelListener = null;
    }
  }

  _removeSelectedChannelPersistence() {
    const store = this._modules.SelectedChannelStore;
    if (store && this._selectedChannelListener) {
      try { store.removeChangeListener?.(this._selectedChannelListener); } catch { /* ignore */ }
    }
    this._selectedChannelListener = null;
    this._lastMainChannelId = null;
    this._lastMainGuildId = null;
  }

  _restoreActiveSplit() {
    const savedChannelId = this._settings?.activeChannelId;
    if (!savedChannelId) return;
    if (this._restoreTimer) window.clearTimeout(this._restoreTimer);

    const delays = [1200, 2500, 5000, 9000];
    const attempt = Math.min(this._restoreAttempt, delays.length - 1);
    this._restoreTimer = window.setTimeout(() => {
      this._restoreTimer = null;
      if (this._stopped || this._splitChannelId || !this._settings?.activeChannelId) return;

      const channelId = this._settings.activeChannelId;
      const channel = this._getChannel(channelId);
      if (channel && !this.isSplitTargetChannel(channel)) {
        this._dbg('Saved split target is no longer supported; clearing:', channelId);
        this._forgetActiveSplit();
        return;
      }

      const selectedGuildId = this._getSelectedGuildId();
      const savedGuildId = this._getChannelGuildId(channel);
      if (channel && selectedGuildId && savedGuildId && selectedGuildId !== savedGuildId) {
        this._dbg('Saved split target belongs to a different server; clearing:', channelId);
        this._forgetActiveSplit();
        return;
      }

      const mainReady = !!this._getSelectedChannelId();
      const layoutReady = !!this._findLayoutContainer();
      if (channelId === this._getSelectedChannelId()) {
        this._recordCrashEvent('same-channel-restore-readonly-mode', { channelId });
        this._dbg('Restoring SplitView on same channel as main view with split composer suppressed:', channelId);
      }
      if (channel && mainReady && layoutReady) {
        this._restoreAttempt = 0;
        this._dbg('Restoring saved SplitView target after Discord startup:', channelId);
        this.open(channelId);
        return;
      }

      this._restoreAttempt += 1;
      if (this._restoreAttempt < delays.length) {
        this._dbg(`Delaying SplitView restore; Discord not ready yet (attempt ${this._restoreAttempt}/${delays.length})`);
        this._restoreActiveSplit();
      } else {
        // Do not force-open a pane into a half-booted Discord layout. Leaving the
        // saved id intact is safer than wedging normal channel navigation.
        this._dbg('Skipped SplitView auto-restore because Discord layout/channel stores were not ready. Saved target remains:', channelId);
        this._restoreAttempt = 0;
      }
    }, delays[attempt]);
  }

  _clearPaneRefs() {
    this._paneEl = null;
    this._paneTitle = null;
    this._paneBody = null;
  }

  _closeMemberListIfOpen() {
    // Keep SplitView clean by collapsing Discord's native member list only when
    // it is actually open. Discord exposes the same toolbar toggle as
    // "Hide Member List" when open and "Show Member List" when already closed.
    const candidates = [
      'button[aria-label*="Hide Member List" i]',
      'button[aria-label*="Hide Members" i]',
      'button[aria-label*="Hide Member" i]',
      '[role="button"][aria-label*="Hide Member List" i]',
      '[role="button"][aria-label*="Hide Members" i]',
      '[role="button"][aria-label*="Hide Member" i]',
    ];

    for (const selector of candidates) {
      const button = document.querySelector(selector);
      if (!button || button.closest('[data-ssv="pane"]')) continue;

      try {
        button.click();
        this._dbg('Closed Discord member list for cleaner SplitView layout');
        return true;
      } catch (e) {
        this._dbg('Member list close failed:', e.message);
        return false;
      }
    }

    this._dbg('Member list already closed or toggle not found');
    return false;
  }

  _forgetActiveSplit() {
    if (!this._settings) return;
    this._settings.activeChannelId = null;
    this._writeSessionActiveSplit(null);
    this._saveSettings();
  }

  _rememberActiveSplit(channelId) {
    if (!this._settings) return;
    this._settings.activeChannelId = channelId;
    this._writeSessionActiveSplit(channelId);
    this._saveSettings();
  }

  _isPaneAttached() {
    return !!this._paneEl && document.body.contains(this._paneEl);
  }

  _isPaneDetached() {
    return !!this._paneEl && !document.body.contains(this._paneEl);
  }

  _renderPlaceholder(heading, detail, diagnostic = null) {
    if (!this._paneBody) return;

    // The body may currently be owned by React. Unmount before direct DOM
    // replacement so fallback diagnostics do not leave stale React listeners.
    this._unmountReactRoot();

    const icon = document.createElement('div');
    icon.className = 'ssv-placeholder-icon';
    icon.textContent = '▫';

    const h = document.createElement('div');
    h.className = 'ssv-placeholder-heading';
    h.textContent = heading;

    const d = document.createElement('div');
    d.className = 'ssv-placeholder-detail';
    d.textContent = detail;

    const nodes = [icon, h, d];

    if (diagnostic) {
      const diag = document.createElement('div');
      diag.className = 'ssv-placeholder-detail ssv-placeholder-diagnostic';
      diag.textContent = diagnostic;
      nodes.push(diag);
    }

    this._paneEl?.classList.remove('ssv-native-composerless');
    this._paneBody.classList.remove('ssv-native');
    this._paneBody.classList.add('ssv-placeholder');
    this._paneBody.replaceChildren(...nodes);
  }

  _applyWidth(w) {
    if (this._paneEl) this._paneEl.style.width = `${w}px`;
    document.documentElement.style.setProperty('--ssv-split-width', `${w}px`);
    this._scheduleTitlebarDragStripSync('width');
  }

  _applyPanePlacement() {
    if (this._settings?.paneMode === 'floating') {
      this._applyFloatingRect(this._clampFloatingRect(this._settings.floatingRect));
    } else {
      this._applyDockedLayout();
      if (this._paneEl) {
        this._paneEl.style.left = '';
        this._paneEl.style.top = '';
        this._paneEl.style.height = '';
      }
      this._scheduleTitlebarDragStripSync('pane-placement');
    }
  }

  _applyFloatingRect(rect) {
    const next = normalizeFloatingRect(rect);
    this._settings.floatingRect = next;
    this._removeTitlebarDragStrip();
    if (!this._paneEl) return;
    this._paneEl.style.left = `${next.left}px`;
    this._paneEl.style.top = `${next.top}px`;
    this._paneEl.style.width = `${next.width}px`;
    this._paneEl.style.height = `${next.height}px`;
    document.documentElement.style.setProperty('--ssv-split-width', `${next.width}px`);
  }

  _persistFloatingRect(rect) {
    this._settings.floatingRect = this._clampFloatingRect(normalizeFloatingRect(rect));
    this._settings.currentWidth = this._settings.floatingRect.width;
    this._hasSavedFloatingRect = true;
    this._saveSettings();
    return this._settings.floatingRect;
  }

  _clampFloatingRect(rect) {
    const viewportWidth = Math.max(window.innerWidth || DEFAULT_FLOATING_RECT.width, DEFAULT_FLOATING_RECT.width);
    const viewportHeight = Math.max(window.innerHeight || DEFAULT_FLOATING_RECT.height, DEFAULT_FLOATING_RECT.height);
    const width = Math.max(MIN_WIDTH, Math.min(rect.width, Math.max(MIN_WIDTH, viewportWidth - 24)));
    const height = Math.max(MIN_FLOATING_HEIGHT, Math.min(rect.height, Math.max(MIN_FLOATING_HEIGHT, viewportHeight - 24)));
    return {
      left: Math.max(12, Math.min(rect.left, Math.max(12, viewportWidth - width - 12))),
      top: Math.max(12, Math.min(rect.top, Math.max(12, viewportHeight - height - 12))),
      width,
      height,
    };
  }

  toggleFloatingMode() {
    if (!this._settings) return null;
    const channelId = this._splitChannelId || this._settings.activeChannelId;
    const nextMode = this._settings.paneMode === 'floating' ? 'docked' : 'floating';
    if (nextMode === 'floating') {
      // Keep the user's last floating location instead of reusing the docked
      // pane's right-side bounds. The whole point of breakout is stable position.
      const nextRect = this._hasSavedFloatingRect
        ? this._settings.floatingRect
        : DEFAULT_FLOATING_RECT;
      this._settings.floatingRect = this._clampFloatingRect(nextRect);
      this._hasSavedFloatingRect = true;
    }
    this._settings.paneMode = nextMode;
    this._saveSettings();

    if (this._paneEl) {
      this.destroyDockedPane();
      if (channelId) this.open(channelId);
    }
    this._toast(nextMode === 'floating' ? 'SplitView broken out; drag the header to move it' : 'SplitView docked right', 'info');
    return { paneMode: this._settings.paneMode, floatingRect: this._settings.floatingRect };
  }

  // ─── Native render ───────────────────────────────────────────────────────────

  // Returns the plugin's own minimal ErrorBoundary class (or Discord's if found).
  // Lazily created so React must be discovered first.
  _getErrorBoundary() {
    if (this._SsvErrorBoundary) return this._SsvErrorBoundary;

    const React = this._modules.React;
    if (!React?.Component) return null;

    const plugin = this;
    class SsvErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { hasError: false, errorText: null };
      }
      static getDerivedStateFromError(err) { return { hasError: true, errorText: err?.message || String(err || 'unknown render error') }; }
      componentDidCatch(err, info) {
        console.error('[SplitView] Render boundary caught:', err);
        plugin._recordCrashEvent('render-boundary-caught', {
          error: plugin._stringifyLogArgs([err])[0],
          componentStack: info?.componentStack ?? null,
        });
      }
      render() {
        if (this.state.hasError) return React.createElement('div', { className: 'ssv-placeholder-detail ssv-placeholder-diagnostic' }, [
          React.createElement('div', { key: 'title' }, 'Native render error caught.'),
          React.createElement('code', { key: 'error', style: { display: 'block', marginTop: '8px', whiteSpace: 'pre-wrap' } }, this.state.errorText || 'unknown render error'),
          React.createElement('div', { key: 'hint', style: { marginTop: '8px' } }, 'Run SplitViewDebug.printCrashLog().'),
        ]);
        return this.props.children;
      }
    }

    this._SsvErrorBoundary = SsvErrorBoundary;
    return SsvErrorBoundary;
  }

  _unmountReactRoot() {
    if (!this._reactRoot) return;
    try {
      if (this._reactRoot._legacy) {
        this._modules.ReactDOM?.unmountComponentAtNode?.(this._reactRoot._el);
      } else {
        this._reactRoot.unmount();
      }
    } catch (e) {
      this._dbg('Unmount error:', e.message);
    }
    this._reactRoot = null;
  }

  _clearNativeRenderRetries() {
    for (const timer of this._nativeRenderTimers) window.clearTimeout(timer);
    this._nativeRenderTimers.clear();
  }

  _nativeRenderModulesReady() {
    return !!(
      this._modules.React &&
      this._modules.ReactDOM &&
      this._modules.SplitViewComponent
    );
  }

  _scheduleNativeRenderRetry(channelId, channelHint = null, firstResult = null) {
    const missing = firstResult?.missing ?? [];
    if (!missing.length || !this._paneBody) return;

    this._clearNativeRenderRetries();
    for (const delay of [350, 1000, 2500, 5000, 9000]) {
      const timer = window.setTimeout(() => {
        this._nativeRenderTimers.delete(timer);
        if (this._stopped || this._splitChannelId !== channelId || !this._paneBody) return;

        this.discoverModules();
        const result = this._tryNativeRender(channelId, channelHint, false, this._nativeRenderVariant);
        if (result.ok) {
          this._clearNativeRenderRetries();
          this._scheduleScrollToBottom('split', `native-render-retry-${delay}ms`);
          return;
        }

        if (this._nativeRenderTimers.size === 0) {
          this._dbg('Native render still unavailable after retries:', result);
        }
      }, delay);
      this._nativeRenderTimers.add(timer);
    }
  }

  _normalizeNativeVariant(variant = null) {
    const value = String(variant || this._nativeRenderVariant || 'sidebar').toLowerCase();
    if (['sidebar', 'full', 'composer'].includes(value)) return 'sidebar';
    if (['none', 'no-input', 'noinput'].includes(value)) return 'none';
    return 'composerless';
  }

  _buildNativeRenderProps(channel, guild, variant) {
    const props = { channel, guild };
    if (variant === 'sidebar') {
      props.chatInputType = this._modules.ChatInputTypes?.SIDEBAR;
      return props;
    }

    // Diagnostic path for legacy 0.1.212: legacy 0.1.211 proved Discord throws
    // "chat input type must be set" if chatInputType is undefined. Keep the
    // required SIDEBAR type so the native invariant is satisfied, while passing
    // conservative read-only/no-composer hints and visually suppressing the
    // duplicate composer with CSS. If this returns to richValue/isEditorEmpty,
    // the crash is specifically inside Discord's sidebar composer state.
    props.chatInputType = this._modules.ChatInputTypes?.SIDEBAR;
    props.renderChatInput = false;
    props.showChatInput = false;
    props.shouldRenderChatInput = false;
    props.disableChatInput = true;
    props.hideChatInput = true;
    props.readOnly = true;
    props.isReadOnly = true;
    props.allowSend = false;
    return props;
  }

  // Attempts to mount Discord's internal SplitViewComponent. The default legacy
  // variant satisfies Discord's chatInputType invariant while visually suppressing
  // the duplicate composer to isolate the richValue/isEditorEmpty crash.
  // Returns { ok: true } on success, { ok: false, missing?: string[], error?: string } on failure.
  _tryNativeRender(channelId, channelHint = null, rediscoverIfMissing = true, variant = null) {
    if (rediscoverIfMissing && !this._nativeRenderModulesReady()) this.discoverModules();

    const { React, ReactDOM, SplitViewComponent, ChatInputTypes, GuildStore } = this._modules;
    const renderVariant = this._normalizeNativeVariant(variant);

    const missing = [];
    if (!React)                    missing.push('React');
    if (!ReactDOM)                 missing.push('ReactDOM');
    if (!SplitViewComponent)       missing.push('SplitViewComponent');
    if (!ChatInputTypes?.SIDEBAR)  missing.push('ChatInputTypes.SIDEBAR');

    if (missing.length > 0) {
      this._renderMode = 'placeholder';
      this._dbg('Native render unavailable — missing:', missing.join(', '));
      return { ok: false, missing };
    }

    const channel = this._getChannel(channelHint ?? channelId);
    const guildId = this._getChannelGuildId(channel);
    const guild   = guildId ? (GuildStore?.getGuild?.(guildId) ?? null) : null;

    try {
      this._unmountReactRoot();

      const ErrorBoundary = this._getErrorBoundary();

      const renderProps = this._buildNativeRenderProps(channel, guild, renderVariant);
      let content = React.createElement(SplitViewComponent, renderProps);

      if (ErrorBoundary) {
        content = React.createElement(ErrorBoundary, {}, content);
      }

      this._paneEl?.classList.toggle('ssv-native-composerless', renderVariant !== 'sidebar');
      this._paneBody.classList.remove('ssv-placeholder');
      this._paneBody.classList.add('ssv-native');

      if (ReactDOM.createRoot) {
        this._reactRoot = ReactDOM.createRoot(this._paneBody);
        this._reactRoot.render(content);
      } else {
        // React 17 / legacy render path
        ReactDOM.render(content, this._paneBody);
        this._reactRoot = { _legacy: true, _el: this._paneBody };
      }

      this._renderMode = 'native';
      this._log(`Native render mounted: ${channelId} [${renderVariant}]`);
      return { ok: true, variant: renderVariant };
    } catch (e) {
      this._err('Native render failed:', e);
      this._recordCrashEvent('native-render-failed', { error: this._stringifyLogArgs([e])[0], channelId, variant: renderVariant });
      this._renderMode = 'placeholder';
      return { ok: false, error: e.message };
    }
  }

  // ─── MiniChat-style Breakout popouts ─────────────────────────────────────────

  _getBreakoutModuleStatus() {
    const m = this._modules || {};
    return {
      React: !!m.React,
      SplitViewComponent: !!m.SplitViewComponent,
      ChatInputTypesSidebar: !!m.ChatInputTypes?.SIDEBAR,
      PopoutActions: !!m.PopoutActions?.open,
      PopoutActionsClose: !!m.PopoutActions?.close,
      PopoutWindow: !!m.PopoutWindow,
      PopoutWindowStore: !!m.PopoutWindowStore,
      NativeAlwaysOnTop: !!m.Native?.setAlwaysOnTop,
      Header: !!m.Header,
      Bar: !!m.Bar,
      IconUtils: !!m.IconUtils,
      AckActions: !!m.AckActions?.ack,
    };
  }

  inspectBreakoutModules() {
    this.discoverModules();
    const status = this._getBreakoutModuleStatus();
    const missingRequired = Object.entries({
      React: status.React,
      SplitViewComponent: status.SplitViewComponent,
      ChatInputTypesSidebar: status.ChatInputTypesSidebar,
      PopoutActions: status.PopoutActions,
      PopoutWindow: status.PopoutWindow,
    }).filter(([, ok]) => !ok).map(([name]) => name);
    const result = {
      ok: missingRequired.length === 0,
      missingRequired,
      status,
      openBreakouts: Array.from(this._breakouts.values()),
      ackBridgeInstalled: !!this._dispatcher,
      sidebarInputPatched: !!this._origSidebarInput,
    };
    console.log('[SplitView] Breakout module inspection:', result);
    return result;
  }

  _installBreakoutInputPatches() {
    const sidebar = this._modules.ChatInputTypes?.SIDEBAR;
    if (!sidebar || this._origSidebarInput) return;
    this._origSidebarInput = {
      gifs: sidebar.gifs ? { ...sidebar.gifs } : null,
      stickers: sidebar.stickers ? { ...sidebar.stickers } : null,
      commands: sidebar.commands ? { ...sidebar.commands } : null,
    };
    // Matches the MiniChat pattern: make the sidebar composer act like a durable
    // chat input instead of a transient secondary input that loses focus after
    // the main Discord view changes. Keep slash commands explicitly enabled:
    // Discord's native split/sidebar chat uses this same ChatInputTypes.SIDEBAR
    // object, so disabling `commands` here removes `/` autocomplete from both
    // docked SplitView and Breakout chats.
    if (sidebar.gifs) sidebar.gifs.button = true;
    if (sidebar.stickers) {
      sidebar.stickers.button = true;
      sidebar.stickers.autoSuggest = true;
    }
    if (sidebar.commands) sidebar.commands.enabled = true;
    this._recordCrashEvent('breakout-input-patches-installed', {
      commandsEnabled: sidebar.commands?.enabled ?? null,
    });
  }

  _restoreBreakoutInputPatches() {
    const sidebar = this._modules.ChatInputTypes?.SIDEBAR;
    const orig = this._origSidebarInput;
    if (!sidebar || !orig) return;
    try {
      if (orig.gifs && sidebar.gifs) Object.assign(sidebar.gifs, orig.gifs);
      if (orig.stickers && sidebar.stickers) Object.assign(sidebar.stickers, orig.stickers);
      if (orig.commands && sidebar.commands) Object.assign(sidebar.commands, orig.commands);
    } catch (e) {
      this._dbg('Breakout input restore failed:', e.message);
    }
    this._origSidebarInput = null;
  }

  _installBreakoutAckBridge() {
    if (this._dispatcher || !this._modules.AckActions?.ack) return;
    const dispatcher = this._modules.UserStore?._dispatcher ?? BdApi.Webpack?.Stores?.UserStore?._dispatcher ?? null;
    if (!dispatcher?.subscribe || !dispatcher?.dispatch) return;
    this._dispatcher = dispatcher;
    this._onBreakoutMessage = (event) => {
      if (!event?.channelId || !this._breakouts.has(event.channelId)) return;
      try { this._modules.AckActions?.ack?.(event.channelId, undefined, true, true, event.message?.id); } catch { /* ignore */ }
      try { dispatcher.dispatch({ type: 'CHANNEL_LOCAL_ACK', channelId: event.channelId }); } catch { /* ignore */ }
    };
    try { dispatcher.subscribe('MESSAGE_CREATE', this._onBreakoutMessage); } catch { /* ignore */ }
    this._recordCrashEvent('breakout-ack-bridge-installed');
  }

  _removeBreakoutAckBridge() {
    try { this._dispatcher?.unsubscribe?.('MESSAGE_CREATE', this._onBreakoutMessage); } catch { /* ignore */ }
    this._dispatcher = null;
    this._onBreakoutMessage = null;
  }

  _activateBreakout(recordOrChannelId) {
    const record = typeof recordOrChannelId === 'object'
      ? recordOrChannelId
      : this._breakouts.get(recordOrChannelId) || Array.from(this._breakouts.values()).find(r => r.windowKey === recordOrChannelId);
    if (!record) return { ok: false, error: 'Breakout not tracked', value: recordOrChannelId };
    const dispatcher = this._dispatcher ?? this._modules.UserStore?._dispatcher ?? BdApi.Webpack?.Stores?.UserStore?._dispatcher ?? null;
    const result = { ok: true, channelId: record.channelId, windowKey: record.windowKey, dispatched: [] };
    try {
      dispatcher?.dispatch?.({ type: 'ENABLE_AUTOMATIC_ACK', channelId: record.channelId, windowId: record.windowKey });
      result.dispatched.push('ENABLE_AUTOMATIC_ACK');
    } catch (e) {
      result.ackError = e.message;
    }
    try {
      this._modules.AckActions?.ack?.(record.channelId, undefined, true, true);
      result.dispatched.push('AckActions.ack');
    } catch { /* ignore */ }
    record.lastActivatedAt = new Date().toISOString();
    this._recordCrashEvent('breakout-activated', result);
    return result;
  }

  _getBreakoutWindowKey(channelId) {
    return `DISCORD_SSV_BREAKOUT_${channelId}`;
  }

  _getChannelDisplayName(channel) {
    if (!channel) return 'Chat';
    const rawName = channel.name || channel.rawRecipients?.[0]?.username || channel.recipients?.[0]?.username || channel.id;
    const prefix = channel.type === 1 ? '@' : channel.type === 3 ? '' : '#';
    return `${prefix}${rawName}`;
  }

  _getBreakoutSubtitle(channel, guild) {
    if (!channel) return 'Breakout Chat';
    const parts = [];
    if (guild?.name) parts.push(guild.name);
    const parent = channel.parent_id ? this._getChannel(channel.parent_id) : null;
    if (parent?.name) parts.push(`#${parent.name}`);
    if (this.isThreadChannel(channel)) parts.push('thread');
    parts.push('Breakout Chat');
    return parts.join(' · ');
  }

  _syncBreakoutDocumentStyles(doc) {
    try {
      if (!doc || doc === document) return;
      doc.querySelectorAll('[data-ssv-breakout-synced]').forEach(el => el.remove());
      document.querySelectorAll('bd-head style, style[data-bd], style[id^="bd"], style#SplitView').forEach(el => {
        const clone = el.cloneNode(true);
        clone.setAttribute('data-ssv-breakout-synced', 'true');
        doc.head.appendChild(clone);
      });
      doc.documentElement.className = document.documentElement.className;
      doc.documentElement.style.cssText = document.documentElement.style.cssText;
      const mainMount = document.getElementById('app-mount');
      const popMount = doc.getElementById('app-mount');
      if (mainMount && popMount) popMount.className = mainMount.className;
    } catch (e) {
      this._dbg('Breakout style sync failed:', e.message);
    }
  }

  _buildBreakoutContent(channelId, breakoutId, windowKey) {
    const { React, SplitViewComponent, ChatInputTypes, GuildStore } = this._modules;
    const channel = this._getChannel(channelId);
    const guildId = this._getChannelGuildId(channel);
    const guild = guildId ? (GuildStore?.getGuild?.(guildId) ?? null) : null;
    const ErrorBoundary = this._getErrorBoundary();
    const title = this._getChannelDisplayName(channel);
    const subtitle = this._getBreakoutSubtitle(channel, guild);
    const plugin = this;

    const BreakoutRoot = function BreakoutRoot() {
      const ref = React.useRef?.(null);
      React.useEffect?.(() => {
        const doc = ref.current?.ownerDocument;
        plugin._syncBreakoutDocumentStyles(doc);
        if (doc) doc.title = title;
        const activate = () => plugin._activateBreakout(channelId);
        activate();
        doc?.defaultView?.addEventListener?.('focus', activate);
        return () => doc?.defaultView?.removeEventListener?.('focus', activate);
      }, []);

      let native = null;
      try {
        native = React.createElement(SplitViewComponent, {
          channel,
          guild,
          chatInputType: ChatInputTypes?.SIDEBAR,
        });
        if (ErrorBoundary) native = React.createElement(ErrorBoundary, {}, native);
      } catch (e) {
        plugin._recordCrashEvent('breakout-content-build-failed', { channelId, breakoutId, windowKey, error: plugin._stringifyLogArgs([e])[0] });
        native = React.createElement('div', { className: 'ssv-breakout-diagnostic' }, `Breakout render failed: ${e.message}`);
      }

      return React.createElement('div', {
        className: 'ssv-breakout-root',
        'data-ssv-breakout-id': String(breakoutId),
        'data-ssv-breakout-channel-id': channelId,
        'data-ssv-breakout-title': title,
        onMouseDownCapture: () => plugin._activateBreakout(channelId),
        onFocusCapture: () => plugin._activateBreakout(channelId),
        ref,
      },
        React.createElement('div', { className: 'ssv-breakout-header', title: `${title} — ${subtitle}` },
          React.createElement('div', { className: 'ssv-breakout-title-stack' },
            React.createElement('div', { className: 'ssv-breakout-title' }, title),
            React.createElement('div', { className: 'ssv-breakout-subtitle' }, subtitle)
          ),
          React.createElement('button', {
            type: 'button',
            className: 'ssv-breakout-close',
            'aria-label': `Close ${title}`,
            title: `Close ${title}`,
            onClick: () => plugin.closeBreakout(channelId),
          }, '×')
        ),
        React.createElement('div', { className: 'ssv-breakout-body' }, native)
      );
    };

    return React.createElement(BreakoutRoot, {});
  }

  openBreakout(channelId, channelHint = null) {
    if (!channelId) return { ok: false, error: 'openBreakout requires a channelId' };
    if (!this._modules.ChannelStore) this.discoverModules();
    const channel = this._getChannel(channelHint ?? channelId);
    if (channel && !this.isSplitTargetChannel(channel)) {
      const result = { ok: false, error: 'Breakout Chat opens guild text channels and real Discord threads' };
      this._toast(result.error, 'warning');
      return result;
    }

    const inspection = this.inspectBreakoutModules();
    if (!inspection.ok) {
      const result = { ok: false, error: `Missing breakout modules: ${inspection.missingRequired.join(', ')}`, inspection };
      this._recordCrashEvent('breakout-open-missing-modules', result);
      this._toast('Breakout modules missing; run SplitViewDebug.inspectBreakoutModules()', 'warning');
      return result;
    }

    this._installBreakoutInputPatches();
    this._installBreakoutAckBridge();

    const { React, PopoutActions, PopoutWindow, PopoutWindowStore, Native } = this._modules;
    const windowKey = this._getBreakoutWindowKey(channelId);
    if (PopoutWindowStore?.getWindowOpen?.(windowKey)) {
      this.closeBreakout(channelId);
      return { ok: true, toggledClosed: true, channelId, windowKey };
    }

    const breakoutId = ++this._breakoutCounter;
    const title = this._getChannelDisplayName(channel);
    const record = { breakoutId, channelId, windowKey, title, createdAt: new Date().toISOString() };
    this._breakouts.set(channelId, record);

    try {
      PopoutActions.open(
        windowKey,
        () => React.createElement(
          PopoutWindow,
          { windowKey, withTitleBar: true, title, channelId },
          this._buildBreakoutContent(channelId, breakoutId, windowKey)
        ),
        { width: 520, height: 560 }
      );
      this._recordCrashEvent('breakout-opened', record);
      this._activateBreakout(record);
      this._toast(`Breakout Chat opened: ${title}`, 'info');

      let tries = 0;
      const setup = () => {
        if (!this._breakouts.has(channelId) || tries++ > 20) return;
        const win = PopoutWindowStore?.getWindow?.(windowKey);
        if (!win) return window.setTimeout(setup, 100);
        try { win.resizeTo?.(520, 560); } catch { /* ignore */ }
        try { Native?.setAlwaysOnTop?.(windowKey, true); } catch { /* ignore */ }
        this._activateBreakout(record);
      };
      window.setTimeout(setup, 250);
      return { ok: true, ...record };
    } catch (e) {
      this._breakouts.delete(channelId);
      const result = { ok: false, error: e.message, channelId, windowKey };
      this._recordCrashEvent('breakout-open-failed', { ...result, errorObject: this._stringifyLogArgs([e])[0] });
      this._toast('Breakout Chat failed; copy diagnostics', 'error');
      return result;
    }
  }

  closeBreakout(channelIdOrWindowKey) {
    const record = this._breakouts.get(channelIdOrWindowKey) || Array.from(this._breakouts.values()).find(r => r.windowKey === channelIdOrWindowKey);
    if (!record) return { ok: false, error: 'Breakout not tracked', value: channelIdOrWindowKey };
    try { this._modules.PopoutActions?.close?.(record.windowKey); } catch (e) { this._dbg('Breakout close failed:', e.message); }
    this._breakouts.delete(record.channelId);
    if (this._breakouts.size === 0) {
      this._restoreBreakoutInputPatches();
    }
    this._recordCrashEvent('breakout-closed', record);
    return { ok: true, ...record };
  }

  closeAllBreakouts() {
    const records = Array.from(this._breakouts.values());
    for (const record of records) this.closeBreakout(record.channelId);
    return { ok: true, closed: records.length };
  }

  // ─── Open / close ────────────────────────────────────────────────────────────

  open(channelId, channelHint = null) {
    if (!channelId) { this._err('open() requires a channelId'); return; }

    // Lazy discovery if called before start() (e.g., from SplitViewDebug.open())
    if (!this._modules.ChannelStore) this.discoverModules();

    const channel = this._getChannel(channelHint ?? channelId);

    if (channel && !this.isSplitTargetChannel(channel)) {
      this._toast('SplitView opens guild text channels and real Discord threads', 'warning');
      return;
    }

    const selectedGuildId = this._getSelectedGuildId();
    const selectedChannelId = this._getSelectedChannelId();
    if (selectedChannelId && selectedChannelId === channelId) {
      this._recordCrashEvent('duplicate-open-same-channel-readonly', { channelId, selectedChannelId });
      this._toast('Same channel open in both panes; SplitView composer suppressed', 'info');
      this._dbg('Opening duplicate main/split channel in read-only split mode:', channelId);
    }
    const targetGuildId = this._getChannelGuildId(channel);
    if (selectedGuildId && targetGuildId && selectedGuildId !== targetGuildId) {
      this._toast('Switch to that server before opening SplitView', 'warning');
      this._dbg('Refusing cross-server SplitView open:', { selectedGuildId, targetGuildId, channelId });
      return;
    }

    this._splitChannelId = channelId;
    this._rememberActiveSplit(channelId);

    if (this._isPaneDetached()) {
      this._dbg('Clearing detached pane before opening new split target');
      this.destroyDockedPane();
    }

    if (!this._paneEl && !this.createDockedPane()) return;
    this._scheduleDockedRight('split-open');
    if (this._memberListTimer) window.clearTimeout(this._memberListTimer);
    this._memberListTimer = window.setTimeout(() => {
      this._memberListTimer = null;
      if (!this._stopped) this._closeMemberListIfOpen();
    }, 100);

    // Update header title
    if (this._paneTitle) {
      const name   = channel?.name ?? channelId;
      const prefix = channel?.type === 1 ? '@' : channel?.type === 3 ? '' : '#';
      this._paneTitle.textContent = `${prefix}${name}`;
    }

    const result = this._tryNativeRender(channelId, channel, true, this._nativeRenderVariant);
    this._applyDuplicateChannelMode('split-open');

    if (!result.ok) {
      const displayName = channel?.name ?? channelId;
      const prefix      = channel?.type === 1 ? '@' : channel?.type === 3 ? '' : '#';
      const diag        = result.missing
        ? `Missing modules: ${result.missing.join(', ')}`
        : `Render error: ${result.error ?? 'unknown'}`;
      this._renderPlaceholder(
        `${prefix}${displayName}`,
        'Native Discord chat unavailable.',
        diag
      );
      this._scheduleNativeRenderRetry(channelId, channel, result);
    }

    this._log(`Opened ${channelId}${channel ? ` (#${channel.name})` : ''} [${this._renderMode}]`);
    this._scheduleScrollToBottom('both', 'split-open');
  }

  close() {
    if (!this._paneEl && this._splitChannelId == null) return;
    this._clearNativeRenderRetries();
    this._splitChannelId = null;
    this._forgetActiveSplit();
    this._renderMode = 'none';
    this._paneEl?.classList.remove('ssv-duplicate-main-channel');
    this.destroyDockedPane();
    this._log('Closed');
  }

  isSplitTargetChannel(channel) {
    return channel != null && SPLIT_TARGET_TYPES.has(channel.type);
  }

  isThreadChannel(channel) {
    return channel != null && THREAD_TYPES.has(channel.type);
  }

  // ─── Floating breakout positioning ────────────────────────────────────────────

  _onFloatingDragStart = (e) => {
    if (this._settings?.paneMode !== 'floating' || !this._paneEl) return;
    if (e.target?.closest?.('button')) return;
    e.preventDefault();
    const rect = this._paneEl.getBoundingClientRect();
    this._floatingDragStart = {
      x: e.clientX,
      y: e.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    this._paneEl.classList.add('ssv-floating-dragging');
    document.addEventListener('mousemove', this._onFloatingDragMove);
    document.addEventListener('mouseup', this._onFloatingDragEnd);
    window.addEventListener('blur', this._cancelFloatingDrag);
  };

  _onFloatingDragMove = (e) => {
    if (!this._floatingDragStart || !this._paneEl) return;
    const next = this._clampFloatingRect({
      left: this._floatingDragStart.left + (e.clientX - this._floatingDragStart.x),
      top: this._floatingDragStart.top + (e.clientY - this._floatingDragStart.y),
      width: this._floatingDragStart.width,
      height: this._floatingDragStart.height,
    });
    this._settings.floatingRect = next;
    this._applyFloatingRect(next);
    this._scheduleFloatingRectSave();
  };

  _onFloatingDragEnd = () => {
    if (!this._floatingDragStart) return;
    const rect = this._settings.floatingRect;
    this._cancelFloatingDrag();
    this._persistFloatingRect(rect);
    this._dbg('Floating position persisted:', this._settings.floatingRect);
  };

  _cancelFloatingDrag = () => {
    this._paneEl?.classList.remove('ssv-floating-dragging');
    this._floatingDragStart = null;
    document.removeEventListener('mousemove', this._onFloatingDragMove);
    document.removeEventListener('mouseup', this._onFloatingDragEnd);
    window.removeEventListener('blur', this._cancelFloatingDrag);
  };

  _onFloatingResizeStart = (e) => {
    if (this._settings?.paneMode !== 'floating' || !this._paneEl) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = this._paneEl.getBoundingClientRect();
    this._floatingResizeStart = {
      x: e.clientX,
      y: e.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    document.body.classList.add('ssv-floating-resizing');
    this._paneEl.classList.add('ssv-floating-resizing');
    document.addEventListener('mousemove', this._onFloatingResizeMove);
    document.addEventListener('mouseup', this._onFloatingResizeEnd);
    window.addEventListener('blur', this._cancelFloatingResize);
  };

  _onFloatingResizeMove = (e) => {
    if (!this._floatingResizeStart || !this._paneEl) return;
    const next = this._clampFloatingRect({
      left: this._floatingResizeStart.left,
      top: this._floatingResizeStart.top,
      width: this._floatingResizeStart.width + (e.clientX - this._floatingResizeStart.x),
      height: this._floatingResizeStart.height + (e.clientY - this._floatingResizeStart.y),
    });
    this._settings.currentWidth = next.width;
    this._settings.floatingRect = next;
    this._applyFloatingRect(next);
    this._scheduleFloatingRectSave();
  };

  _onFloatingResizeEnd = () => {
    if (!this._floatingResizeStart) return;
    const rect = this._settings.floatingRect;
    this._cancelFloatingResize();
    this._persistFloatingRect(rect);
    this._dbg('Floating size persisted:', this._settings.floatingRect);
  };

  _cancelFloatingResize = () => {
    this._paneEl?.classList.remove('ssv-floating-resizing');
    document.body.classList.remove('ssv-floating-resizing');
    this._floatingResizeStart = null;
    document.removeEventListener('mousemove', this._onFloatingResizeMove);
    document.removeEventListener('mouseup', this._onFloatingResizeEnd);
    window.removeEventListener('blur', this._cancelFloatingResize);
  };

  _onWindowResize = () => {
    if (this._settings?.paneMode !== 'floating') {
      this._scheduleTitlebarDragStripSync('window-resize');
      return;
    }
    const clamped = this._clampFloatingRect(this._settings.floatingRect);
    this._settings.floatingRect = clamped;
    this._applyFloatingRect(clamped);
  };

  // ─── Resize ──────────────────────────────────────────────────────────────────

  _onResizeStart = (e) => {
    e.preventDefault();
    this._resizing = true;
    this._resizeStartX = e.clientX;
    this._resizeStartWidth = this._settings?.paneMode === 'floating'
      ? this._settings.floatingRect.width
      : this._settings.currentWidth;
    document.body.classList.add('ssv-resizing');
    this._paneEl?.querySelector('.ssv-resize-handle')?.classList.add('ssv-resizing');
    document.addEventListener('mousemove', this._onResizeMove);
    document.addEventListener('mouseup', this._onResizeEnd);
    window.addEventListener('blur', this._cancelResize);
  };

  _cancelResize = () => {
    if (!this._resizing) return;
    this._resizing = false;
    document.body.classList.remove('ssv-resizing');
    this._paneEl?.querySelector('.ssv-resize-handle')?.classList.remove('ssv-resizing');
    document.removeEventListener('mousemove', this._onResizeMove);
    document.removeEventListener('mouseup', this._onResizeEnd);
    window.removeEventListener('blur', this._cancelResize);
    if (this._settings?.paneMode === 'floating') {
      this._persistFloatingRect(this._settings.floatingRect);
    } else {
      this._saveSettings();
    }
    this._dbg('Resize cancelled after window blur');
  };

  _onResizeMove = (e) => {
    if (!this._resizing || !this._paneEl) return;
    // Handle is on the left edge: dragging left widens, dragging right narrows
    const delta = this._resizeStartX - e.clientX;
    const maxW  = this._settings?.paneMode === 'floating' ? Math.floor(window.innerWidth - 24) : Math.floor(window.innerWidth * 0.8);
    const newW  = Math.max(MIN_WIDTH, Math.min(maxW, this._resizeStartWidth + delta));
    this._settings.currentWidth = newW;
    if (this._settings?.paneMode === 'floating') {
      this._settings.floatingRect = this._clampFloatingRect({ ...this._settings.floatingRect, width: newW });
      this._applyFloatingRect(this._settings.floatingRect);
    } else {
      this._applyWidth(newW);
      this._scheduleTitlebarDragStripSync('resize-move');
    }
  };

  _onResizeEnd = () => {
    if (!this._resizing) return;
    this._resizing = false;
    document.body.classList.remove('ssv-resizing');
    this._paneEl?.querySelector('.ssv-resize-handle')?.classList.remove('ssv-resizing');
    document.removeEventListener('mousemove', this._onResizeMove);
    document.removeEventListener('mouseup', this._onResizeEnd);
    window.removeEventListener('blur', this._cancelResize);
    if (this._settings?.paneMode === 'floating') {
      this._persistFloatingRect(this._settings.floatingRect);
    } else {
      this._saveSettings();
    }
    this._scheduleTitlebarDragStripSync('resize-end');
    this._dbg(`Width persisted: ${this._settings.currentWidth}px`);
  };

  // ─── Context menus ───────────────────────────────────────────────────────────

  patchContextMenus() {
    if (typeof BdApi.ContextMenu?.patch !== 'function') {
      this._log('BdApi.ContextMenu.patch not available — context menu items disabled');
      return;
    }

    const buildSplitItem = (channel) =>
      BdApi.ContextMenu.buildItem({
        type: 'button',
        id: 'ssv-open-in-split',
        label: 'Open in Split View',
        action: () => {
          this._cacheChannelSnapshot(channel);
          this.open(channel.id, channel);
        },
      });

    const buildBreakoutItem = (channel) =>
      BdApi.ContextMenu.buildItem({
        type: 'button',
        id: 'ssv-breakout-chat',
        label: 'Breakout Chat',
        action: () => {
          this._cacheChannelSnapshot(channel);
          this.openBreakout(channel.id, channel);
        },
      });

    const inject = (ret, channel) => {
      try {
        if (!channel?.id) return;
        this._cacheChannelSnapshot(channel);
        const children = ret?.props?.children;
        if (!Array.isArray(children)) return;
        children.unshift(
          buildSplitItem(channel),
          buildBreakoutItem(channel),
          BdApi.ContextMenu.buildItem({ type: 'separator' })
        );
      } catch (e) {
        this._dbg('inject failed:', e.message);
      }
    };

    const safe = (fn) => (...args) => { try { fn(...args); } catch (e) { this._dbg('ctx patch error:', e.message); } };

    // Real Discord channels/threads only. The native thread route is still the
    // product direction, but channel right-clicks are a required entry point and
    // should appear at the top of the menu.
    for (const navId of ['channel-context', 'thread-context']) {
      const unpatch = BdApi.ContextMenu.patch(navId, safe((ret, props) => {
        const ch = props?.channel;
        if (ch && this.isSplitTargetChannel(ch)) inject(ret, ch);
      }));
      this._unpatchers.push(unpatch);
    }

    this._log(`Context menus patched (${this._unpatchers.length} entries)`);
  }

  unpatchContextMenus() {
    this._unpatchers.forEach(fn => { try { fn?.(); } catch { /* already removed */ } });
    this._unpatchers = [];
  }

  _inspectElement(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName,
      cls: String(el.className || '').slice(0, 240),
      id: el.id || null,
      role: el.getAttribute?.('role'),
      aria: el.getAttribute?.('aria-label'),
      text: String(el.textContent || '').trim().slice(0, 180),
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      display: cs.display,
      position: cs.position,
      zIndex: cs.zIndex,
      overflow: cs.overflow,
      pointerEvents: cs.pointerEvents,
      appRegion: cs.webkitAppRegion,
    };
  }

  _inspectPane() {
    const pane = this._paneEl || document.querySelector('[data-ssv="pane"]');
    const body = this._paneBody || pane?.querySelector('.ssv-pane-body');
    const selectors = [
      '[class*="chatContent"]',
      '[class*="messagesWrapper"]',
      '[class*="scroller"]',
      '[class*="channelTextArea"]',
      '[class*="typing"]',
      '[role="textbox"]',
      '[role="log"]',
      'ol',
      'ul',
      'form',
    ].join(', ');
    const nativeEvidence = pane ? Array.from(pane.querySelectorAll(selectors)).slice(0, 40).map(el => this._inspectElement(el)) : [];
    const result = {
      status: this._collectStatusSnapshot(),
      nativeRenderVariant: this._nativeRenderVariant,
      pane: this._inspectElement(pane),
      paneParent: this._inspectElement(pane?.parentElement),
      paneBody: this._inspectElement(body),
      paneChildren: pane ? Array.from(pane.children).map(el => this._inspectElement(el)) : [],
      bodyChildren: body ? Array.from(body.children).map(el => this._inspectElement(el)) : [],
      nativeEvidence,
    };
    console.log('[SplitView] Pane inspection:', result);
    return result;
  }

  // ─── Debug API ───────────────────────────────────────────────────────────────

  _installDebugAPI() {
    const api = {
      dumpStatus: () => {
        const moduleStatus = Object.fromEntries(
          Object.entries(this._modules).map(([k, v]) => [k, v != null ? '✓' : '✗'])
        );
        console.group('[SplitView] Status');
        console.log('Pane active:    ', !!this._paneEl);
        console.log('Pane attached:  ', this._isPaneAttached());
        console.log('Split channel:  ', this._splitChannelId ?? '—');
        console.log('Saved channel:  ', this._settings?.activeChannelId ?? '—');
        console.log('Main channel:   ', this._getSelectedChannelId() ?? '—');
        console.log('Main guild:     ', this._getSelectedGuildId() ?? '—');
        console.log('Split guild:    ', this._getChannelGuildId(this._splitChannelId) ?? '—');
        console.log('Render mode:    ', this._renderMode);
        console.log('Pane mode:      ', this._settings?.paneMode ?? 'docked');
        console.log('Floating rect:  ', this._settings?.floatingRect ?? null);
        console.log('Raw saved:      ', this._readSavedSettings());
        console.log('Settings:       ', { ...this._settings });
        console.table(moduleStatus);
        console.groupEnd();
        return {
          pane: !!this._paneEl,
          paneAttached: this._isPaneAttached(),
          channelId: this._splitChannelId,
          activeChannelId: this._settings?.activeChannelId ?? null,
          selectedMainChannelId: this._getSelectedChannelId(),
          selectedMainGuildId: this._getSelectedGuildId(),
          splitGuildId: this._getChannelGuildId(this._splitChannelId),
          renderMode: this._renderMode,
          nativeRenderVariant: this._nativeRenderVariant,
          paneMode: this._settings?.paneMode ?? 'docked',
          floatingRect: this._settings?.floatingRect ?? null,
          savedSettings: this._readSavedSettings(),
          settings: { ...this._settings },
          modules: moduleStatus,
        };
      },

      open: (channelId) => this.open(channelId),

      // Native sidebar rendering is the product path. Real Discord threads are
      // preferred, but guild text/announcement channels are accepted so the
      // right-click channel workflow remains usable.
      // Re-runs module discovery first so fresh data is used.
      openNative: (channelId) => {
        if (!channelId) {
          const result = { ok: false, error: 'openNative requires a channelId or an active SplitView target.' };
          this._log('openNative(undefined):', result);
          return result;
        }
        this.discoverModules();

        const channel = this._getChannel(channelId);
        if (channel && !this.isSplitTargetChannel(channel)) {
          const result = { ok: false, error: 'SplitView accepts guild text/announcement channels and real Discord thread channel ids.' };
          this._renderMode = 'placeholder';
          this._toast('SplitView opens guild text channels and real Discord threads', 'warning');
          this._log(`openNative(${channelId}):`, result);
          return result;
        }

        this._splitChannelId = channelId;
        this._rememberActiveSplit(channelId);

        if (!this._paneEl && !this.createDockedPane()) return { ok: false, error: 'safe layout container not found' };

        if (this._paneTitle && channel) {
          const prefix = channel.type === 1 ? '@' : channel.type === 3 ? '' : '#';
          this._paneTitle.textContent = `${prefix}${channel.name ?? channelId}`;
        }

        const result = this._tryNativeRender(channelId, channel, true, this._nativeRenderVariant);
        this._applyDuplicateChannelMode('debug-openNative');
        if (!result.ok) {
          const diag = result.missing
            ? `Missing modules: ${result.missing.join(', ')}`
            : `Render error: ${result.error ?? 'unknown'}`;
          const name   = channel?.name ?? channelId;
          const prefix = channel?.type === 1 ? '@' : channel?.type === 3 ? '' : '#';
          this._renderPlaceholder(`${prefix}${name}`, 'Native render failed.', diag);
          this._scheduleNativeRenderRetry(channelId, channel, result);
        }

        this._log(`openNative(${channelId}):`, result);
        this._scheduleScrollToBottom('both', 'debug-openNative');
        return result;
      },

      openNativeVariant: (channelId, variant = 'sidebar') => {
        this._nativeRenderVariant = this._normalizeNativeVariant(variant);
        return api.openNative(channelId || this._splitChannelId || this._settings?.activeChannelId);
      },
      setNativeRenderVariant: (variant = 'sidebar') => {
        this._nativeRenderVariant = this._normalizeNativeVariant(variant);
        if (this._splitChannelId) return api.openNative(this._splitChannelId);
        return { nativeRenderVariant: this._nativeRenderVariant };
      },
      inspectPane: () => this._inspectPane(),

      close: () => this.close(),

      breakout: (channelId) => this.openBreakout(channelId || this._splitChannelId || this._settings?.activeChannelId),
      floatInDiscord: () => this.toggleFloatingMode(),
      openBreakout: (channelId) => this.openBreakout(channelId || this._splitChannelId || this._settings?.activeChannelId),
      closeBreakout: (channelIdOrWindowKey) => this.closeBreakout(channelIdOrWindowKey || this._splitChannelId || this._settings?.activeChannelId),
      closeAllBreakouts: () => this.closeAllBreakouts(),
      inspectBreakoutModules: () => this.inspectBreakoutModules(),
      activateBreakout: (channelIdOrWindowKey) => this._activateBreakout(channelIdOrWindowKey || this._splitChannelId || this._settings?.activeChannelId),
      inspectBreakoutFocus: () => ({
        ackBridgeInstalled: !!this._dispatcher,
        sidebarInputPatched: !!this._origSidebarInput,
        breakouts: Array.from(this._breakouts.values()),
      }),
      listBreakouts: () => Array.from(this._breakouts.values()),
      dock: () => {
        if (this._settings?.paneMode !== 'floating') return { paneMode: this._settings?.paneMode ?? 'docked' };
        return this.toggleFloatingMode();
      },
      setFloatingRect: (rect) => {
        this._persistFloatingRect(rect);
        this._settings.paneMode = 'floating';
        this._saveSettings();
        if (this._paneEl) this.destroyDockedPane();
        if (this._splitChannelId || this._settings.activeChannelId) this.open(this._splitChannelId || this._settings.activeChannelId);
        return { paneMode: this._settings.paneMode, floatingRect: this._settings.floatingRect, savedSettings: this._readSavedSettings() };
      },

      getSavedSettings: () => this._readSavedSettings(),
      forgetActiveSplit: () => {
        this.close();
        this._forgetActiveSplit();
        return { activeChannelId: this._settings?.activeChannelId ?? null, savedSettings: this._readSavedSettings() };
      },
      resetSettings: () => {
        this.close();
        this._settings = {
          currentWidth: DEFAULT_WIDTH,
          debug: false,
          activeChannelId: null,
          paneMode: 'docked',
          floatingRect: normalizeFloatingRect(null),
        };
        this._hasSavedFloatingRect = false;
        try { BdApi.Data.save(PLUGIN_NAME, SETTINGS_KEY, this._serializeSettings()); } catch (e) { this._dbg('BdApi reset save failed:', e.message); }
        try { this._getLocalStorage()?.removeItem?.(LOCAL_STORAGE_KEY); } catch (e) { this._dbg('localStorage reset failed:', e.message); }
        this._writeSessionActiveSplit(null);
        this._applyWidth(DEFAULT_WIDTH);
        return { reset: true, savedSettings: this._readSavedSettings() };
      },

      closeMemberList: () => this._closeMemberListIfOpen(),

      scrollBottom: (target = 'both') => {
        this._scheduleScrollToBottom(target, 'debug-scrollBottom');
        return { scheduled: true, target };
      },

      inspectTitlebarDragStrip: () => this._inspectTitlebarDragStrip(),
      syncTitlebarDragStrip: () => this._syncTitlebarDragStrip('debug-sync'),
      paintTitlebarDragStripProbe: () => this._setTitlebarDragStripProbe(true),
      clearTitlebarDragStripProbe: () => this._setTitlebarDragStripProbe(false),

      forceRemount: () => {
        this._scheduleRemount('debug-force-remount', true);
        return {
          scheduled: true,
          channelId: this._splitChannelId,
          activeChannelId: this._settings?.activeChannelId ?? null,
        };
      },

      setDebug: (enabled) => {
        this._settings.debug = !!enabled;
        this._saveSettings();
        this._log(`Debug mode: ${this._settings.debug}`);
      },

      getCrashLog: () => this._getCrashLog(),
      printCrashLog: () => {
        const log = this._getCrashLog();
        console.log('[SplitView] Crash log:', log);
        return log;
      },
      copyCrashLog: async () => {
        const text = this._formatCrashLog();
        await navigator.clipboard?.writeText?.(text);
        console.log('[SplitView] Crash log copied to clipboard');
        return { copied: true, bytes: text.length };
      },
      downloadCrashLog: () => {
        const text = this._formatCrashLog();
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `splitview-crash-log-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        return { downloaded: true, bytes: text.length };
      },
      clearCrashLog: () => {
        this._crashLog = [];
        try { this._getLocalStorage()?.removeItem?.(CRASH_LOG_KEY); } catch { /* ignore */ }
        return { cleared: true };
      },
      setAllowDuplicateChannelForDiagnostics: (enabled) => {
        this._allowDuplicateChannelForDiagnostics = !!enabled;
        this._recordCrashEvent('set-allow-duplicate-channel-for-diagnostics', { enabled: this._allowDuplicateChannelForDiagnostics });
        this._toast('Deprecated: same-channel SplitView now suppresses its duplicate composer by default', 'info');
        this._applyDuplicateChannelMode('debug-deprecated-diagnostic-toggle');
        return {
          allowDuplicateChannelForDiagnostics: this._allowDuplicateChannelForDiagnostics,
          note: 'Same-channel mode now keeps SplitView open and suppresses the split-pane composer by default.',
        };
      },

      discoverModules: () => {
        const result = this.discoverModules();
        console.log('[SplitView] Module discovery result:', result);
        return result;
      },
    };
    this._debugAPI = api;
    window.SplitViewDebug = api;
    this._dbg('SplitViewDebug installed on window');
  }

  _removeDebugAPI() {
    if (window.SplitViewDebug === this._debugAPI) delete window.SplitViewDebug;
    this._debugAPI = null;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  start() {
    try {
      this._stopped = false;
      this._settings = this._loadSettings();
      this.installStyles();
      this.discoverModules();
      this.patchContextMenus();
      this._installCrashDiagnostics();
      this._installDebugAPI();
      this._installLayoutPersistence();
      this._installSelectedChannelPersistence();
      window.addEventListener('resize', this._onWindowResize);
      this._restoreActiveSplit();
      this._log(`Started v${PLUGIN_VERSION} canonical slash-command baseline`);
    } catch (e) {
      this._err('start() error:', e);
      this._toast('Failed to start; see console', 'error');
    }
  }

  stop() {
    try {
      this._stopped = true;
      this._removeLayoutPersistence();
      this._clearDeferredTimers();
      this._removeSelectedChannelPersistence();
      window.removeEventListener('resize', this._onWindowResize);
      this._cancelResize();
      this._cancelFloatingResize();
      this._renderMode = 'none';
      this.closeAllBreakouts();
      this._removeBreakoutAckBridge();
      this._restoreBreakoutInputPatches();
      this.destroyDockedPane();
      this.unpatchContextMenus();
      try { BdApi.Patcher?.unpatchAll?.(PLUGIN_NAME); } catch { /* ignore if patcher not used yet */ }
      this.removeStyles();
      this._removeDebugAPI();
      this._removeCrashDiagnostics();
      this._modules = {};
      this._SsvErrorBoundary = null;
      this._log('Stopped');
    } catch (e) {
      this._err('stop() error:', e);
    }
  }
};
