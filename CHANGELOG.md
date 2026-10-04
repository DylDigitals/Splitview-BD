# BetterChat changelog

## 0.1.227 — Functional release

This release brings the SplitView plugin forward under the **BetterChat** name.
The repository URL remains unchanged. Install only `BetterChat.plugin.js`; remove
the old `SplitView.plugin.js` file but keep saved configuration.

The entries below document the development progression. Intermediate builds are
not separate public releases; this update publishes only the final 0.1.227 build.

### 0.1.227 — Breakout parity and lifecycle completion

- Added **Break out chat** to split-header More menus, replacing redundant split
  actions while preserving native channel/thread menu entries.
- Added breakout Close/title/Pins/More/Search controls with native menus and search
  results owned by the correct window. Search retains native parsing and pagination.
- Kept the source split open until the breakout has loaded native history and a
  usable viewport. A window-open request alone no longer counts as success.
- Fixed a startup layout race where an unstyled, oversized message list could be
  mistaken for a ready viewport and close the source split too early.
- Reused existing breakout windows; protected close/reopen and pending operations
  from stale callbacks. Close failures do not silently discard tracking.
- Initialized cold history through Discord's native MessageManager.
- Restricted plugin read acknowledgements to ready, connected, visible, focused
  chats at the bottom. Scrolled-up incoming messages were checked for position
  and read-state preservation.
- Released search hooks, attachment targets, read listeners and readiness timers
  during close, disable and reload. Reused discovered modules instead of rescanning
  them on every open.

### 0.1.226 — Optional per-server split memory

- Added **Remember split chat per server**, off by default.
- Stored remembered targets separately by account and server; restored eligible
  targets when returning to a server, including after restart.
- Distinguished server navigation from explicit Close: leaving preserves opted-in
  memory; Close forgets that server's target.
- Kept startup at Friends from forcing navigation. Disabling the setting clears
  that account's remembered targets without closing its visible split.
- Guarded restoration against stale callbacks, account changes and unavailable
  channels. Discord continues to own drafts; exact scroll-position persistence
  across restart is not promised.

### 0.1.225 — Title-first headers

- Put titles before Pins and More, with split Search at the far right and Close
  on the left.
- Hid the parent-channel icon and separator together with an optional hidden
  breadcrumb, while retaining the native Threads control.
- Preserved reversible native-toolbar cleanup.

### 0.1.224 — Channel controls and responsive layout

- Added visible, channel-scoped More and Pins controls to supported split headers.
- Added title truncation, full-title hover text and a persistent breadcrumb switch.
- Removed the visible split-only search cue without changing request scope.
- Kept Members in the far-right lane and accounted for sidebar widths.
- Contained native previews and suspended the pane when space was insufficient.
- Prevented suspension from zeroing the virtual scroller and jumping to bottom.

### 0.1.223 — Loading and header hardening

- Initialized unvisited channel/thread history using Discord's existing loader.
- Added the native-style Close icon, a working Threads control and native thread
  actions in More.
- Included child threads in channel search, retained native query parsing and
  restored native search on close/disable.

### 0.1.222 — Split-header search correction

- Replaced the earlier toolbar placement with a dedicated split header: Close and
  title on the left, native Search on the far right.
- Scoped supported same-server docked searches to the split channel/thread while
  retaining native results and pagination.
- Preserved the original native toolbar for unsupported layouts rather than
  presenting misleading scoped search.

### 0.1.221 — Compact toolbar iteration

- Grouped notifications, pins and member-list controls under More while retaining
  native thread actions.
- Added a rounded split-pane outline and aligned headers.
- Restored native controls when closing, floating or disabling the pane.
- The search placement in this iteration was superseded by 0.1.222.

### 0.1.220 — Consolidated baseline

- Consolidated the preceding attachment-scan integration, shared native title bar,
  aligned pane headers, thread-preview containment and resize-width correction.
- Standardized the **Split this chat** action and `BetterChat.plugin.js` filename.
- Preserved existing storage, saved settings and legacy diagnostic compatibility.
- This baseline still had cold-channel loading limitations, addressed later.

### Earlier baseline — 0.1.103 and 0.1.219

- 0.1.103 was the previous public SplitView version: native docked/floating chat,
  remembered dimensions, native composer and slash-command support.
- 0.1.219 was an intermediate consolidation before the 0.1.220 baseline. The
  consolidated changes are described above rather than presented as an additional
  public release.

## Verification and compatibility

- Automated regression suite: **126 tests passing** for the final plugin behavior.
- Linux live checks cover split/breakout rendering, transfer, native header/search,
  simultaneous windows, cleanup, disable/re-enable, selected read/scroll behavior
  and optional server restoration.
- Window opening still involves Discord's native rendering; observed openings
  were roughly 1–2 seconds, not instantaneous.
- Discord can emit a duplicate `CONTEXT_MENU_CLOSE` listener warning with multiple
  native window/menu surfaces. Menus worked and listeners cleaned up in the tested
  cycles; this release does not suppress native warnings.
- Windows/macOS are not certified for this final build. Long sessions, plugin
  conflicts, offline/permission-loss recovery, hidden/minimized read-state cases
  and the full fresh-attachment matrix remain broader compatibility checks.
- Discord internal updates can break native integration. Please report a minimal
  reproduction and platform/version details; remove personal data from diagnostics.
