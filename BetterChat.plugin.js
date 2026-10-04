/**
 * @name BetterChat
 * @author BetterChat Contributors
 * @description BetterChat for Discord — pin a Discord channel/thread alongside your main view.
 * @version 0.1.227
 * @source https://github.com/DylDigitals/Splitview-BD
 * @updateUrl https://raw.githubusercontent.com/DylDigitals/Splitview-BD/main/BetterChat.plugin.js
 */

// Keep the legacy storage/style namespace so existing installs retain their state.
const PLUGIN_NAME = 'SplitView';
const PLUGIN_VERSION = '0.1.227';
const SETTINGS_KEY = 'settings';
const LOCAL_STORAGE_KEY = `${PLUGIN_NAME}:settings`;
const SESSION_ACTIVE_KEY = `${PLUGIN_NAME}:activeChannelId`;
const CRASH_LOG_KEY = `${PLUGIN_NAME}:crashLog`;
const MAX_CRASH_LOG_EVENTS = 160;
const DEFAULT_WIDTH = 480;
const MIN_WIDTH = 280;
const MIN_FLOATING_HEIGHT = 360;
const DEFAULT_FLOATING_RECT = { left: 96, top: 72, width: 520, height: 680 };

// Product contract: BetterChat piggybacks on Discord's existing routing model.
// Primary target is real threads, but the context-menu affordance must also work
// from normal guild text/announcement channels because that is where users start.
// DMs, group DMs, forums, voice, and synthetic panes remain out of scope.
const SPLIT_TARGET_TYPES = new Set([0, 5, 10, 11, 12]);
const THREAD_TYPES = new Set([10, 11, 12]);
const PIN_ICON_PATH = 'M16 2 22 8l-2 2-2-1-4 4 1 3-2 2-4-4-6 7-1-1 7-6-4-4 2-2 3 1 4-4-1-2z';

const isDiscordId = value => typeof value === 'string' && /^[0-9]{1,20}$/.test(value);
function normalizeRememberedSplits(raw) {
  const result = Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const [accountId, guilds] of Object.entries(raw)) {
    if (!isDiscordId(accountId) || !guilds || typeof guilds !== 'object' || Array.isArray(guilds)) continue;
    const targets = Object.create(null);
    for (const [guildId, channelId] of Object.entries(guilds)) {
      if (isDiscordId(guildId) && isDiscordId(channelId)) targets[guildId] = channelId;
    }
    result[accountId] = targets;
  }
  return result;
}

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

module.exports = class BetterChat {
  constructor() {
    this._settings = null;
    this._modules = {};
    this._unpatchers = [];
    this._splitChannelId = null;
    this._paneEl = null;
    this._paneTitle = null;
    this._paneBody = null;
    this._dockedResizeObserver = null;
    this._dockedObservedHost = null;
    this._dockedObservedHeader = null;
    this._dockedGeometryRaf = null;
    this._resizing = false;
    this._compactToolbar = null;
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
    this._openEffectsEpoch = 0;
    this._selectedChannelListener = null;
    this._persistenceStores = [];
    this._accountId = undefined;
    this._splitGuildId = null;
    this._restoreKey = null;
    this._lastMainChannelId = null;
    this._lastMainGuildId = null;
    this._contextChannelCache = new Map();
    this._breakouts = new Map();
    this._breakoutCounter = 0;
    this._dispatcher = null;
    this._onBreakoutMessage = null;
    this._attachmentScanBridge = null;
    this._attachmentScanWarned = false;
    this._releaseSplitAttachmentScan = null;
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
      const saved = value ? JSON.parse(value) : null;
      const accountId = this._getCurrentAccountId();
      return accountId && saved?.accountId === accountId && isDiscordId(saved.channelId) ? saved.channelId : null;
    } catch (e) {
      this._dbg('sessionStorage active split load failed:', e.message);
      return null;
    }
  }

  _writeSessionActiveSplit(channelId) {
    try {
      const session = this._getSessionStorage();
      if (!session) return;
      const accountId = this._getCurrentAccountId();
      if (isDiscordId(channelId) && accountId) session.setItem(SESSION_ACTIVE_KEY, JSON.stringify({ accountId, channelId }));
      else session.removeItem(SESSION_ACTIVE_KEY);
    } catch (e) {
      this._dbg('sessionStorage active split save failed:', e.message);
    }
  }

  _serializeSettings() {
    return {
      currentWidth: this._settings.currentWidth,
      debug: this._settings.debug,
      hideParentChannelInSplit: this._settings.hideParentChannelInSplit === true,
      rememberSplitPerServer: this._settings.rememberSplitPerServer === true,
      rememberedSplits: normalizeRememberedSplits(this._settings.rememberedSplits),
      // Default-off targets remain session-only and account-bound.
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
      hideParentChannelInSplit: saved.hideParentChannelInSplit === true,
      rememberSplitPerServer: saved.rememberSplitPerServer === true,
      rememberedSplits: normalizeRememberedSplits(saved.rememberedSplits),
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

  getSettingsPanel() {
    this._settings ??= this._loadSettings();
    return BdApi.UI.buildSettingsPanel({
      settings: [{ type: 'switch', id: 'hideParentChannelInSplit',
        name: 'Hide parent channel in split-mode headers',
        note: 'Hide the parent breadcrumb, not the selected thread title or Threads control.',
        value: this._settings.hideParentChannelInSplit === true },
      { type: 'switch', id: 'rememberSplitPerServer', name: 'Remember split chat per server',
        note: 'Restore this account’s split for each server, including after restarting Discord. Turning off clears this account’s remembered splits without closing the visible pane.',
        value: this._settings.rememberSplitPerServer === true }],
      onChange: (_category, id, value) => {
        if (id === 'rememberSplitPerServer' && typeof value === 'boolean') {
          this._syncPersistenceAccount();
          this._settings.rememberSplitPerServer = value;
          this._cancelSplitRestore();
          if (!value) {
            if (this._accountId) delete this._settings.rememberedSplits[this._accountId];
            this._settings.activeChannelId = null;
            this._writeSessionActiveSplit(null);
          } else if (this._splitChannelId) this._rememberActiveSplit(this._splitChannelId);
          this._saveSettings();
          return;
        }
        if (id !== 'hideParentChannelInSplit' || typeof value !== 'boolean') return;
        this._settings.hideParentChannelInSplit = value;
        this._saveSettings();
        this._syncHeaderTitles();
        this._positionSplitSearch();
        for (const record of this._breakouts.values()) record.refreshHeader?.();
      },
    });
  }

  _scheduleFloatingRectSave() {
    if (this._floatingSaveTimer) return;
    this._floatingSaveTimer = window.setTimeout(() => {
      this._floatingSaveTimer = null;
      if (!this._stopped && this._settings?.paneMode === 'floating') this._persistFloatingRect(this._settings.floatingRect);
    }, 250);
  }

  // ─── Logging ─────────────────────────────────────────────────────────────────

  _log(...a) { console.log('[BetterChat]', ...a); this._recordCrashEvent?.('log', { args: this._stringifyLogArgs(a) }); }
  _dbg(...a) { if (this._settings?.debug) console.log('[BetterChat:dbg]', ...a); this._recordCrashEvent?.('debug', { args: this._stringifyLogArgs(a) }); }
  _err(...a) { console.error('[BetterChat]', ...a); this._recordCrashEvent?.('error', { args: this._stringifyLogArgs(a) }); }

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
    try { BdApi.UI?.showToast?.(`[BetterChat] ${msg}`, { type }); } catch { /* ignore */ }
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
    tryGet('SelectedGuildStore',   () => W.getStore?.('SelectedGuildStore'));
    tryGet('UserStore',            () => W.getStore?.('UserStore'));
    tryGet('PermissionStore',      () => W.getStore?.('PermissionStore'));
    tryGet('Permissions',          () => W.getModule(F.byKeys('VIEW_CHANNEL', 'SEND_MESSAGES'), { searchExports: true }));

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

    // MiniChat-style external popout modules. These are optional: BetterChat stays
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

  // ─── Optional native attachment scanning ─────────────────────────────────────

  _warnAttachmentScan() {
    if (this._attachmentScanWarned) return;
    this._attachmentScanWarned = true;
    // No message data or persistent diagnostics: this adapter is optional.
    console.warn('[BetterChat] Optional native attachment scan bridge unavailable; chat remains native.');
  }

  _retainAttachmentScanTarget(channelId) {
    const noop = () => {};
    if (this._stopped || typeof channelId !== 'string' || !channelId) return noop;
    let bridge = this._attachmentScanBridge;
    if (!bridge) {
      try {
        const W = BdApi.Webpack;
        // This is a service instance, NOT a Flux store. Fail closed on source
        // drift rather than guessing a module ID or changing native routing.
        const service = W?.getModule(m => {
          try {
            const actions = m?.actions;
            if (!['SIDEBAR_VIEW_CHANNEL', 'MESSAGE_CREATE', 'MESSAGE_UPDATE',
              'LOAD_MESSAGES_SUCCESS', 'LOAD_PINNED_MESSAGES_SUCCESS',
              'LOAD_ARCHIVED_THREADS_SUCCESS'].every(key => typeof actions?.[key] === 'function')) return false;
            const source = Function.prototype.toString.call(actions.MESSAGE_CREATE);
            return ['getCurrentSidebarChannelId', 'optimistic', 'isPushNotification', 'jitter']
              .every(token => source.includes(token));
          } catch { return false; }
        }, { searchExports: true });
        const isDispatcher = m => typeof m?.subscribe === 'function' &&
          typeof m?.unsubscribe === 'function' && typeof m?.dispatch === 'function';
        const userDispatcher = this._modules.UserStore?._dispatcher;
        const dispatcher = isDispatcher(userDispatcher) ? userDispatcher : W?.getModule(isDispatcher, { searchExports: true });
        if (!service || !dispatcher) { this._warnAttachmentScan(); return noop; }
        bridge = { service, dispatcher, targets: new Map(), subscriptions: [] };
        this._attachmentScanBridge = bridge;
        for (const type of ['MESSAGE_CREATE', 'MESSAGE_UPDATE', 'LOAD_MESSAGES_SUCCESS']) {
          const listener = event => {
            if (this._stopped || this._attachmentScanBridge !== bridge) return;
            if (type === 'MESSAGE_CREATE' && (event?.optimistic || event?.isPushNotification)) return;
            const id = event?.channelId ?? event?.message?.channel_id;
            this._queueAttachmentScan(bridge, id);
          };
          // Record before subscribing so a partially successful subscribe can
          // still be rolled back if the dispatcher throws.
          bridge.subscriptions.push([type, listener]);
          dispatcher.subscribe(type, listener);
        }
      } catch {
        this._removeAttachmentScanBridge();
        this._warnAttachmentScan();
        return noop;
      }
    }
    let target = bridge.targets.get(channelId);
    if (!target) {
      target = { refs: 0, queued: false };
      bridge.targets.set(channelId, target);
      this._queueAttachmentScan(bridge, channelId);
    }
    target.refs++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--target.refs > 0) return;
      if (bridge.targets.get(channelId) === target) bridge.targets.delete(channelId);
      if (this._attachmentScanBridge === bridge && !bridge.targets.size) this._removeAttachmentScanBridge();
    };
  }

  _queueAttachmentScan(bridge, channelId) {
    const target = bridge.targets.get(channelId);
    if (!target || target.queued) return;
    target.queued = true;
    // Run after Flux store processing, and coalesce a burst per active channel.
    queueMicrotask(() => {
      if (this._stopped || this._attachmentScanBridge !== bridge || bridge.targets.get(channelId) !== target) return;
      target.queued = false;
      try {
        // Invoke ONLY the scoped service handler. Global dispatch would mutate
        // sidebar routing. Native settings, scan requests, dedup and timers stay
        // owned by Discord; never rewrite attachment flags or signed URLs.
        bridge.service.actions.SIDEBAR_VIEW_CHANNEL({ channelId });
      } catch { this._warnAttachmentScan(); }
    });
  }

  _removeAttachmentScanBridge() {
    const bridge = this._attachmentScanBridge;
    this._attachmentScanBridge = null;
    if (!bridge) return;
    bridge.targets.clear(); // invalidates queued work even on same-channel reopen
    for (const [type, listener] of bridge.subscriptions) {
      try { bridge.dispatcher.unsubscribe(type, listener); } catch { this._warnAttachmentScan(); }
    }
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

      /* Keep the native virtual scroller measured while removing the pane from
         the layout. display:none reports a zero viewport and loses its anchor. */
      .ssv-pane[data-ssv-suspended="true"] {
        position: fixed !important;
        left: -100000px !important;
        top: 0 !important;
        width: var(--ssv-suspended-width) !important;
        height: var(--ssv-suspended-height) !important;
        max-width: none;
        box-sizing: border-box;
        visibility: hidden;
        pointer-events: none;
      }



      .ssv-pane:not(.ssv-floating) {
        box-sizing: border-box;
        max-width: none; /* bounded by the verified host, not the viewport */
        min-height: 0;
        align-self: stretch;
        background: var(--background-base-low, var(--background-primary, #313338));
        border: 1px solid var(--border-subtle, var(--background-modifier-accent, #3f4147));
        border-radius: var(--radius-sm, 8px);
      }

      .ssv-pane:not(.ssv-floating) > .ssv-pane-inner {
        min-width: 0;
        margin-left: 0; /* the 4px resize target overlays one divider, not a gutter */
        padding-top: max(0px, calc(var(--ssv-header-offset, 0px) - 1px));
      }

      .ssv-pane:not(.ssv-floating) .ssv-pane-header {
        box-sizing: border-box;
        height: var(--ssv-header-height, 49px);
        min-width: 0;
        padding: 0 8px 0 16px;
        background: var(--background-base-low, var(--background-primary, #313338));
        border-bottom-color: var(--border-subtle, var(--background-modifier-accent, #3f4147));
        font-family: var(--font-primary, sans-serif);
      }

      .ssv-pane:not(.ssv-floating) .ssv-pane-header-title { min-width: 0; }
      .ssv-pane:not(.ssv-floating) .ssv-pane-header-btn { width: 32px; height: 32px; }
      .ssv-pane .ssv-pane-header-btn:focus-visible {
        outline: 2px solid var(--focus-primary, #00a8fc);
        outline-offset: 2px;
      }

      /* Grid changes visual order only; React retains all native node ownership.
         Invisible native actions overlap More's cell, retaining real anchors
         for Discord popouts instead of display:none or offscreen/0,0 controls. */
      [data-ssv-toolbar="row"] {
        display: grid !important;
        grid-template-columns: 32px minmax(0, 1fr) 32px 32px;
        grid-template-rows: 32px;
        align-items: center;
        column-gap: 8px;
      }
      [data-ssv-toolbar="controls"] { display: contents !important; }
      [data-ssv-toolbar="title"] { grid-area: 1 / 2; min-width: 0; max-width: 100%; overflow: hidden; }
      [data-ssv-toolbar="title"] [class*="titleWrapper_"],
      [data-ssv-toolbar="title"] h1, [data-ssv-toolbar="title"] h2 {
        min-width: 0; max-width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
      }
      [data-ssv-toolbar="title"] [class*="titleWrapper_"] { flex: 0 1 auto; max-width: 28ch; }
      [data-ssv-toolbar="title"] h1, [data-ssv-toolbar="title"] h2 { display: block; }
      [data-ssv-parent-hidden="true"] { display: none !important; }
      [data-ssv-toolbar="title"]::after { display: none; }
      [data-ssv-toolbar="search"] { position: fixed !important; left: var(--ssv-search-x); top: var(--ssv-search-y); width: var(--ssv-search-width) !important; height: 32px; min-width: 0 !important; margin: 0 !important; display: flex; align-items: center; z-index: 101; }
      .ssv-pane-header-search-slot { flex: 0 1 180px; min-width: 96px; height: 32px; }
      .ssv-floating .ssv-pane-header-search-slot { display: none; }
      .ssv-pane-header-controls { display: flex; flex: 0 0 auto; gap: 4px; margin-left: auto; }
      .ssv-header-unavailable { display: flex; gap: 4px; }
      .ssv-pane-header-controls[data-ssv-ready="true"] .ssv-header-unavailable { display: none; }
      .ssv-pane-header-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      .ssv-pane-header-parent { color: var(--text-muted); }
      [data-ssv-toolbar="search"] [class*="search_"] { width: 100% !important; min-width: 0 !important; max-width: 100%; }
      [data-ssv-toolbar="search"] [class*="searchBar_"] { width: 100% !important; box-sizing: border-box; }
      [data-ssv-toolbar="threads"] { grid-area: 1 / 1; margin: 0 !important; }
      [data-ssv-thread-inline="true"] { grid-template-columns: minmax(0, 1fr) 32px 32px; }
      [data-ssv-thread-inline="true"] [data-ssv-toolbar="title"] { grid-area: 1 / 1; }
      [data-ssv-toolbar="pins"] { grid-area: 1 / -3 / auto / -2; margin: 0 !important; }
      [data-ssv-toolbar="thread-slot"] { visibility: hidden; }
      [data-ssv-thread-inline="true"] [data-ssv-toolbar="threads"] {
        position: fixed; left: var(--ssv-threads-x); top: var(--ssv-threads-y);
        width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; z-index: 101;
      }
      [data-ssv-toolbar="source"], [data-ssv-toolbar="more"] {
        grid-area: 1 / -2 / auto / -1;
        width: 32px !important;
        height: 32px !important;
        margin: 0 !important;
      }
      [data-ssv-toolbar="source"] { opacity: 0 !important; pointer-events: none !important; }
      [data-ssv-toolbar="more"] {
        padding: 0; border: 0; border-radius: 4px; background: transparent;
        color: var(--interactive-normal, #b5bac1); cursor: pointer;
        font: 24px/1 var(--font-primary, sans-serif);
      }
      [data-ssv-toolbar="more"]:hover { color: var(--interactive-hover, #dbdee1); background: var(--background-modifier-hover); }
      [data-ssv-toolbar="more"]:focus-visible { outline: 2px solid var(--focus-primary, #00a8fc); outline-offset: 2px; }

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

      section.ssv-breakout-header { display: block; padding: 0 8px; }
      section.ssv-breakout-header > div { width: 100%; min-width: 0; height: 48px; }
      .ssv-breakout-header [class*="children_"] { min-width: 0; flex: 1 1 auto; }
      .ssv-breakout-header [class*="toolbar_"] { flex: 0 0 auto; gap: 4px; }
      .ssv-breakout-header [class*="searchBar_"] { width: 130px; }
      .ssv-breakout-root .ssv-pane-header-btn { flex: 0 0 auto; width: 32px; height: 32px; border: 0; padding: 0; border-radius: 4px; background: transparent; color: var(--interactive-normal); cursor: pointer; font-size: 20px; }
      .ssv-breakout-root .ssv-pane-header-btn:hover { background: var(--background-modifier-hover); }
      .ssv-breakout-header [class*="children_"] { gap: 8px; }
      .ssv-breakout-search { width: 150px; min-width: 80px; height: 28px; border: 1px solid var(--background-modifier-accent); border-radius: 6px; padding: 0 8px; color: var(--text-normal); background: var(--background-tertiary); }
      .ssv-breakout-search-results {
        position: absolute; top: 48px; right: 0; bottom: 0; z-index: 5;
        width: min(440px, 100%); display: flex; flex-direction: column;
        background: var(--background-secondary); box-shadow: -3px 0 12px #0004;
      }
      .ssv-breakout-search-results > :last-child { flex: 1; min-height: 0; width: 100%; }

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
        flex: 1 1 120px;
        min-width: 40px;
        max-width: 28ch;
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
        width: 32px;
        height: 32px;
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
        content: 'Same channel — BetterChat keeps its own scroll; send from the focused main composer';
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

  _isNativeLayoutElement(el) {
    if (!(el instanceof HTMLElement) || el.ownerDocument !== document || !el.isConnected) return false;
    if (el.closest('[data-ssv], .ssv-breakout-root, [role="dialog"], [role="menu"], [aria-modal="true"], [class*="layerContainer"], [class*="modal"], [class*="popout"], [class*="standardSidebarView"]')) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }

  _hasGridArea(el, name) {
    // Chromium can serialize a named area as either "page" or four longhands.
    const parts = getComputedStyle(el).gridArea?.split('/').map(part => part.trim());
    return !!parts?.length && parts.every(part => part === name);
  }

  _discoverDockedLayout() {
    const anchors = Array.from(document.querySelectorAll('[class*="chatContent"], [class*="chat-"][class*="content"], [class*="messagesWrapper"]'))
      .filter(el => this._isNativeLayoutElement(el));
    // chatContent and its messagesWrapper are one surface, not two panes.
    const surfaces = anchors.filter(el => !anchors.some(other => other !== el && other.contains(el)));
    const nodes = new Set();
    for (const anchor of surfaces) {
      for (let node = anchor.parentElement; node && node !== document.body; node = node.parentElement) {
        if (this._hasGridArea(node, 'page') || String(node.className).includes('page_')) nodes.add(node);
      }
    }
    const candidates = Array.from(nodes, host => {
      const style = getComputedStyle(host);
      const rect = host.getBoundingClientRect();
      let reason = null;
      if (!this._isNativeLayoutElement(host)) reason = 'not-native-content';
      else if (!this._hasGridArea(host, 'page') || !getComputedStyle(host.parentElement).display.includes('grid')) reason = 'not-grid-page';
      else if (style.display !== 'flex' || style.flexDirection !== 'row' || ['fixed', 'absolute'].includes(style.position)) reason = 'not-content-row';
      else if (!surfaces.length || !surfaces.every(anchor => host.contains(anchor))) reason = 'incomplete-native-row';
      // The bar is a sibling in a grid ancestor, not a fixed y/height heuristic.
      // A hidden OS/system bar is not a fabricated in-client title bar.
      const bars = new Set();
      for (let node = host; node && node !== document.body; node = node.parentElement) {
        for (const child of node.children) {
          if (this._isNativeLayoutElement(child) && this._hasGridArea(child, 'titleBar')) bars.add(child);
        }
      }
      if (!reason && (bars.size > 1 || Array.from(bars).some(bar => host.contains(bar) || rect.top < bar.getBoundingClientRect().bottom - 1))) reason = 'unsafe-titlebar-boundary';
      return { host, globalBar: bars.size === 1 ? Array.from(bars)[0] : null, reason };
    });
    const valid = candidates.filter(candidate => !candidate.reason);
    const chosen = valid.length === 1 ? valid[0] : null;
    const nativeRow = chosen && Array.from(chosen.host.children).find(row =>
      this._isNativeLayoutElement(row) && surfaces.every(surface => row.contains(surface)) &&
      getComputedStyle(row).display === 'flex' && getComputedStyle(row).flexDirection === 'row');
    return {
      layout: chosen ? { host: chosen.host, nativeRow, globalBar: chosen.globalBar, mainHeader: this._findNativeHeader(chosen.host, surfaces[0]), surfaces, surfaceCount: surfaces.length, ...this._dockedSidebars(chosen.host, surfaces) } : null,
      candidates,
      reason: chosen ? null : valid.length > 1 ? 'ambiguous-page-host' : surfaces.length ? 'no-safe-page-host' : 'no-native-chat',
    };
  }

  _findNativeHeader(host, anchor) {
    // Measure the outer toolbar SECTION, never its 32px inner icon row.
    for (let scope = anchor?.parentElement; scope; scope = scope.parentElement) {
      const headers = Array.from(scope.querySelectorAll('section')).filter(section => {
        if (!this._isNativeLayoutElement(section) || section.contains(anchor) || anchor.contains(section)) return false;
        if (!section.querySelector('[class*="toolbar_"], [role="toolbar"]')) return false;
        const r = section.getBoundingClientRect(), a = anchor.getBoundingClientRect();
        return r.top >= host.getBoundingClientRect().top && r.bottom <= a.top + 1 && r.left < a.right && r.right > a.left;
      });
      if (headers.length === 1) return headers[0];
      if (headers.length > 1 || scope === host) break;
    }
    return null;
  }

  _resolveDockedLayout() {
    return this._discoverDockedLayout().layout;
  }

  _findLayoutContainer() {
    return this._resolveDockedLayout()?.host ?? null;
  }

  _dockedSidebars(host, surfaces) {
    const sidebars = Array.from(host.querySelectorAll('[class*="membersWrap"], [class*="searchResultsWrap"]'))
      .filter(el => this._isNativeLayoutElement(el));
    const members = sidebars.filter(el => String(el.className).includes('membersWrap'));
    // Only the one native members lane paired with a chat surface is movable.
    // Multiple candidates, nested sidebar lookalikes and transformed fixed-position
    // containing blocks are ambiguous: leave native DOM/styles alone and suspend.
    let sidebarsSafe = members.length <= 1 && !sidebars.some(el =>
      sidebars.some(other => other !== el && other.contains(el)) || surfaces.some(surface => el.contains(surface)));
    const member = members.length === 1 ? members[0] : null;
    if (member) {
      const parent = member.parentElement, style = getComputedStyle(parent);
      sidebarsSafe &&= style.display === 'flex' && style.flexDirection === 'row' &&
        surfaces.some(surface => parent.contains(surface));
      for (let node = parent; node && sidebarsSafe; node = node.parentElement) {
        const s = getComputedStyle(node);
        if ([s.transform, s.perspective, s.filter, s.backdropFilter].some(value => value && value !== 'none') ||
            /paint|layout|strict|content/.test(s.contain || '') || /transform|perspective|filter/.test(s.willChange || '')) sidebarsSafe = false;
      }
    }
    return { sidebars, member, sidebarsSafe };
  }

  _dockedNativeThreads(layout) {
    return Array.from(layout.host.querySelectorAll('[class*="chatLayerWrapper"]')).flatMap(wrapper => {
      const surfaces = layout.surfaces.filter(surface => wrapper.contains(surface));
      // Native overlay mode has a zero-width absolute wrapper with a visible
      // full-width chat child. Visibility belongs to the chat, not its wrapper.
      if (!surfaces.length) return [];
      const frames = surfaces.map(surface => {
        let width = surface.getBoundingClientRect().width;
        for (let node = surface.parentElement; node && node !== wrapper; node = node.parentElement) {
          width = Math.max(width, node.getBoundingClientRect().width);
        }
        return width;
      });
      const width = Math.max(wrapper.getBoundingClientRect().width, ...frames);
      const style = getComputedStyle(wrapper), row = layout.nativeRow;
      let gap = Math.max(0, parseFloat(style.marginLeft) || 0, parseFloat(style.marginRight) || 0,
        row ? parseFloat(getComputedStyle(row).columnGap) || 0 : 0);
      const main = layout.surfaces.find(surface => !wrapper.contains(surface));
      let mainFrame = main;
      while (mainFrame?.parentElement && mainFrame.parentElement !== row && mainFrame.parentElement !== layout.host) mainFrame = mainFrame.parentElement;
      if (mainFrame && row?.contains(mainFrame)) {
        // Discord can reserve the absolute preview with main-chat margin rather
        // than flex gap. Measure that reservation, never a historical 450/480px.
        gap = Math.max(gap, (parseFloat(getComputedStyle(mainFrame).marginRight) || 0) - width);
        const r = wrapper.getBoundingClientRect(), m = mainFrame.getBoundingClientRect();
        if (r.width > 0 && wrapper.offsetParent === row && r.right <= row.getBoundingClientRect().right + 1) gap = Math.max(gap, r.left - m.right);
      }
      const safe = row?.contains(wrapper) && style.position !== 'fixed' &&
        (style.position !== 'absolute' || wrapper.offsetParent === layout.host || wrapper.offsetParent === row);
      return [{ wrapper, width, gap, safe }];
    });
  }

  _dockedWidth(layout) {
    if (!layout || !layout.sidebarsSafe) return null;
    const conflict = this._dockedMemberConflict;
    if (conflict?.host === layout.host && conflict.member === layout.member && conflict.pane === this._paneEl) return null;
    // Measure native panels, not their historical/default widths. The owned member
    // lane is border-box so measuring it again cannot grow its width every pass.
    const sidebarWidth = layout.sidebars.reduce((sum, el) => {
      const style = getComputedStyle(el);
      return sum + el.getBoundingClientRect().width + (parseFloat(style.marginLeft) || 0) + (parseFloat(style.marginRight) || 0);
    }, 0);
    const width = layout.host.clientWidth - sidebarWidth;
    // Preserve the preferred width while native panels temporarily consume space.
    const threads = this._dockedNativeThreads(layout);
    if (threads.some(thread => !thread.safe)) return null;
    // Budget against the full host, never the already-shrunken native row or the
    // visible split. Hiding the split therefore cannot immediately reopen it.
    const nativeWidth = Math.max(MIN_WIDTH * layout.surfaceCount,
      MIN_WIDTH + threads.reduce((sum, thread) => sum + thread.width + thread.gap, 0));
    const cap = Math.floor(Math.min(width - nativeWidth, layout.surfaceCount >= 2 ? width / 3 : Infinity));
    if (cap < MIN_WIDTH) return null;
    const preferred = Number.isFinite(this._settings?.currentWidth) ? this._settings.currentWidth : DEFAULT_WIDTH;
    return Math.max(MIN_WIDTH, Math.min(preferred, cap));
  }

  _syncDockedMembers(layout) {
    const member = layout?.member, pane = this._paneEl;
    let owned = this._dockedMembers;
    if (owned && (owned.host !== layout?.host || owned.member !== member || owned.parent !== member?.parentElement || owned.pane !== pane)) {
      this._restoreDockedMembers(false); owned = null;
    }
    if (!member) return true;
    if (owned?.styles.some(entry => entry.el.style.getPropertyValue(entry.name) !== entry.written ||
        entry.el.style.getPropertyPriority(entry.name) !== '')) {
      // A later Discord/theme write wins. Stay suspended for this exact lane rather
      // than reacquiring and overwriting it on the next ResizeObserver delivery.
      this._dockedMemberConflict = { host: layout.host, member, pane };
      this._restoreDockedMembers(false);
      return false;
    }
    const host = layout.host.getBoundingClientRect(), top = member.parentElement.getBoundingClientRect().top;
    const width = member.getBoundingClientRect().width;
    const values = [
      [member, 'position', 'fixed'], [member, 'left', `${host.right - width}px`],
      [member, 'top', `${top}px`], [member, 'width', `${width}px`],
      [member, 'height', `${Math.max(0, host.bottom - top)}px`], [member, 'box-sizing', 'border-box'],
      [pane, 'margin-right', `${width}px`],
    ];
    if (!owned) {
      owned = this._dockedMembers = { host: layout.host, member, parent: member.parentElement, pane,
        styles: values.map(([el, name]) => ({ el, name, value: el.style.getPropertyValue(name), priority: el.style.getPropertyPriority(name) })) };
    }
    values.forEach(([el, name, value], i) => {
      const entry = owned.styles[i];
      if (el.style.getPropertyValue(name) !== value || el.style.getPropertyPriority(name) !== '') el.style.setProperty(name, value);
      entry.written = value;
    });
    return true;
  }

  _restoreDockedMembers(clearConflict = true) {
    const owned = this._dockedMembers;
    this._dockedMembers = null;
    if (clearConflict) this._dockedMemberConflict = null;
    for (const entry of owned?.styles || []) {
      const style = entry.el.style;
      if (style.getPropertyValue(entry.name) !== entry.written || style.getPropertyPriority(entry.name) !== '') continue;
      if (entry.value) style.setProperty(entry.name, entry.value, entry.priority);
      else style.removeProperty(entry.name);
    }
  }

  _applyDockedLayout(container = null) {
    if (this._stopped || this._settings?.paneMode === 'floating' || !this._paneEl) {
      this._restoreDockedMembers();
      this._restoreCompactToolbar();
      return false;
    }
    const layout = this._resolveDockedLayout();
    if (!layout || (container && container !== layout.host) || this._paneEl.parentElement !== layout.host) {
      this._removeDockedGeometryObserver();
      this._restoreNativeRowPosition();
      this._restoreDockedMembers();
      this._restoreCompactToolbar();
      this._setDockedSuspended(true);
      return false;
    }
    let width = this._dockedWidth(layout);
    if (!this._syncDockedMembers(width === null ? null : layout)) width = null;
    this._syncNativeRowPosition(width === null ? null : layout);
    this._setDockedSuspended(width === null);
    this._syncCompactToolbar(width === null ? null : layout);
    if (width !== null) this._applyWidth(width);
    const r = layout.mainHeader?.getBoundingClientRect();
    // Include any native parent top border as space before the header, rather
    // than stretching the header itself. Both outer boundaries then line up.
    this._setPaneStyle('--ssv-header-offset', `${r ? Math.max(0, r.top - layout.host.getBoundingClientRect().top) : 0}px`);
    this._setPaneStyle('--ssv-header-height', `${r ? r.height : 49}px`);
    this._observeDockedGeometry(layout);
    this._positionSplitSearch();
    return width !== null;
  }

  // Native nodes stay in their React-owned parents. Only known English header
  // shapes opt in; unknown actions/localizations retain the untouched toolbar.
  _compactToolbarShape(layout) {
    const header = layout?.mainHeader;
    if (this._stopped || !this._splitChannelId || this._settings?.paneMode === 'floating' ||
        !this._paneEl?.isConnected || this._paneEl.parentElement !== layout?.host ||
        this._paneEl.getAttribute('data-ssv-suspended') === 'true' || this._paneEl.style.display === 'none' || !header || !this._isNativeLayoutElement(header)) return null;
    if (typeof BdApi.ContextMenu?.open !== 'function' || typeof BdApi.ContextMenu?.buildMenu !== 'function' ||
        typeof BdApi.ContextMenu?.close !== 'function' || typeof BdApi.React?.createElement !== 'function' ||
        typeof BdApi.React?.useEffect !== 'function') return null;
    const channelId = this._getSelectedChannelId(), channel = this._getChannel(channelId);
    if (!channelId || !channel?.guild_id || !SPLIT_TARGET_TYPES.has(channel.type)) return null;
    // Native results belong to the current guild. Cross-guild layouts retain
    // untouched native controls rather than presenting incorrectly scoped search.
    if (this._getChannel(this._splitChannelId)?.guild_id !== channel.guild_id) return null;
    const upper = Array.from(header.children).find(el => String(el.className).includes('upperContainer_'));
    if (!upper || upper.children.length !== 2) return null;
    const title = Array.from(upper.children).find(el => String(el.className).includes('children_'));
    const toolbar = Array.from(upper.children).find(el => String(el.className).includes('toolbar_'));
    if (!title || !toolbar) return null;
    let search = null, threads = null;
    const actions = [];
    const seen = new Set();
    for (const el of toolbar.children) {
      if (el === this._compactToolbar?.button) continue;
      const label = el.getAttribute('aria-label');
      if (el.matches('button, [role="button"]')) {
        let key;
        if (label === 'Threads') { if (threads) return null; threads = el; continue; }
        if (label === 'Notification Settings') key = 'notifications';
        else if (label === 'Pinned Messages') key = 'pins';
        else if (label === 'Show Member List' || label === 'Hide Member List') key = 'members';
        else if (label === 'More' && THREAD_TYPES.has(channel.type)) key = 'thread';
        if (!key || seen.has(key)) return null;
        seen.add(key); actions.push({ key, el, label });
      } else if (!search && /(?:^|\s)search__/.test(String(el.className)) && el.querySelector('[class*="search_"]')) {
        search = el;
      } else return null;
    }
    if (!search || !seen.has('notifications') || !seen.has('pins') || !seen.has('members')) return null;
    // In thread breadcrumbs the second channel icon is decoration, not an action.
    // Keep its space and put the existing native Threads button over that slot.
    const icons = Array.from(title.children).filter(el => String(el.className).includes('channelIcon_'));
    const threadSlot = threads && THREAD_TYPES.has(channel.type) && icons.length === 2 &&
      !icons[1].matches('button, [role="button"]') && icons[1].querySelector('svg[aria-hidden="true"]') ? icons[1] : null;
    return { header, upper, title, toolbar, search, threads, threadSlot, actions, channelId, splitChannelId: this._splitChannelId };
  }

  _syncCompactToolbar(layout) {
    const shape = this._compactToolbarShape(layout);
    const old = this._compactToolbar;
    const same = shape && old && ['header', 'upper', 'title', 'toolbar', 'search', 'threads', 'threadSlot', 'channelId', 'splitChannelId'].every(k => shape[k] === old[k]) &&
      shape.actions.length === old.actions.length && shape.actions.every((a, i) => a.el === old.actions[i].el && a.label === old.actions[i].label);
    if (same && old.button.parentElement === shape.toolbar) {
      this._syncHeaderTitles();
      this._syncSplitHeaderControls(old);
      return;
    }
    this._restoreCompactToolbar();
    if (!shape) return;
    const marks = [[shape.upper, 'row'], [shape.title, 'title'], [shape.toolbar, 'controls'], [shape.search, 'search']];
    if (shape.threads) marks.push([shape.threads, 'threads']);
    if (shape.threadSlot) marks.push([shape.threadSlot, 'thread-slot']);
    shape.actions.forEach(a => marks.push([a.el, a.key === 'pins' ? 'pins' : 'source']));
    if (marks.some(([el]) => el.getAttribute('data-ssv-toolbar') !== null)) return; // foreign ownership
    if (!this._installSplitSearchScope()) return;
    const state = this._compactToolbar = { ...shape, owned: [], observer: null, frame: null, timer: null, menuOpen: false, handingOff: false };
    const own = (el, name, value) => {
      state.owned.push({ el, name, before: el.getAttribute(name), value });
      el.setAttribute(name, value);
    };
    marks.forEach(([el, value]) => own(el, 'data-ssv-toolbar', value));
    if (shape.threadSlot) own(shape.upper, 'data-ssv-thread-inline', 'true');
    for (const { el } of shape.actions.filter(a => a.key !== 'pins')) {
      own(el, 'tabindex', '-1'); own(el, 'aria-hidden', 'true');
    }
    const button = state.button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-ssv-toolbar', 'more');
    button.setAttribute('aria-label', 'More');
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.title = 'More channel actions'; button.textContent = '⋯';
    button.addEventListener('click', event => this._openCompactToolbarMenu(state, event));
    button.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); this._openCompactToolbarMenu(state, event); }
      if (event.key === 'Escape' && state.menuOpen) { event.preventDefault(); BdApi.ContextMenu.close(); }
      // Enter/Space use the native button click, not a second synthetic action.
    });
    shape.toolbar.appendChild(button);
    this._syncHeaderTitles();
    this._syncSplitHeaderControls(state);
    this._positionThreadsButton();
    this._positionSplitSearch();
    if (typeof MutationObserver === 'function') {
      state.observer = new MutationObserver(() => {
        if (this._compactToolbar !== state || state.frame !== null) return;
        state.frame = window.requestAnimationFrame(() => {
          state.frame = null;
          if (this._compactToolbar === state) this._syncCompactToolbar(this._resolveDockedLayout());
        });
      });
      state.observer.observe(shape.header, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['aria-label', 'aria-disabled', 'disabled'] });
    }
  }

  _compactToolbarIsCurrent(state) {
    if (this._compactToolbar !== state || !state.button.isConnected) return false;
    const shape = this._compactToolbarShape(this._resolveDockedLayout());
    return !!shape && ['header', 'upper', 'title', 'toolbar', 'search', 'threads', 'threadSlot', 'channelId', 'splitChannelId'].every(k => shape[k] === state[k]) &&
      shape.actions.length === state.actions.length && shape.actions.every((a, i) => a.el === state.actions[i].el && a.label === state.actions[i].label);
  }

  _ownHeaderAttribute(state, el, name, value) {
    let owned = state.owned.find(o => o.el === el && o.name === name);
    if (owned && el.getAttribute(name) !== owned.value) return; // later owner wins
    if (!owned) {
      owned = { el, name, before: el.getAttribute(name), value };
      state.owned.push(owned);
    }
    owned.value = value;
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  _syncHeaderTitles() {
    const state = this._compactToolbar;
    const hide = this._settings?.hideParentChannelInSplit === true;
    if (state) {
      for (const el of state.title.querySelectorAll('h1, h2')) {
        if (el.textContent) this._ownHeaderAttribute(state, el, 'title', el.textContent);
      }
      const parent = state.title.querySelector('[class*="parentChannelName_"]');
      const wrapper = parent?.closest('[class*="titleWrapper_"]');
      const separator = Array.from(state.title.children).find(el => (el.getAttribute?.('class') || String(el.className)).includes('caret_'));
      if (wrapper && separator) {
        for (const el of [wrapper, separator]) this._ownHeaderAttribute(state, el, 'data-ssv-parent-hidden', String(hide));
        const children = Array.from(state.title.children);
        const icon = children.slice(0, children.indexOf(wrapper)).find(el =>
          String(el.className).includes('channelIcon_') && !el.matches('button, [role="button"]'));
        if (icon) this._ownHeaderAttribute(state, icon, 'data-ssv-parent-hidden', String(hide));
      }
    }
    const channel = this._getChannel(this._splitChannelId);
    if (!this._paneTitle || !channel) return;
    const parent = THREAD_TYPES.has(channel.type) ? this._getChannel(channel.parent_id) : null;
    const name = `${THREAD_TYPES.has(channel.type) ? '' : '#'}${channel.name ?? channel.id}`;
    const fullName = parent?.name ? `#${parent.name} › ${name}` : name;
    const label = !hide && parent?.name ? fullName : name;
    if (this._paneTitle.textContent !== label) this._paneTitle.textContent = label;
    if (this._paneTitle.title !== fullName) this._paneTitle.title = fullName;
  }

  _getNativePinsAdapter(state) {
    const pins = state.actions.find(a => a.key === 'pins')?.el;
    try {
      let fiber = BdApi.ReactUtils?.getInternalInstance(pins);
      for (let depth = 0; fiber && depth < 16; depth++, fiber = fiber.return) {
        const props = fiber.memoizedProps, owner = fiber.stateNode;
        if (typeof props?.renderPopout !== 'function' || typeof owner?.render !== 'function' ||
            typeof owner.forceUpdate !== 'function') continue;
        const content = props.renderPopout({ closePopout() {} });
        // Observed native wrapper: explicit channel/onJump content, not the
        // top Pins button (which subscribes TOGGLE_CHANNEL_PINS globally).
        if (typeof content?.type !== 'function' || content.props?.channel?.id !== state.channelId ||
            typeof content.props.onJump !== 'function' || !fiber.type?.prototype?.render) continue;
        return { owner, Popout: fiber.type, Content: content.type, props };
      }
    } catch { /* changed native fibers: keep the split controls unavailable */ }
    return null;
  }

  _splitHeaderIsCurrent(controls) {
    return this._splitHeaderControls === controls && controls.slot.isConnected &&
      this._splitChannelId === controls.channelId && this._compactToolbarIsCurrent(controls.toolbar);
  }

  _nativeChannelMenuTarget(channelId) {
    const channel = this._getChannel(channelId);
    if (!channel?.guild_id) return null;
    // Invoke only an existing native channel/thread opener with this exact URL.
    // No selected-channel callback is borrowed for the other pane.
    const href = `/channels/${channel.guild_id}/${channelId}`;
    return Array.from(document.querySelectorAll?.('a[href]') ?? []).find(el =>
      el.getAttribute('href') === href && !this._paneEl?.contains(el)) ?? null;
  }

  _guardHeaderMenuTree(tree, isCurrent) {
    const React = BdApi.React;
    if (Array.isArray(tree)) return tree.map(child => this._guardHeaderMenuTree(child, isCurrent));
    if (!React.isValidElement(tree)) return tree;
    const props = {};
    if (tree.props.children) props.children = this._guardHeaderMenuTree(tree.props.children, isCurrent);
    if (typeof tree.props.action === 'function') props.action = function (...args) {
      if (isCurrent() && !tree.props.disabled) return tree.props.action.apply(this, args);
    };
    return React.cloneElement(tree, props);
  }

  _splitHeaderMenuTree(tree, controls) {
    if (!this._splitHeaderIsCurrent(controls)) return null;
    const React = BdApi.React;
    if (!React.isValidElement(tree) || !['thread-context', 'channel-context'].includes(tree.props.navId)) return tree;
    const channel = this._getChannel(controls.channelId);
    if (!channel) return null;
    const prune = node => {
      if (Array.isArray(node)) return node.map(prune);
      if (!React.isValidElement(node)) return node;
      // Native thread "open" is Discord's split-view command. Only remove it
      // in this split-header projection, never from the original native menu.
      if (['open', 'ssv-open-in-split', 'ssv-breakout-chat'].includes(node.props.id)) return null;
      return node.props.children ? React.cloneElement(node, { children: prune(node.props.children) }) : node;
    };
    const breakout = BdApi.ContextMenu.buildItem({
      type: 'button', id: 'ssv-breakout-chat', label: 'Break out chat',
      action: () => this.openBreakout(channel.id, channel, { source: 'split' }),
    });
    return this._guardHeaderMenuTree(React.cloneElement(tree, {
      children: [breakout, ...React.Children.toArray(prune(tree.props.children))],
    }), () => this._splitHeaderIsCurrent(controls));
  }

  _openSplitChannelMenu(controls, event) {
    if (!this._splitHeaderIsCurrent(controls)) return;
    const target = this._nativeChannelMenuTarget(controls.channelId);
    const channel = this._getChannel(controls.channelId);
    const adapter = !target && channel ? this._getBreakoutHeaderAdapter(channel) : null;
    if ((!target && !adapter) || typeof BdApi.ContextMenu?.patch !== 'function') return;
    controls.menuUnpatch?.();
    const disposers = ['channel-context', 'thread-context'].map(id => BdApi.ContextMenu.patch(id, (tree, props) => {
      if (props?.channel?.id !== controls.channelId || !this._splitHeaderIsCurrent(controls)) return;
      controls.menuOpen = true;
      const guarded = this._splitHeaderMenuTree(tree, controls);
      // ContextMenu.patch mutates the native return tree; actions/confirmations
      // remain native. Capture stale guards before handing it back to Discord.
      if (guarded?.props) {
        const onClose = guarded.props.onClose;
        tree.props = { ...guarded.props, onClose: (...args) => {
          controls.menuOpen = false;
          controls.menuUnpatch?.();
          return onClose?.(...args);
        } };
      }
    }));
    controls.menuUnpatch = () => { disposers.forEach(dispose => dispose?.()); controls.menuUnpatch = null; };
    if (target) {
      const rect = event.currentTarget.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window,
        clientX: rect.left, clientY: rect.bottom, button: 2 }));
    } else {
      const method = this.isThreadChannel(channel) ? adapter.openThreadMenu : adapter.openChannelMenu;
      try { method.call({ props: { guild: this._modules.GuildStore?.getGuild?.(channel.guild_id) } }, event, channel); }
      catch (error) { controls.menuUnpatch?.(); this._dbg('Split menu unavailable:', error.message); }
    }
  }

  _syncSplitHeaderControls(toolbar) {
    const slot = this._paneEl?.querySelector('.ssv-pane-header-controls');
    if (!slot || !this._compactToolbarIsCurrent(toolbar)) return;
    if (this._splitHeaderControls?.toolbar === toolbar) return;
    this._restoreSplitHeaderControls();
    const React = BdApi.React, ReactDOM = this._modules.ReactDOM;
    const adapter = this._getNativePinsAdapter(toolbar);
    if (!adapter || typeof ReactDOM?.createPortal !== 'function' || typeof BdApi.Patcher?.after !== 'function') return;
    const plugin = this;
    const controls = this._splitHeaderControls = { toolbar, slot, channelId: this._splitChannelId, adapter };
    const nativeThreadMenu = THREAD_TYPES.has(this._getChannel(controls.channelId)?.type) ? this._getNativeThreadMenu(toolbar) : null;
    function ThreadMenu(props) {
      if (!plugin._splitHeaderIsCurrent(controls)) return null;
      return plugin._splitHeaderMenuTree(nativeThreadMenu.type(props), controls);
    }
    function SplitHeaderControls() {
      const [open, setOpen] = React.useState(false);
      const ref = React.useRef(null);
      const [moreOpen, setMoreOpen] = React.useState(false);
      const moreRef = React.useRef(null);
      const current = plugin._splitHeaderIsCurrent(controls);
      const channel = current ? plugin._getChannel(controls.channelId) : null;
      const close = () => { setOpen(false); ref.current?.focus(); };
      if (!channel) return null;
      const moreEnabled = !!nativeThreadMenu || (typeof BdApi.ContextMenu?.patch === 'function' &&
        (!!plugin._nativeChannelMenuTarget(controls.channelId) || !!plugin._getBreakoutHeaderAdapter(channel)));
      const openMore = event => {
        if (!plugin._splitHeaderIsCurrent(controls)) return;
        if (nativeThreadMenu) setMoreOpen(value => !value);
        else plugin._openSplitChannelMenu(controls, event);
      };
      const pins = React.createElement(adapter.Popout, {
        targetElementRef: ref, shouldShow: open, animation: adapter.props.animation,
        position: 'bottom', align: 'right', autoInvert: false, ignoreModalClicks: true, clickTrap: true,
        onRequestClose: close,
        renderPopout: props => plugin._splitHeaderIsCurrent(controls) ? React.createElement(adapter.Content, {
          ...props, channel: plugin._getChannel(controls.channelId),
          onJump: event => { if (!event?.shiftKey) close(); },
        }) : null,
        children: trigger => React.createElement('button', { ...trigger, ref, type: 'button',
          className: 'ssv-pane-header-btn', 'aria-label': 'Pinned Messages', title: 'Pinned Messages',
          'aria-haspopup': 'dialog', 'aria-expanded': open,
          onClick: () => { if (plugin._splitHeaderIsCurrent(controls)) setOpen(value => !value); },
          onKeyDown: event => { if (event.key === 'Escape' && open) { event.preventDefault(); close(); } },
        }, React.createElement('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
          React.createElement('path', { d: PIN_ICON_PATH }))),
      });
      const moreButton = trigger => React.createElement('button', { ...trigger, ref: moreRef, type: 'button', className: 'ssv-pane-header-btn', 'aria-label': 'More',
          title: moreEnabled ? 'More channel actions' : 'Channel actions unavailable: native channel entry not found',
          disabled: !moreEnabled, 'aria-haspopup': 'menu', 'aria-expanded': moreOpen,
          onClick: openMore,
          onKeyDown: event => { if (event.key === 'ArrowDown' && !moreOpen) { event.preventDefault(); openMore(event); } },
        }, '⋯');
      const more = nativeThreadMenu ? React.createElement(adapter.Popout, {
        targetElementRef: moreRef, shouldShow: moreOpen, animation: adapter.props.animation,
        position: 'bottom', align: 'left', autoInvert: false,
        onRequestClose: () => setMoreOpen(false),
        renderPopout: props => React.createElement(ThreadMenu, { ...props, channel,
          closePopout: () => setMoreOpen(false) }), children: moreButton,
      }) : moreButton({});
      return React.createElement(React.Fragment, null, pins, more);
    }
    // Portal from the live native Popout owner, preserving Discord's layer,
    // focus and Mana providers. No independent root, copied provider snapshots,
    // chat remount, selected-channel mutation or global Pins subscription.
    controls.unpatch = BdApi.Patcher.after(PLUGIN_NAME, adapter.owner, 'render', (_self, _args, tree) => {
      if (!this._splitHeaderIsCurrent(controls)) return tree;
      return React.createElement(React.Fragment, null, tree,
        ReactDOM.createPortal(React.createElement(SplitHeaderControls), slot, `betterchat-header-${controls.channelId}`));
    });
    slot.setAttribute('data-ssv-ready', 'true');
    adapter.owner.forceUpdate();
  }

  _restoreSplitHeaderControls() {
    const controls = this._splitHeaderControls;
    this._splitHeaderControls = null;
    if (!controls) return;
    controls.slot.removeAttribute('data-ssv-ready');
    controls.menuUnpatch?.();
    if (controls.menuOpen) BdApi.ContextMenu.close();
    controls.unpatch?.();
    try { controls.adapter.owner.forceUpdate(); } catch { /* native owner already unmounted */ }
  }

  _getNativeThreadMenu(state) {
    const action = state.actions.find(a => a.key === 'thread');
    if (!action || action.el.disabled || action.el.getAttribute?.('aria-disabled') === 'true') return null;
    // Reuse the native opener's component and channel, not a hand-maintained
    // list of thread actions or permission checks. Unknown shapes retain fallback.
    try {
      let fiber = BdApi.ReactUtils?.getInternalInstance(action.el);
      for (let depth = 0; fiber && depth < 12; depth++, fiber = fiber.return) {
        const render = fiber.memoizedProps?.renderPopout;
        if (typeof render !== 'function') continue;
        const menu = render({ closePopout() {} });
        if (typeof menu?.type === 'function' && menu.props?.channel?.id === state.channelId) return menu;
      }
    } catch { /* Discord changed this optional native menu adapter. */ }
    return null;
  }

  _mergeNativeThreadMenu(state, tree, items) {
    if (!this._compactToolbarIsCurrent(state)) return null;
    if (tree?.props?.navId !== 'thread-context') return tree;
    const React = BdApi.React, plugin = this;
    const guard = element => {
      if (Array.isArray(element)) return element.map(guard);
      if (!React.isValidElement(element)) return element;
      const props = {};
      if (element.props.children) props.children = guard(element.props.children);
      if (typeof element.props.action === 'function') props.action = function (...args) {
        if (plugin._compactToolbarIsCurrent(state) && !element.props.disabled) return element.props.action.apply(this, args);
      };
      return React.cloneElement(element, props);
    };
    return React.cloneElement(tree, { children: [
      ...BdApi.ContextMenu.buildMenuChildren([{ type: 'group', items }]),
      ...React.Children.toArray(guard(tree.props.children)),
    ] });
  }

  _mainHeaderBreakoutItem(state) {
    const channel = this._getChannel(state.channelId);
    if (!this.isSplitTargetChannel(channel)) return null;
    return {
      type: 'text', id: 'ssv-breakout-chat', label: 'Break out chat',
      action: () => {
        if (this._compactToolbarIsCurrent(state)) this.openBreakout(channel.id, channel, { source: 'main' });
      },
    };
  }

  _openCompactToolbarMenu(state, inputEvent) {
    if (!this._compactToolbarIsCurrent(state)) { this._syncCompactToolbar(this._resolveDockedLayout()); return; }
    if (state.menuOpen || state.timer !== null) return;
    const nativeMenu = typeof BdApi.Patcher?.after === 'function' && typeof BdApi.ContextMenu.buildMenuChildren === 'function'
      ? this._getNativeThreadMenu(state) : null;
    const items = state.actions.filter(a => !nativeMenu || a.key !== 'thread').map(action => ({
      type: 'text', id: `betterchat-${action.key}`, label: action.key === 'thread' ? 'Thread actions' : action.label,
      disabled: action.el.getAttribute('aria-disabled') === 'true' || action.el.disabled === true,
      action: () => {
        if (!this._compactToolbarIsCurrent(state) || action.el.getAttribute('aria-disabled') === 'true' || action.el.disabled === true) return;
        state.handingOff = true;
        BdApi.ContextMenu.close();
        // Let the compact menu finish closing before opening a native popout/menu.
        // React's real control remains a 32px anchor over More (never display:none).
        state.timer = window.setTimeout(() => {
          state.timer = null;
          if (!this._compactToolbarIsCurrent(state) || action.el.getAttribute('aria-disabled') === 'true' || action.el.disabled === true) return;
          const r = state.button.getBoundingClientRect();
          if (!r.width || !r.height) return;
          action.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window,
            clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
          // Only the native menu opener is invoked, never one of its actions.
          state.handingOff = false;
        }, 0);
      },
    }));
    const breakout = this._mainHeaderBreakoutItem(state);
    if (breakout) items.unshift(breakout);
    const r = state.button.getBoundingClientRect();
    // Native context menus need the originating DOM target, not an undispatched event.
    const event = inputEvent?.target ? inputEvent : {
      target: state.button, currentTarget: state.button, clientX: r.right, clientY: r.bottom,
      preventDefault() {}, stopPropagation() {},
    };
    state.menuOpen = true; state.handingOff = false;
    state.button.setAttribute('aria-expanded', 'true');
    try {
      const onClosed = () => {
        state.menuRenderUnpatch?.(); state.menuRenderUnpatch = null;
        if (!state.menuOpen) return;
        state.menuOpen = false; state.button.setAttribute('aria-expanded', 'false');
        if (!state.handingOff && this._compactToolbarIsCurrent(state)) state.button.focus();
      };
      let Menu;
      if (nativeMenu) {
        // Patch this local render owner only. Discord's global menu export and
        // other menus are untouched; native hooks still run as a React component.
        const owner = { render: nativeMenu.type };
        state.menuRenderUnpatch = BdApi.Patcher.after(PLUGIN_NAME, owner, 'render', (_self, _args, tree) =>
          this._mergeNativeThreadMenu(state, tree, items));
        Menu = props => BdApi.React.createElement(owner.render, { ...nativeMenu.props, betterChatCompactToolbar: true,
          closePopout: props.onClose, onSelect: props.onSelect });
      } else Menu = BdApi.ContextMenu.buildMenu(items);
      // BdApi.open injects the native onClose prop. Observe component unmount as
      // well as Escape so outside clicks cannot leave More permanently expanded.
      const CompactMenu = props => {
        BdApi.React.useEffect(() => onClosed, []);
        return BdApi.React.createElement(Menu, { ...props, onClose: (...args) => {
          props.onClose?.(...args); onClosed();
        } });
      };
      BdApi.ContextMenu.open(event, CompactMenu);
    } catch (error) {
      this._restoreCompactToolbar();
      this._dbg('Compact toolbar menu unavailable:', error.message);
    }
  }

  _positionThreadsButton() {
    const state = this._compactToolbar;
    if (!state?.threadSlot || !state.threads) return;
    const r = state.threadSlot.getBoundingClientRect();
    for (const [key, value] of Object.entries({ '--ssv-threads-x': `${r.left + (r.width - 32) / 2}px`, '--ssv-threads-y': `${r.top + (r.height - 32) / 2}px` })) {
      if (state.threads.style.getPropertyValue(key) !== value) state.threads.style.setProperty(key, value);
    }
  }

  _positionSplitSearch() {
    this._positionThreadsButton();
    const search = this._compactToolbar?.search;
    const slot = this._paneEl?.querySelector('.ssv-pane-header-search-slot');

    if (!search || !slot) return;
    this._refreshSplitSearchTarget();
    const r = slot.getBoundingClientRect();
    for (const [key, value] of Object.entries({
      '--ssv-search-x': `${r.left}px`, '--ssv-search-y': `${r.top}px`, '--ssv-search-width': `${r.width}px`,
    })) if (search.style.getPropertyValue(key) !== value) search.style.setProperty(key, value);
  }


  _refreshSplitSearchTarget() {
    const state = this._compactToolbar;
    if (!state || !this._compactToolbarIsCurrent(state)) return false;
    const channel = this._getChannel(this._splitChannelId);
    if (!channel?.guild_id || this._splitSearchTarget === this._splitChannelId) return false;
    this._splitSearchTarget = this._splitChannelId;
    try {
      const store = BdApi.Webpack?.getStore?.('SearchMessageStore');
      const native = this._getNativeSearchService();
      const context = { type: 'GUILD', guildId: channel.guild_id };
      const query = native?.service.getSearchInputText(context);
      // Do not turn an unsent search draft into a request. Refresh only an
      // existing result set; native fetch cancels the previous target request.
      if (!store?.hasSearchState?.(channel.guild_id) || !query?.trim()) return false;
      native.service.fetchMessages({ searchContext: context, searchQueryString: query, offset: 0, searchEverywhere: false });
      return true;
    } catch (error) { this._dbg('Split search refresh unavailable:', error.message); return false; }
  }

  _installSplitSearchScope() {
    if (this._splitSearchUnpatch) return true;
    // Native SearchFetcher owns parsing, requests, result stores and pagination.
    // Only the visible, same-guild split search is scoped; no custom renderer.
    let factory;
    try {
      factory = BdApi.Webpack?.getModule(m => typeof m?.create === 'function' &&
        String(m.create).includes('searchType') && typeof m.cancel === 'function' && typeof m.get === 'function', { searchExports: true });
    } catch { return false; } // Discord updates must not break the chat pane.
    if (!factory || typeof BdApi.Patcher?.before !== 'function') return false;
    this._splitSearchUnpatch = BdApi.Patcher.before(PLUGIN_NAME, factory, 'create', (_self, args) => {
      const state = this._compactToolbar, request = args[0];
      if (!state || !this._compactToolbarIsCurrent(state)) return;
      const target = this._getChannel(this._splitChannelId);
      if (request?.searchType !== 'GUILD' || request.id !== target?.guild_id || !request.searchQuery) return;
      // Replace, never append: another in: filter or Search Everywhere cannot
      // silently widen a search advertised as belonging to this split channel.
      args[0] = { ...request, searchQuery: { ...request.searchQuery, channel_id: [this._splitChannelId], search_everywhere: false } };
    });
    return typeof this._splitSearchUnpatch === 'function';
  }

  _restoreCompactToolbar() {
    this._restoreSplitHeaderControls();
    this._splitSearchUnpatch?.();
    this._splitSearchUnpatch = null;
    const state = this._compactToolbar;
    this._compactToolbar = null;
    if (!state) return;
    state.observer?.disconnect();
    if (state.frame !== null) window.cancelAnimationFrame(state.frame);
    if (state.timer !== null) window.clearTimeout(state.timer);
    if (state.menuOpen) BdApi.ContextMenu.close();
    state.menuRenderUnpatch?.(); state.menuRenderUnpatch = null;
    if (state.threads) for (const key of ['--ssv-threads-x', '--ssv-threads-y']) state.threads.style.removeProperty(key);
    state.button.remove();
    for (const key of ['--ssv-search-x', '--ssv-search-y', '--ssv-search-width']) state.search.style.removeProperty(key);
    for (const { el, name, before, value } of state.owned.reverse()) {
      if (el.getAttribute(name) !== value) continue; // don't undo a later native/plugin write
      if (before === null) el.removeAttribute(name);
      else el.setAttribute(name, before);
    }
  }

  _syncNativeRowPosition(layout) {
    const row = layout?.nativeRow;
    const needsBoundary = row && Array.from(row.querySelectorAll('[class*="chatLayerWrapper"]')).some(thread =>
      layout.surfaces.some(surface => thread.contains(surface)) && getComputedStyle(thread).position === 'absolute' &&
      (thread.offsetParent === layout.host || thread.offsetParent === row));
    // Keep ownership across geometry observer rebinds; never fight a later native write.
    if (needsBoundary && this._nativeRowPosition?.row === row) return;
    this._restoreNativeRowPosition();
    if (!needsBoundary || getComputedStyle(row).position !== 'static') return;
    this._nativeRowPosition = {
      row, value: row.style.getPropertyValue('position'), priority: row.style.getPropertyPriority('position'),
    };
    row.style.setProperty('position', 'relative');
  }

  _restoreNativeRowPosition() {
    const owned = this._nativeRowPosition;
    this._nativeRowPosition = null;
    if (!owned) return;
    const style = owned.row.style;
    if (style.getPropertyValue('position') !== 'relative' || style.getPropertyPriority('position') !== '') return;
    if (owned.value) style.setProperty('position', owned.value, owned.priority);
    else style.removeProperty('position');
  }

  _setDockedSuspended(suspended) {
    const pane = this._paneEl;
    if (!pane || (pane.getAttribute('data-ssv-suspended') === 'true') === suspended) return;
    if (suspended) {
      const r = pane.getBoundingClientRect();
      this._setPaneStyle('--ssv-suspended-width', `${r.width}px`);
      this._setPaneStyle('--ssv-suspended-height', `${r.height}px`);
      pane.setAttribute('data-ssv-suspended', 'true');
      pane.setAttribute('aria-hidden', 'true');
    } else {
      pane.removeAttribute('data-ssv-suspended');
      pane.removeAttribute('aria-hidden');
      pane.style.removeProperty('--ssv-suspended-width');
      pane.style.removeProperty('--ssv-suspended-height');
    }
  }

  _setPaneStyle(name, value) {
    if (!this._paneEl) return;
    const style = this._paneEl.style;
    if (name.startsWith('--')) {
      if (style.getPropertyValue(name) !== value) style.setProperty(name, value);
    } else if (style[name] !== value) style[name] = value;
  }

  _observeDockedGeometry(layout) {
    const extras = [...layout.sidebars, ...(layout.member ? [layout.member.parentElement] : []),
      ...this._dockedNativeThreads(layout).map(thread => thread.wrapper)];
    if (this._dockedObservedHost === layout.host && this._dockedObservedHeader === layout.mainHeader &&
        extras.length === this._dockedObservedExtras?.length && extras.every((el, i) => el === this._dockedObservedExtras[i])) return;
    this._removeDockedGeometryObserver();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => {
      if (this._stopped || this._dockedResizeObserver !== observer || this._dockedGeometryRaf !== null) return;
      this._dockedGeometryRaf = window.requestAnimationFrame(() => {
        this._dockedGeometryRaf = null;
        if (!this._stopped && this._dockedResizeObserver === observer) this._ensurePaneDockedRight('native-geometry');
      });
    });
    this._dockedResizeObserver = observer;
    this._dockedObservedHost = layout.host;
    this._dockedObservedHeader = layout.mainHeader;
    this._dockedObservedExtras = extras;
    observer.observe(layout.host);
    if (layout.mainHeader) observer.observe(layout.mainHeader);
    for (const el of extras) observer.observe(el);
  }

  _removeDockedGeometryObserver() {
    this._dockedResizeObserver?.disconnect();
    this._dockedResizeObserver = null;
    this._dockedObservedExtras = null;
    this._dockedObservedHost = null;
    this._dockedObservedHeader = null;
    if (this._dockedGeometryRaf !== null) window.cancelAnimationFrame(this._dockedGeometryRaf);
    this._dockedGeometryRaf = null;
  }

  _inspectLayout() {
    // Passive, geometry-only: deliberately not the ID-bearing status snapshot.
    const result = this._discoverDockedLayout();
    const rect = el => {
      if (!el?.isConnected || el.ownerDocument !== document) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const layout = result.layout;
    return {
      status: layout ? 'supported' : 'unavailable', reason: result.reason,
      globalBar: rect(layout?.globalBar), mainHeader: rect(layout?.mainHeader),
      paneHeader: rect(this._paneEl?.querySelector('.ssv-pane-header')), pane: rect(this._paneEl),
      host: rect(layout?.host),
      candidates: result.candidates.map(candidate => ({ rect: rect(candidate.host), valid: !candidate.reason, reason: candidate.reason })),
    };
  }

  _scheduleDockedRight(reason = 'layout-check') {
    if (this._stopped || !this._splitChannelId || this._settings?.paneMode === 'floating') return;
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
    if (this._stopped || !this._splitChannelId || !this._paneEl || !document.body.contains(this._paneEl)) return false;
    if (this._settings?.paneMode === 'floating') return false;

    const container = this._findLayoutContainer();
    if (!container) {
      this._applyDockedLayout(); // suspend the shell; never keep an unsafe visible parent
      return false;
    }

    const isWrongParent = this._paneEl.parentElement !== container;
    const isNotRightmost = this._paneEl.nextElementSibling !== null;
    if (!isWrongParent && !isNotRightmost) {
      this._applyDockedLayout(container);
      return false;
    }

    // Discord may insert the native thread preview/sidebar after our pane during
    // navigation. Move the existing pane back to the end of the current chat row
    // instead of destroying/remounting React; this preserves the split target and
    // keeps the layout stable as main channel | thread preview | BetterChat.
    container.appendChild(this._paneEl);
    document.body.classList.add('ssv-active');
    this._applyDockedLayout(container);
    this._dbg(`Re-docked split pane to the right after ${reason}`);
    return true;
  }

  // Legacy diagnostics remain callable but never create or paint an overlay.
  _syncTitlebarDragStrip() {
    return { status: 'retired', visible: false, reason: 'native-shared-titlebar' };
  }

  _inspectTitlebarDragStrip() { return this._syncTitlebarDragStrip(); }
  _setTitlebarDragStripProbe() { return this._syncTitlebarDragStrip(); }

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
    const epoch = this._openEffectsEpoch;
    // Discord restores/render-loads messages asynchronously. Run a short series
    // of bottom-scroll attempts so both the default chat and the split pane land
    // on the most recent messages after tab/channel switches.
    for (const delay of [60, 180, 420, 900]) {
      const timer = window.setTimeout(() => {
        this._scrollTimers.delete(timer);
        if (!this._stopped && epoch === this._openEffectsEpoch) this._scrollToBottom(target, reason);
      }, delay);
      this._scrollTimers.add(timer);
    }
  }

  // ─── Pane DOM ────────────────────────────────────────────────────────────────

  createDockedPane(quiet = false) {
    if (this._paneEl) return this._paneEl;

    const floating = this._settings?.paneMode === 'floating';
    const container = floating ? document.body : this._findLayoutContainer();
    if (!container) {
      this._err('Cannot create BetterChat pane: safe layout container not found');
      if (!quiet) this._toast('BetterChat could not find a safe Discord chat row to mount into', 'error');
      return null;
    }
    if (!floating && this._dockedWidth(this._resolveDockedLayout()) === null) {
      if (!quiet) this._toast('Not enough room for BetterChat beside native chat', 'warning');
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

    const title = document.createElement('span');
    title.className = 'ssv-pane-header-title';
    title.textContent = 'BetterChat';
    this._paneTitle = title;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ssv-pane-header-btn';
    closeBtn.title = 'Close BetterChat';
    closeBtn.setAttribute('aria-label', 'Close BetterChat');
    closeBtn.type = 'button';
    closeBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    closeBtn.addEventListener('click', () => this.close());

    header.addEventListener('mousedown', this._onFloatingDragStart);
    const searchSlot = document.createElement('div');
    searchSlot.className = 'ssv-pane-header-search-slot';
    searchSlot.setAttribute('aria-hidden', 'true');
    const controls = document.createElement('div');
    controls.className = 'ssv-pane-header-controls';
    const unavailable = document.createElement('span');
    unavailable.className = 'ssv-header-unavailable';
    for (const [label, icon] of [['Pinned Messages', null], ['More', '⋯']]) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'ssv-pane-header-btn'; button.disabled = true;
      button.setAttribute('aria-label', label);
      button.title = `${label} unavailable in this native header context`;
      if (icon) button.textContent = icon;
      else button.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${PIN_ICON_PATH}"/></svg>`;
      unavailable.appendChild(button);
    }
    controls.appendChild(unavailable);
    header.append(closeBtn, title, controls, searchSlot);

    // Body — placeholder until native Discord chat mounts
    const body = document.createElement('div');
    body.className = 'ssv-pane-body ssv-placeholder';
    this._paneBody = body;
    this._renderPlaceholder('No split target selected', 'Right-click a channel or thread and choose\n"Split this chat"');

    inner.append(header, body);
    pane.append(handle, inner, floatingResizeCorner);
    container.appendChild(pane);

    this._paneEl = pane;
    document.body.classList.add('ssv-active');
    this._applyPanePlacement();

    this._log('Pane created');
    return pane;
  }

  destroyDockedPane() {
    this._restoreDockedMembers();
    this._restoreCompactToolbar();
    this._removeDockedGeometryObserver();
    this._restoreNativeRowPosition();
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
      if (this._stopped || !channelId) return;

      const paneMissing = !this._paneEl || !document.body.contains(this._paneEl);
      if (!paneMissing) {
        this._ensurePaneDockedRight(reason);
        if (!force) return;
      }

      this._dbg(`Remounting split pane after ${reason}: ${channelId}`);
      this.destroyDockedPane();
      this.open(channelId, null, { automatic: true });
    }, 150);
  }

  _installLayoutPersistence() {
    if (this._layoutObserver || typeof MutationObserver !== 'function') return;

    this._layoutObserver = new MutationObserver(() => {
      if (!this._splitChannelId) { this._restoreActiveSplit(); return; }
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
    this._restoreDockedMembers();
    this._restoreCompactToolbar();
    if (this._remountTimer) {
      window.clearTimeout(this._remountTimer);
      this._remountTimer = null;
    }
    for (const timer of this._redockTimers) window.clearTimeout(timer);
    this._redockTimers.clear();
    this._layoutObserver?.disconnect?.();
    this._layoutObserver = null;
    this._removeDockedGeometryObserver();
    this._restoreNativeRowPosition();
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
    this._removeDockedGeometryObserver();
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

  _getCurrentAccountId() {
    try {
      const id = this._modules.UserStore?.getCurrentUser?.()?.id;
      return isDiscordId(id) ? id : null;
    } catch { return null; }
  }

  _syncPersistenceAccount() {
    const next = this._getCurrentAccountId();
    if (next === this._accountId) return;
    const initial = this._accountId === undefined;
    // Initial UserStore hydration may lag start(); defer the account-bound
    // session read, but never apply this exception after a known user logs out.
    if (initial && !next) return;
    this._teardownSplit();
    this._contextChannelCache.clear();
    this._accountId = next;
    if (this._settings) this._settings.activeChannelId = initial ? this._readSessionActiveSplit() : null;
    if (!initial) this._writeSessionActiveSplit(null);
  }

  _getSelectedGuildId(selectedChannelId = this._getSelectedChannelId()) {
    try {
      // A null selected guild means DMs/home, never the last visited server.
      const store = this._modules.SelectedGuildStore;
      if (typeof store?.getGuildId === 'function') return store.getGuildId() || null;
      const selected = this._modules.SelectedChannelStore;
      if (typeof selected?.getGuildId === 'function') return selected.getGuildId() || null;
      return selectedChannelId ? this._getChannelGuildId(selectedChannelId) : null;
    } catch { return null; }
  }

  _closeForGuildChange(previousGuildId, nextGuildId) {
    this._dbg('Closing BetterChat after guild/server change:', previousGuildId, '→', nextGuildId);
    if (this._settings?.rememberSplitPerServer) {
      this._teardownSplit();
      this._settings.activeChannelId = null;
      this._writeSessionActiveSplit(null);
    } else this.close();
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
      this._dbg('Same channel is open in main view and BetterChat; keeping BetterChat scrollable while suppressing only its composer:', this._splitChannelId);
    }
    return duplicate;
  }

  _installSelectedChannelPersistence() {
    if (this._selectedChannelListener) return;
    this._syncPersistenceAccount();
    this._lastMainChannelId = this._getSelectedChannelId();
    this._lastMainGuildId = this._getSelectedGuildId();
    this._selectedChannelListener = () => {
      if (this._stopped) return;
      this._syncPersistenceAccount();
      const next = this._getSelectedChannelId();
      const guildId = this._getSelectedGuildId(next);
      const changed = next !== this._lastMainChannelId || guildId !== this._lastMainGuildId;
      if (changed) {
        this._cancelOpenEffects();
        this._cancelSplitRestore();
      }
      if (this._splitChannelId && (!guildId || guildId !== this._splitGuildId)) {
        this._closeForGuildChange(this._splitGuildId, guildId);
      }
      this._lastMainChannelId = next;
      this._lastMainGuildId = guildId;
      if (!this._accountId) return;
      if (this._splitChannelId) {
        if (changed) {
          this._applyDuplicateChannelMode('main-channel-change');
          this._scheduleRemount('main-channel-change');
        }
      } else this._restoreActiveSplit();
    };
    for (const name of ['SelectedChannelStore', 'SelectedGuildStore', 'UserStore', 'ChannelStore', 'GuildStore', 'PermissionStore']) {
      const store = this._modules[name];
      if (!store?.addChangeListener || this._persistenceStores.includes(store)) continue;
      try {
        store.addChangeListener(this._selectedChannelListener);
        this._persistenceStores.push(store);
      } catch (e) { this._dbg(`${name} persistence listener unavailable:`, e.message); }
    }
  }

  _removeSelectedChannelPersistence() {
    for (const store of this._persistenceStores) {
      try { store.removeChangeListener?.(this._selectedChannelListener); } catch { /* ignore */ }
    }
    this._persistenceStores = [];
    this._selectedChannelListener = null;
    this._lastMainChannelId = null;
    this._lastMainGuildId = null;
  }

  _cancelSplitRestore() {
    if (this._restoreTimer) window.clearTimeout(this._restoreTimer);
    this._restoreTimer = null;
    this._restoreAttempt = 0;
    this._restoreKey = null;
  }

  _restoreActiveSplit() {
    if (this._stopped || !this._settings) return;
    this._syncPersistenceAccount();
    if (!this._accountId || this._splitChannelId) return;
    const guildId = this._getSelectedGuildId();
    const channelId = this._settings.rememberSplitPerServer
      ? this._settings.rememberedSplits[this._accountId]?.[guildId]
      : this._settings.activeChannelId;
    if (!guildId || !channelId) return;
    const key = `${this._accountId}:${guildId}:${channelId}`;
    if (key !== this._restoreKey) {
      this._cancelSplitRestore();
      this._restoreKey = key;
    }
    // Restore only from live stores, not old context-menu snapshots. Missing
    // records/permissions are readiness gaps, not proof a target was deleted.
    let channel, main, permission;
    try {
      channel = this._modules.ChannelStore?.getChannel?.(channelId);
      main = this._modules.ChannelStore?.getChannel?.(this._getSelectedChannelId());
      const channelGuild = channel?.guild_id || this._modules.ChannelStore?.getChannel?.(channel?.parent_id)?.guild_id;
      const mainGuild = main?.guild_id || this._modules.ChannelStore?.getChannel?.(main?.parent_id)?.guild_id;
      if (channel && (!this.isSplitTargetChannel(channel) || (channelGuild && channelGuild !== guildId))) {
        this._forgetActiveSplit(guildId);
        return;
      }
      // Routing and guild hydration must agree before interpreting permissions.
      if (channel && channelGuild === guildId && mainGuild === guildId && this._modules.GuildStore?.getGuild?.(guildId)) {
        const flag = this._modules.Permissions?.VIEW_CHANNEL;
        if (typeof flag === 'bigint' || typeof flag === 'number') permission = this._modules.PermissionStore?.can?.(flag, channel);
        if (permission === false) {
          this._forgetActiveSplit(guildId);
          return;
        }
        if (permission === true && this._findLayoutContainer() &&
            (this._settings.paneMode === 'floating' || this._dockedWidth(this._resolveDockedLayout()) !== null)) {
          this._cancelSplitRestore();
          this.open(channelId, channel, { automatic: true });
          return;
        }
      }
    } catch (e) { this._dbg('Split restore waiting for stores:', e.message); }
    // One bounded startup/route retry budget, plus opportunities on real store
    // or layout changes. Events never replenish an exhausted unchanged budget.
    const delays = [1200, 2500, 5000, 9000];
    if (!this._restoreTimer && this._restoreAttempt < delays.length) {
      const timer = window.setTimeout(() => {
        if (this._restoreTimer !== timer) return;
        this._restoreTimer = null;
        if (this._restoreKey === key) this._restoreActiveSplit();
      }, delays[this._restoreAttempt++]);
      this._restoreTimer = timer;
    }
  }

  _clearPaneRefs() {
    this._paneEl = null;
    this._paneTitle = null;
    this._paneBody = null;
  }

  _closeMemberListIfOpen() {
    // Keep BetterChat clean by collapsing Discord's native member list only when
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
        this._dbg('Closed Discord member list for cleaner BetterChat layout');
        return true;
      } catch (e) {
        this._dbg('Member list close failed:', e.message);
        return false;
      }
    }

    this._dbg('Member list already closed or toggle not found');
    return false;
  }

  _forgetActiveSplit(guildId = this._splitGuildId || this._getSelectedGuildId()) {
    if (!this._settings) return;
    this._cancelSplitRestore();
    if (this._settings.rememberSplitPerServer && this._accountId && this._accountId === this._getCurrentAccountId()) {
      const targets = this._settings.rememberedSplits[this._accountId];
      if (targets && guildId) delete targets[guildId];
    }
    this._settings.activeChannelId = null;
    this._writeSessionActiveSplit(null);
    this._saveSettings();
  }

  _rememberActiveSplit(channelId) {
    if (!this._settings) return;
    const accountId = this._getCurrentAccountId();
    if (!accountId || accountId !== this._accountId) return;
    if (this._settings.rememberSplitPerServer && isDiscordId(this._splitGuildId) && isDiscordId(channelId)) {
      this._settings.rememberedSplits ??= Object.create(null);
      const targets = this._settings.rememberedSplits[accountId] ??= Object.create(null);
      targets[this._splitGuildId] = channelId;
    }
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
    this._setPaneStyle('width', `${w}px`);
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
    }
  }

  _applyFloatingRect(rect) {
    this._setDockedSuspended(false);
    this._restoreCompactToolbar();
    const next = normalizeFloatingRect(rect);
    this._settings.floatingRect = next;
    this._restoreDockedMembers();
    this._removeDockedGeometryObserver();
    this._restoreNativeRowPosition();
    if (!this._paneEl) return;
    this._setPaneStyle('display', '');
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
    const nextMode = this._settings.paneMode === 'floating' ? 'docked' : 'floating';
    const layout = nextMode === 'docked' ? this._resolveDockedLayout() : null;
    if (nextMode === 'docked' && this._paneEl && (!layout || this._dockedWidth(layout) === null)) {
      this._toast('BetterChat could not find a safe Discord chat row with enough room', 'warning');
      return { paneMode: this._settings.paneMode, floatingRect: this._settings.floatingRect };
    }
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
      this._paneEl.classList.toggle('ssv-floating', nextMode === 'floating');
      (nextMode === 'floating' ? document.body : layout.host).appendChild(this._paneEl);
      this._applyPanePlacement();
    }
    this._toast(nextMode === 'floating' ? 'BetterChat broken out; drag the header to move it' : 'BetterChat docked right', 'info');
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
        console.error('[BetterChat] Render boundary caught:', err);
        plugin._recordCrashEvent('render-boundary-caught', {
          error: plugin._stringifyLogArgs([err])[0],
          componentStack: info?.componentStack ?? null,
        });
      }
      render() {
        if (this.state.hasError) return React.createElement('div', { className: 'ssv-placeholder-detail ssv-placeholder-diagnostic' }, [
          React.createElement('div', { key: 'title' }, 'Native render error caught.'),
          React.createElement('code', { key: 'error', style: { display: 'block', marginTop: '8px', whiteSpace: 'pre-wrap' } }, this.state.errorText || 'unknown render error'),
          React.createElement('div', { key: 'hint', style: { marginTop: '8px' } }, 'Run BetterChatDebug.printCrashLog().'),
        ]);
        return this.props.children;
      }
    }

    this._SsvErrorBoundary = SsvErrorBoundary;
    return SsvErrorBoundary;
  }

  _unmountReactRoot() {
    this._releaseSplitAttachmentScan?.();
    this._releaseSplitAttachmentScan = null;
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

  _scheduleNativeRenderRetry(channelId, channelHint = null, firstResult = null, automatic = false) {
    const epoch = this._openEffectsEpoch;
    const missing = firstResult?.missing ?? [];
    if (!missing.length || !this._paneBody) return;

    this._clearNativeRenderRetries();
    for (const delay of [350, 1000, 2500, 5000, 9000]) {
      const timer = window.setTimeout(() => {
        if (!this._nativeRenderTimers.has(timer)) return;
        this._nativeRenderTimers.delete(timer);
        if (this._stopped || this._splitChannelId !== channelId || !this._paneBody) return;

        this.discoverModules();
        const result = this._tryNativeRender(channelId, channelHint, false, this._nativeRenderVariant);
        if (result.ok) {
          this._clearNativeRenderRetries();
          if (!automatic && epoch === this._openEffectsEpoch) this._scheduleScrollToBottom('split', `native-render-retry-${delay}ms`);
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

  _ensureNativeHistory(channelId) {
    const warn = () => {
      if (this._nativeHistoryWarned) return;
      this._nativeHistoryWarned = true;
      console.warn('[BetterChat] Native history loading unavailable; chat remains native.');
    };
    try {
      const W = BdApi.Webpack;
      const store = this._modules.MessageStore ??= W?.getStore?.('MessageStore');
      const messages = store?.getMessages?.(channelId);
      if (!messages || messages.loadingMore || (messages.ready && !messages.cached)) return;
      const manager = this._modules.MessageManager ??= W?.getModule?.(m =>
        typeof m?.fetchMessages === 'function' && typeof m.loadSelectedChannelIfNecessary === 'function',
        { searchExports: true });
      if (!manager) return;
      // Let Discord own request deduplication, thread startup and cached/jump state.
      const guildId = this._getChannelGuildId(this._getChannel(channelId));
      manager.fetchMessages({ guildId, channelId })?.catch?.(warn);
    } catch { warn(); }
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

      const plugin = this;
      let active = true, release = null;
      this._releaseSplitAttachmentScan = () => { active = false; release?.(); };
      const NativeScanTarget = function NativeScanTarget({ children }) {
        React.useEffect(() => {
          if (!active || plugin._stopped || plugin._splitChannelId !== channelId) return;
          const dispose = plugin._retainAttachmentScanTarget(channelId);
          release = dispose;
          plugin._ensureNativeHistory(channelId);
          return dispose;
        }, []);
        return children;
      };
      content = this._withNativeProviders(React.createElement(NativeScanTarget, {}, content), { theme: true });

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
      this._unmountReactRoot();
      this._err('Native render failed:', e);
      this._recordCrashEvent('native-render-failed', { error: this._stringifyLogArgs([e])[0], channelId, variant: renderVariant });
      this._renderMode = 'placeholder';
      return { ok: false, error: e.message };
    }
  }

  _withNativeProviders(content, { theme = false } = {}) {
    // Use native live providers and the native impression hook. Never copy a
    // context snapshot, invent defaults, or suppress missing-provider warnings.
    try {
      const W = BdApi.Webpack, React = this._modules.React;
      if (!W?.getModule || !React) return content;
      if (!this._nativeProviders) {
        const Theme = W.getModule(m => typeof m === 'function' &&
          ['RootThemeContextProvider', 'themeOverride', 'getWindowFocused'].every(k => String(m).includes(k)), { searchExports: true });
        const Analytics = W.getModule(m => m?.Provider && typeof m._currentValue === 'function' &&
          String(m._currentValue).includes('AnalyticsTrackImpressionContext'), { searchExports: true });
        const track = W.getModule(m => typeof m === 'function' &&
          ['trackOnInitialLoad', 'impression_', 'sequenceId'].every(k => String(m).includes(k)), { searchExports: true });
        if (Theme && Analytics && track) this._nativeProviders = { Theme, Analytics, track };
      }
      const providers = this._nativeProviders;
      if (!providers) return content;
      if (theme) content = React.createElement(providers.Theme, {}, content);
      return React.createElement(providers.Analytics.Provider, { value: providers.track }, content);
    } catch { return content; }
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
    // Reuse live identities; rescan only when required modules are absent.
    const cached = this._getBreakoutModuleStatus();
    if (![cached.React, cached.SplitViewComponent, cached.ChatInputTypesSidebar, cached.PopoutActions, cached.PopoutWindow].every(Boolean)) this.discoverModules();
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
      openBreakouts: this._listBreakoutStatus(),
      ackBridgeInstalled: !!this._dispatcher,
      sidebarInputPatched: !!this._origSidebarInput,
    };
    console.log('[BetterChat] Breakout module inspection:', result);
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
    // docked BetterChat and Breakout chats.
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
      if (!event?.channelId || event.optimistic || event.isPushNotification || !event.message?.id) return;
      this._activateBreakout(event.channelId, event.message.id);
    };
    try { dispatcher.subscribe('MESSAGE_CREATE', this._onBreakoutMessage); }
    catch { this._removeBreakoutAckBridge(); return; }
    this._recordCrashEvent('breakout-ack-bridge-installed');
  }

  _removeBreakoutAckBridge() {
    try { this._dispatcher?.unsubscribe?.('MESSAGE_CREATE', this._onBreakoutMessage); } catch { /* ignore */ }
    this._dispatcher = null;
    this._onBreakoutMessage = null;
  }

  _listBreakoutStatus() {
    // Never expose DOM/windows or transfer-pane references through JSON diagnostics.
    return Array.from(this._breakouts.values(), ({ breakoutId, channelId, windowKey, title, createdAt, ready }) =>
      ({ breakoutId, channelId, windowKey, title, createdAt, ready: ready === true }));
  }

  _breakoutIsCurrent(record) {
    return !!record && !this._stopped && this._breakouts.get(record.channelId) === record;
  }

  _breakoutScroller(record) {
    const root = record?.root;
    const messages = root?.querySelector?.('[data-list-id="chat-messages"], [role="log"]');
    return messages?.closest?.('[class*="scroller_"]') ??
      root?.querySelector?.('[class*="messagesWrapper_"] [class*="scroller_"]') ?? null;
  }

  _breakoutIsViewed(record) {
    const doc = record?.root?.ownerDocument;
    const scroller = this._breakoutScroller(record);
    return this._breakoutIsCurrent(record) && record.ready === true && record.root?.isConnected === true &&
      doc?.visibilityState === 'visible' && doc.hasFocus?.() === true && !doc.defaultView?.closed &&
      !!scroller && scroller.clientHeight > 0 && scroller.clientHeight <= doc.defaultView.innerHeight &&
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 24;
  }

  _activateBreakout(recordOrChannelId, messageId) {
    const record = typeof recordOrChannelId === 'object' ? recordOrChannelId :
      this._breakouts.get(recordOrChannelId) || Array.from(this._breakouts.values()).find(r => r.windowKey === recordOrChannelId);
    if (!this._breakoutIsViewed(record)) return { ok: false, skipped: 'Breakout is not being viewed at the bottom' };
    // Never enable unconditional automatic ACK or clear the whole local unread
    // state. A minimized, blurred or history-scrolled window is not a read receipt.
    try {
      if (typeof this._modules.AckActions?.ack !== 'function') return { ok: false, skipped: 'Native acknowledgement unavailable' };
      this._modules.AckActions.ack(record.channelId, undefined, true, true, messageId);
      record.lastActivatedAt = new Date().toISOString();
      return { ok: true, channelId: record.channelId };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  _releaseBreakout(record) {
    if (!record) return;
    record.disposeMount?.();
    if (record.setupTimer != null) window.clearTimeout(record.setupTimer);
    record.setupTimer = null;
    record.releaseAttachmentScan?.();
    delete record.releaseAttachmentScan;
    record.menuUnpatch?.();
    if (record.searchContext && this._breakouts.get(record.channelId) === record) {
      try { this._nativeSearchService?.service.cleanUpSearchState(record.searchContext); } catch { /* host changed */ }
    }
    record.searchContext = null;
    record.refreshHeader = null;
    record.root = null;
    record.showSearch = null;
    record.ready = false;
    record.transfer = null;
    if (this._breakouts.get(record.channelId) !== record) return;
    this._breakouts.delete(record.channelId);
    if (!this._breakouts.size) {
      this._removeBreakoutAckBridge();
      this._breakoutSearchUnpatch?.();
      this._breakoutSearchUnpatch = null;
      this._restoreBreakoutInputPatches();
    }
  }

  _completeBreakoutTransfer(record) {
    const transfer = record.transfer;
    if (!record.ready || !transfer || !this._breakoutIsCurrent(record)) return;
    record.transfer = null;
    // A later split open/close/navigation owns the pane now, even for the same
    // channel. Never close a replacement pane or the native main chat.
    if (this._splitChannelId === record.channelId && this._paneEl === transfer.pane &&
        this._openEffectsEpoch === transfer.epoch) this.close();
  }

  _waitForBreakout(record, attempt = 0) {
    if (!this._breakoutIsCurrent(record)) return;
    const root = record.root;
    const failed = root?.querySelector?.('.ssv-placeholder-diagnostic, .ssv-breakout-diagnostic');
    const messages = root?.querySelector?.('[data-list-id="chat-messages"], [role="log"]');
    const history = this._modules.MessageStore?.getMessages?.(record.channelId);
    const historyReady = history?.ready === true && !history.cached && !history.loadingMore;
    const scroller = this._breakoutScroller(record);
    const viewportHeight = root?.ownerDocument?.defaultView?.innerHeight;
    // Native styles arrive after mount. An unstyled full-history list is not
    // a usable viewport, even though its height is positive and history is ready.
    const viewportReady = scroller?.clientHeight > 0 && scroller.clientHeight <= viewportHeight;
    if (!failed && historyReady && root?.isConnected && messages && viewportReady) {
      record.ready = true;
      this._completeBreakoutTransfer(record);
      this._activateBreakout(record);
      return;
    }
    if (failed || attempt >= 100) {
      record.failed = true;
      record.transfer = null;
      this._toast('Breakout chat did not become ready; the split was kept open', 'warning');
      return;
    }
    record.setupTimer = window.setTimeout(() => {
      record.setupTimer = null;
      this._waitForBreakout(record, attempt + 1);
    }, 100);
  }

  _getBreakoutWindowKey(channelId) {
    // Electron closes windows asynchronously. Reusing the same host key can
    // let the previous close destroy an immediately reopened window.
    this._breakoutWindowEpoch ??= Date.now().toString(36);
    return `DISCORD_SSV_BREAKOUT_${channelId}_${this._breakoutWindowEpoch}_${this._breakoutCounter + 1}`;
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

  _getBreakoutHeaderAdapter(channel) {
    // Cache component types/methods only, never a selected-channel action closure.
    if (!this._breakoutHeaderAdapter) {
      try {
        const pins = document.querySelector('section [aria-label="Pinned Messages"]');
        const adapter = this._getNativePinsAdapter({ channelId: this._getSelectedChannelId(), actions: [{ key: 'pins', el: pins }] });
        let fiber = pins && BdApi.ReactUtils?.getInternalInstance(pins), owner;
        for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
          if (typeof fiber.stateNode?.openChannelContextMenu === 'function' &&
              typeof fiber.stateNode?.openThreadContextMenu === 'function' &&
              typeof fiber.stateNode?.renderSidebar === 'function') { owner = fiber.stateNode; break; }
        }
        if (adapter && owner) {
          const sidebar = owner.renderSidebar.call({ props: { channel, section: 'SEARCH' } });
          this._breakoutHeaderAdapter = { Popout: adapter.Popout, Content: adapter.Content,
            SearchResultsLoader: sidebar?.type, openChannelMenu: owner.openChannelContextMenu,
            openThreadMenu: owner.openThreadContextMenu };
        }
      } catch (error) { this._dbg('Breakout header adapter unavailable:', error.message); }
    }
    return this._breakoutHeaderAdapter ?? null;
  }

  _getNativeSearchService() {
    if (this._nativeSearchService) return this._nativeSearchService;
    try {
      const W = BdApi.Webpack;
      const service = W?.getModule(m => typeof m?.getSearchInputText === 'function' &&
        typeof m?.cleanUpSearchState === 'function' && typeof m?.fetchMessages === 'function', { searchExports: true });
      const query = W?.getModule(m => typeof m?.updateSearchQueryText === 'function' &&
        typeof m?.updateSearchMode === 'function', { searchExports: true });
      if (service && query) this._nativeSearchService = { service, query };
    } catch { /* native search changed: leave it unavailable */ }
    return this._nativeSearchService ?? null;
  }

  _installBreakoutSearchScope() {
    if (this._breakoutSearchUnpatch) return true;
    try {
      const factory = BdApi.Webpack?.getModule(m => typeof m?.create === 'function' &&
        String(m.create).includes('searchType') && typeof m.cancel === 'function' && typeof m.get === 'function', { searchExports: true });
      if (!factory || !this._getNativeSearchService()) return false;
      this._breakoutSearchUnpatch = BdApi.Patcher.before(PLUGIN_NAME, factory, 'create', (_self, args) => {
        const request = args[0], record = this._breakouts.get(request?.id);
        // GUILD_CHANNEL has a channel-keyed result store but still needs an
        // explicit filter. Never infer request ownership from OS focus.
        if (request?.searchType !== 'GUILD_CHANNEL' || !request.searchQuery ||
            !this._breakoutIsCurrent(record) || !record.root?.isConnected) return;
        args[0] = { ...request, searchQuery: { ...request.searchQuery, channel_id: [record.channelId], search_everywhere: false } };
      });
      return typeof this._breakoutSearchUnpatch === 'function';
    } catch { return false; }
  }

  _submitBreakoutSearch(record, queryText) {
    if (!this._breakoutIsCurrent(record) || !record.root?.isConnected || !this._breakoutSearchUnpatch) return false;
    const native = this._getNativeSearchService(), channel = this._getChannel(record.channelId);
    if (!native || !channel?.guild_id || !queryText.trim()) return false;
    const context = { type: 'GUILD_CHANNEL', guildId: channel.guild_id, channelId: channel.id };
    native.query.updateSearchQueryText(context, queryText);
    record.searchContext = context;
    record.showSearch?.(true);
    native.service.fetchMessages({ searchContext: context, searchQueryString: queryText, offset: 0, searchEverywhere: false });
    return true;
  }

  _openBreakoutMenu(record, adapter, event) {
    if (!this._breakoutIsCurrent(record)) return;
    const channel = this._getChannel(record.channelId);
    if (!channel || typeof BdApi.ContextMenu?.patch !== 'function') return;
    record.menuUnpatch?.();
    const current = () => this._breakoutIsCurrent(record) && record.root?.isConnected;
    const disposers = ['channel-context', 'thread-context'].map(id => BdApi.ContextMenu.patch(id, (tree, props) => {
      if (props?.channel?.id !== channel.id || !current()) return;
      const guarded = this._guardHeaderMenuTree(tree, current);
      if (!guarded?.props) return;
      const onClose = guarded.props.onClose;
      tree.props = { ...guarded.props, onClose: (...args) => {
        record.menuUnpatch?.();
        return onClose?.(...args);
      } };
    }));
    record.menuUnpatch = () => { disposers.forEach(fn => fn?.()); record.menuUnpatch = null; };
    try {
      const method = this.isThreadChannel(channel) ? adapter.openThreadMenu : adapter.openChannelMenu;
      method.call({ props: { guild: this._modules.GuildStore?.getGuild?.(channel.guild_id) } }, event, channel);
    } catch (error) { record.menuUnpatch?.(); this._dbg('Breakout menu unavailable:', error.message); }
  }

  _buildBreakoutContent(channelId, breakoutId, windowKey) {
    const { React, SplitViewComponent, ChatInputTypes, GuildStore } = this._modules;
    const channel = this._getChannel(channelId);
    const guildId = this._getChannelGuildId(channel);
    const guild = guildId ? (GuildStore?.getGuild?.(guildId) ?? null) : null;
    const ErrorBoundary = this._getErrorBoundary();
    const title = this._getChannelDisplayName(channel);
    const plugin = this;
    const adapter = this._getBreakoutHeaderAdapter(channel);

    function BreakoutHeader() {
      const [pinsOpen, setPinsOpen] = React.useState(false);
      const [, refresh] = React.useState(0);
      const pinsRef = React.useRef(null);
      const current = () => plugin._breakouts.get(channelId)?.breakoutId === breakoutId && !plugin._stopped;
      React.useEffect(() => {
        const record = plugin._breakouts.get(channelId);
        if (!current()) return;
        const update = () => refresh(value => value + 1);
        record.refreshHeader = update;
        return () => { if (record.refreshHeader === update) record.refreshHeader = null; };
      }, []);
      const parent = plugin.isThreadChannel(channel) ? plugin._getChannel(channel.parent_id) : null;
      const fullTitle = parent?.name ? `#${parent.name} › ${channel.name}` : title;
      const label = plugin._settings.hideParentChannelInSplit && parent ? channel.name : fullTitle;
      const closePins = () => { setPinsOpen(false); pinsRef.current?.focus(); };
      const close = React.createElement('button', { type: 'button', className: 'ssv-pane-header-btn',
        title: `Close ${title}`, 'aria-label': `Close ${title}`, onClick: () => { if (current()) plugin.closeBreakout(channelId); } }, '×');
      const name = React.createElement('div', { className: 'ssv-breakout-title', title: fullTitle }, label);
      if (!adapter) return React.createElement('div', { className: 'ssv-breakout-header' }, close, name,
        React.createElement('span', { title: 'Open a guild channel in the main window, then reopen this breakout to discover native controls.' }, 'Controls unavailable'));
      const pins = React.createElement(adapter.Popout, { key: 'pins', targetElementRef: pinsRef, shouldShow: pinsOpen,
        position: 'bottom', align: 'right', autoInvert: true, nudgeAlignIntoViewport: true, spacing: 8,
        ignoreModalClicks: true, clickTrap: true, onRequestClose: closePins,
        renderPopout: props => current() ? React.createElement(adapter.Content, { ...props, channel,
          onJump: event => { if (!event?.shiftKey) closePins(); } }) : null,
        children: trigger => React.createElement('button', { ...trigger, ref: pinsRef, type: 'button',
          className: 'ssv-pane-header-btn', 'aria-label': 'Pinned Messages', title: 'Pinned Messages',
          'aria-haspopup': 'dialog', 'aria-expanded': pinsOpen,
          onClick: () => { if (current()) setPinsOpen(value => !value); },
          onKeyDown: event => { if (event.key === 'Escape' && pinsOpen) { event.preventDefault(); closePins(); } } },
          React.createElement('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
            React.createElement('path', { d: PIN_ICON_PATH }))) });
      const openMore = event => { if (current()) plugin._openBreakoutMenu(plugin._breakouts.get(channelId), adapter, event); };
      const more = React.createElement('button', { key: 'more', type: 'button', className: 'ssv-pane-header-btn',
        title: 'More channel actions', 'aria-label': 'More', 'aria-haspopup': 'menu',
        onClick: openMore,
        onKeyDown: event => { if (event.key === 'ArrowDown' && current()) { event.preventDefault(); openMore(event); } },
      }, '⋯');
      // An owned input avoids native global search subscriptions duplicating
      // requests across windows. Parsing, filters, results and pagination stay native.
      const search = React.createElement('input', { key: 'search', type: 'search', className: 'ssv-breakout-search',
        placeholder: 'Search this chat', 'aria-label': `Search ${title}`, maxLength: 512,
        disabled: !plugin._breakoutSearchUnpatch, title: 'Search this chat using Discord search syntax',
        onKeyDown: event => {
          if (event.key === 'Enter' && current()) {
            event.preventDefault(); event.stopPropagation();
            plugin._submitBreakoutSearch(plugin._breakouts.get(channelId), event.currentTarget.value);
          } else if (event.key === 'Escape') plugin._breakouts.get(channelId)?.showSearch?.(false);
        } });
      return React.createElement(plugin._modules.Header, { className: 'ssv-breakout-header',
        guildId, channelId, channelType: channel.type, toolbar: [pins, more, search],
        hideSearch: true, 'aria-label': 'Breakout chat header',
      }, close, name);
    }

    function ScopedSearchResults() {
      const discover = () => BdApi.Webpack?.getModule(m => typeof m === 'function' &&
        String(m).includes('selectedChannelId:') && String(m).includes('guildId:') && String(m).length < 500, { searchExports: true });
      const [Implementation, setImplementation] = React.useState(() => discover());
      React.useEffect(() => {
        if (Implementation) return;
        let timer, attempts = 0, cancelled = false;
        const check = () => {
          if (cancelled) return;
          const component = discover();
          if (component) setImplementation(() => component);
          else if (++attempts < 40) timer = window.setTimeout(check, 250);
        };
        check();
        return () => { cancelled = true; window.clearTimeout(timer); };
      }, [Implementation]);
      if (!Implementation) return React.createElement(React.Fragment, null,
        // Load the native lazy chunk without mounting a guild-keyed result panel.
        adapter?.SearchResultsLoader && React.createElement(adapter.SearchResultsLoader, {}),
        React.createElement('div', { role: 'status' }, 'Loading native search results…'));
      return React.createElement(ScopedLoadedResults, { Implementation });
    }

    function ScopedLoadedResults({ Implementation }) {
      // Invoke the native wrapper as a component body so its hooks keep their
      // owner, then override only the context on its native result component.
      const tree = Implementation({ guildId, channelId });
      return tree && React.cloneElement(tree, { searchContext: { type: 'GUILD_CHANNEL', guildId, channelId } });
    }

    const BreakoutRoot = function BreakoutRoot() {
      const ref = React.useRef?.(null);
      const [searchOpen, showSearch] = React.useState?.(false) ?? [false, () => {}];
      React.useEffect?.(() => {
        const record = plugin._breakouts.get(channelId);
        if (plugin._stopped || record?.breakoutId !== breakoutId) return;
        const release = plugin._retainAttachmentScanTarget(channelId);
        record.releaseAttachmentScan = release;
        record.root = ref.current;
        record.showSearch = showSearch;
        const doc = record.root?.ownerDocument;
        plugin._syncBreakoutDocumentStyles(doc);
        if (doc) doc.title = title;
        plugin._ensureNativeHistory(channelId);
        const activate = () => plugin._activateBreakout(record);
        const unload = () => plugin._releaseBreakout(record);
        doc?.defaultView?.addEventListener?.('focus', activate);
        doc?.defaultView?.addEventListener?.('unload', unload);
        doc?.addEventListener?.('visibilitychange', activate);
        record.root?.addEventListener?.('scroll', activate, true);
        const mountedRoot = record.root;
        const token = {};
        record.mountToken = token;
        let disposed = false;
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          release();
          if (record.releaseAttachmentScan === release) delete record.releaseAttachmentScan;
          doc?.defaultView?.removeEventListener?.('focus', activate);
          doc?.defaultView?.removeEventListener?.('unload', unload);
          doc?.removeEventListener?.('visibilitychange', activate);
          mountedRoot?.removeEventListener?.('scroll', activate, true);
          if (record.mountToken === token) {
            record.root = null;
            record.ready = false;
          }
        };
        record.disposeMount = dispose;
        if (record.root && record.setupTimer == null) plugin._waitForBreakout(record);
        return () => {
          dispose();
          // React may replay effects during a mount. A new mount token retains
          // ownership; an old window's cleanup cannot erase a newer breakout.
          queueMicrotask(() => {
            if (record.mountToken === token && !record.root) plugin._releaseBreakout(record);
          });
        };
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
        React.createElement(BreakoutHeader),
        React.createElement('div', { className: 'ssv-breakout-body' }, native),
        searchOpen && adapter?.SearchResultsLoader ? React.createElement('div', { className: 'ssv-breakout-search-results' },
          React.createElement('button', { type: 'button', className: 'ssv-pane-header-btn',
            'aria-label': 'Close search results', title: 'Close search results', onClick: () => showSearch(false) }, '×'),
          React.createElement(ScopedSearchResults)) : null
      );
    };

    return React.createElement(BreakoutRoot, {});
  }

  openBreakout(channelId, channelHint = null, { source = 'context' } = {}) {
    if (!channelId || this._stopped) return { ok: false, error: 'Breakout requires an active plugin and a channelId' };
    if (!this._modules.ChannelStore) this.discoverModules();
    const channel = this._getChannel(channelHint ?? channelId);
    if (!channel || channel.id !== channelId || !this.isSplitTargetChannel(channel)) {
      const result = { ok: false, error: 'Breakout Chat opens available guild text channels and real Discord threads' };
      this._toast(result.error, 'warning');
      return result;
    }
    const transfer = source !== 'main' && this._splitChannelId === channelId && this._paneEl
      ? { pane: this._paneEl, epoch: this._openEffectsEpoch } : null;
    const existing = this._breakouts.get(channelId);
    if (existing) {
      const windowKey = existing.windowKey;
      if (existing.root?.ownerDocument?.defaultView?.closed ||
          (existing.failed && !this._modules.PopoutWindowStore?.getWindowOpen?.(windowKey))) this._releaseBreakout(existing);
      else {
        if (transfer) existing.transfer = transfer;
        if (existing.failed) { existing.failed = false; this._waitForBreakout(existing); }
        const win = existing.root?.ownerDocument?.defaultView ?? this._modules.PopoutWindowStore?.getWindow?.(windowKey);
        try { win?.focus?.(); } catch { /* focus may be denied by the host */ }
        this._completeBreakoutTransfer(existing);
        return { ok: true, reused: true, channelId, windowKey, ready: existing.ready === true };
      }
    }
    const windowKey = this._getBreakoutWindowKey(channelId);
    // Do not create a second window when Discord still owns one we did not mount.
    if (this._modules.PopoutWindowStore?.getWindowOpen?.(windowKey)) {
      try { this._modules.PopoutWindowStore.getWindow?.(windowKey)?.focus?.(); } catch { /* host denied focus */ }
      return { ok: true, reused: true, channelId, windowKey, ready: false };
    }
    const inspection = this.inspectBreakoutModules();
    if (!inspection.ok) {
      const result = { ok: false, error: `Missing breakout modules: ${inspection.missingRequired.join(', ')}`, inspection };
      this._recordCrashEvent('breakout-open-missing-modules', result);
      this._toast('Breakout modules missing; run BetterChatDebug.inspectBreakoutModules()', 'warning');
      return result;
    }
    this._installBreakoutInputPatches();
    this._installBreakoutAckBridge();
    this._installBreakoutSearchScope();
    const { React, PopoutActions, PopoutWindow } = this._modules;
    const breakoutId = ++this._breakoutCounter;
    const title = this._getChannelDisplayName(channel);
    const info = { breakoutId, channelId, windowKey, title, createdAt: new Date().toISOString() };
    const record = { ...info, transfer, ready: false };
    this._breakouts.set(channelId, record);
    try {
      PopoutActions.open(windowKey, () => this._withNativeProviders(React.createElement(PopoutWindow,
        { windowKey, withTitleBar: true, title, channelId },
        this._buildBreakoutContent(channelId, breakoutId, windowKey))), { width: 520, height: 560 });
      this._recordCrashEvent('breakout-open-requested', info);
      // Initial dimensions are defaults only: never resize or force always-on-top
      // after the user/native window manager has positioned the actual window.
      this._waitForBreakout(record);
      return { ok: true, pending: true, ...info };
    } catch (e) {
      this._releaseBreakout(record);
      const result = { ok: false, error: e.message, channelId, windowKey };
      this._recordCrashEvent('breakout-open-failed', result);
      this._toast('Breakout Chat failed; the split was kept open', 'error');
      return result;
    }
  }

  closeBreakout(channelIdOrWindowKey) {
    const record = this._breakouts.get(channelIdOrWindowKey) || Array.from(this._breakouts.values()).find(r => r.windowKey === channelIdOrWindowKey);
    if (!record) return { ok: false, error: 'Breakout not tracked', value: channelIdOrWindowKey };
    try {
      if (typeof this._modules.PopoutActions?.close !== 'function') throw new Error('Native window close unavailable');
      if (this._modules.PopoutActions.close(record.windowKey) === false) throw new Error('Native window close refused');
    } catch (e) {
      const result = { ok: false, error: e.message, channelId: record.channelId, windowKey: record.windowKey };
      this._recordCrashEvent('breakout-close-failed', result);
      this._toast('Breakout could not close; retry or use the window close button', 'warning');
      return result;
    }
    this._releaseBreakout(record);
    const result = { ok: true, channelId: record.channelId, windowKey: record.windowKey };
    this._recordCrashEvent('breakout-closed', result);
    return result;
  }

  closeAllBreakouts() {
    const records = Array.from(this._breakouts.values());
    const results = records.map(record => this.closeBreakout(record.channelId));
    // Disabling still releases plugin resources even if native close fails.
    if (this._stopped) for (const record of records) this._releaseBreakout(record);
    return { ok: results.every(result => result.ok), closed: results.filter(result => result.ok).length,
      failed: results.filter(result => !result.ok) };
  }

  // ─── Open / close ────────────────────────────────────────────────────────────

  open(channelId, channelHint = null, { automatic = false } = {}) {
    if (!channelId) { this._err('open() requires a channelId'); return; }

    // Lazy discovery if called before start() (e.g., from BetterChatDebug.open())
    if (!this._modules.ChannelStore) this.discoverModules();
    this._syncPersistenceAccount();
    if (!this._accountId) return;

    const channel = this._getChannel(channelHint ?? channelId);

    if (channel && !this.isSplitTargetChannel(channel)) {
      if (!automatic) this._toast('BetterChat opens guild text channels and real Discord threads', 'warning');
      return;
    }

    const selectedGuildId = this._getSelectedGuildId();
    const selectedChannelId = this._getSelectedChannelId();
    if (selectedChannelId && selectedChannelId === channelId) {
      this._recordCrashEvent('duplicate-open-same-channel-readonly', { channelId, selectedChannelId });
      if (!automatic) this._toast('Same channel open in both panes; BetterChat composer suppressed', 'info');
      this._dbg('Opening duplicate main/split channel in read-only split mode:', channelId);
    }
    const targetGuildId = this._getChannelGuildId(channel);
    if (selectedGuildId && targetGuildId && selectedGuildId !== targetGuildId) {
      if (!automatic) this._toast('Switch to that server before opening BetterChat', 'warning');
      this._dbg('Refusing cross-server BetterChat open:', { selectedGuildId, targetGuildId, channelId });
      return;
    }

    if (automatic && (!channel || !selectedGuildId || targetGuildId !== selectedGuildId)) return;
    if (automatic && this._splitChannelId === channelId && this._isPaneAttached() && this._reactRoot) return;
    // Discover native menu identities before a new split changes the main
    // toolbar's React tree; discovering inside its portal render can see WIP fibers.
    this._getBreakoutHeaderAdapter(channel);
    this._cancelSplitRestore();
    this._clearNativeRenderRetries();
    this._cancelOpenEffects();
    this._splitChannelId = channelId;
    this._splitGuildId = targetGuildId;
    if (!automatic) this._rememberActiveSplit(channelId);

    if (this._isPaneDetached()) {
      this._dbg('Clearing detached pane before opening new split target');
      this.destroyDockedPane();
    }

    if (!this._paneEl && !this.createDockedPane(automatic)) {
      this._splitChannelId = null;
      this._splitGuildId = null;
      return;
    }
    this._scheduleDockedRight('split-open');
    if (!automatic) {
      const epoch = this._openEffectsEpoch;
      this._memberListTimer = window.setTimeout(() => {
        this._memberListTimer = null;
        if (!this._stopped && epoch === this._openEffectsEpoch) this._closeMemberListIfOpen();
      }, 100);
    }

    this._syncHeaderTitles();

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
      this._scheduleNativeRenderRetry(channelId, channel, result, automatic);
    }

    this._log(`Opened ${channelId}${channel ? ` (#${channel.name})` : ''} [${this._renderMode}]`);
    if (!automatic) this._scheduleScrollToBottom('both', 'split-open');
  }

  _cancelOpenEffects() {
    this._openEffectsEpoch++;
    if (this._memberListTimer) window.clearTimeout(this._memberListTimer);
    this._memberListTimer = null;
    for (const timer of this._scrollTimers) window.clearTimeout(timer);
    this._scrollTimers.clear();
  }

  _teardownSplit() {
    this._cancelSplitRestore();
    this._cancelOpenEffects();
    if (this._remountTimer) window.clearTimeout(this._remountTimer);
    this._remountTimer = null;
    for (const timer of this._redockTimers) window.clearTimeout(timer);
    this._redockTimers.clear();
    this._clearNativeRenderRetries();
    this._splitChannelId = null;
    this._splitGuildId = null;
    this._renderMode = 'none';
    this._paneEl?.classList.remove('ssv-duplicate-main-channel');
    this.destroyDockedPane();
    this._splitSearchTarget = null;
  }

  close() {
    this._forgetActiveSplit();
    this._teardownSplit();
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
      this._ensurePaneDockedRight('window-resize');
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
    this._resizeMoved = false;
    this._resizeStartX = e.clientX;
    this._resizeStartWidth = this._settings?.paneMode === 'floating'
      ? this._settings.floatingRect.width
      : (this._paneEl?.getBoundingClientRect().width || this._settings.currentWidth);
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
    if (!delta && !this._resizeMoved) return;
    this._resizeMoved = true;
    const maxW  = this._settings?.paneMode === 'floating' ? Math.floor(window.innerWidth - 24) : Math.floor(window.innerWidth * 0.8);
    const newW  = Math.max(MIN_WIDTH, Math.min(maxW, this._resizeStartWidth + delta));
    this._settings.currentWidth = newW;
    if (this._settings?.paneMode === 'floating') {
      this._settings.floatingRect = this._clampFloatingRect({ ...this._settings.floatingRect, width: newW });
      this._applyFloatingRect(this._settings.floatingRect);
    } else {
      this._applyDockedLayout();
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
        label: 'Split this chat',
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
        if (props?.betterChatCompactToolbar) return; // More already contains native thread options.
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
    console.log('[BetterChat] Pane inspection:', result);
    return result;
  }

  // ─── Debug API ───────────────────────────────────────────────────────────────

  _installDebugAPI() {
    const api = {
      dumpStatus: () => {
        const moduleStatus = Object.fromEntries(
          Object.entries(this._modules).map(([k, v]) => [k, v != null ? '✓' : '✗'])
        );
        console.group('[BetterChat] Status');
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
          const result = { ok: false, error: 'openNative requires a channelId or an active BetterChat target.' };
          this._log('openNative(undefined):', result);
          return result;
        }
        this.discoverModules();

        const channel = this._getChannel(channelId);
        if (channel && !this.isSplitTargetChannel(channel)) {
          const result = { ok: false, error: 'BetterChat accepts guild text/announcement channels and real Discord thread channel ids.' };
          this._renderMode = 'placeholder';
          this._toast('BetterChat opens guild text channels and real Discord threads', 'warning');
          this._log(`openNative(${channelId}):`, result);
          return result;
        }

        this._splitChannelId = channelId;
        this._rememberActiveSplit(channelId);

        if (!this._paneEl && !this.createDockedPane()) return { ok: false, error: 'safe layout container not found' };

        this._syncHeaderTitles();

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
        breakouts: this._listBreakoutStatus(),
      }),
      listBreakouts: () => this._listBreakoutStatus(),
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
          hideParentChannelInSplit: false,
          rememberSplitPerServer: false,
          rememberedSplits: Object.create(null),
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

      inspectLayout: () => this._inspectLayout(),
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
        console.log('[BetterChat] Crash log:', log);
        return log;
      },
      copyCrashLog: async () => {
        const text = this._formatCrashLog();
        await navigator.clipboard?.writeText?.(text);
        console.log('[BetterChat] Crash log copied to clipboard');
        return { copied: true, bytes: text.length };
      },
      downloadCrashLog: () => {
        const text = this._formatCrashLog();
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `betterchat-crash-log-${Date.now()}.json`;
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
        this._toast('Deprecated: same-channel BetterChat now suppresses its duplicate composer by default', 'info');
        this._applyDuplicateChannelMode('debug-deprecated-diagnostic-toggle');
        return {
          allowDuplicateChannelForDiagnostics: this._allowDuplicateChannelForDiagnostics,
          note: 'Same-channel mode now keeps BetterChat open and suppresses the split-pane composer by default.',
        };
      },

      discoverModules: () => {
        const result = this.discoverModules();
        console.log('[BetterChat] Module discovery result:', result);
        return result;
      },
    };
    this._debugAPI = api;
    window.BetterChatDebug = api;
    window.SplitViewDebug = api; // Compatibility for existing diagnostic commands.
    this._dbg('BetterChatDebug installed on window');
  }

  _removeDebugAPI() {
    if (window.BetterChatDebug === this._debugAPI) delete window.BetterChatDebug;
    if (window.SplitViewDebug === this._debugAPI) delete window.SplitViewDebug;
    this._debugAPI = null;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  start() {
    try {
      this._stopped = false;
      this._attachmentScanWarned = false;
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
      this._removeAttachmentScanBridge();
      this._removeLayoutPersistence();
      this._clearDeferredTimers();
      this._removeSelectedChannelPersistence();
      window.removeEventListener('resize', this._onWindowResize);
      this._cancelResize();
      this._cancelFloatingResize();
      this._renderMode = 'none';
      this.closeAllBreakouts();
      this._removeBreakoutAckBridge();
      this._breakoutSearchUnpatch?.();
      this._breakoutSearchUnpatch = null;
      this._restoreBreakoutInputPatches();
      this._teardownSplit();
      this.unpatchContextMenus();
      try { BdApi.Patcher?.unpatchAll?.(PLUGIN_NAME); } catch { /* ignore if patcher not used yet */ }
      this.removeStyles();
      this._removeDebugAPI();
      this._removeCrashDiagnostics();
      this._modules = {};
      this._accountId = undefined;
      this._contextChannelCache.clear();
      this._SsvErrorBoundary = null;
      this._log('Stopped');
    } catch (e) {
      this._err('stop() error:', e);
    }
  }
};
