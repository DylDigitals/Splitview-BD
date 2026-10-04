# BetterChat for BetterDiscord

**Version 0.1.227** — native Discord split chat and breakout windows.
Formerly published as SplitView; the repository URL is unchanged.

Keep a channel or thread beside your main chat, or open it in a separate breakout
window. Discord still owns messages, attachments, the composer, typing indicators
and slash commands. BetterChat arranges those native surfaces instead of replacing
them.

## Features

- Resizable docked or floating split pane.
- Multiple independent breakout windows alongside the split and main chat.
- Channel-scoped Pins, More and native Search on supported split/breakout headers.
- Readiness-gated split-to-breakout transfer and safe window reuse/cleanup.
- Native loading for unvisited channels and threads.
- Optional **Remember split chat per server**, off by default.

See [CHANGELOG.md](CHANGELOG.md) for the iteration-by-iteration changes and known
compatibility limits. Only the final build is published by this update.

## Install or upgrade

No build step is required. Download
[BetterChat.plugin.js](https://raw.githubusercontent.com/DylDigitals/Splitview-BD/main/BetterChat.plugin.js).

1. In Discord, open **Settings → Plugins → Open Plugins Folder**.
2. Disable your existing BetterChat or SplitView plugin and back up its file.
3. Remove the old `SplitView.plugin.js` file, if present. **Keep
   `SplitView.config.json` and all other saved configuration.**
4. Put `BetterChat.plugin.js` in that folder. Keep only one plugin copy.
5. Reload Discord with **Ctrl+R**, then enable **BetterChat**.

The filename/name changed; the legacy settings namespace remains compatible.
Existing SplitView users should migrate manually rather than rely on the old
update URL. Same-version 0.1.227 test builds also require manual replacement.

## Use

- Right-click a supported channel/thread → **Split this chat**.
- In the split header, use **More → Break out chat** for a separate window. The
  split stays open until its replacement is ready.
- Resize, close or float the split using its controls. Dimensions are saved locally.
- Enable **Remember split chat per server** in BetterChat's settings if desired.
  Returning to a server restores its remembered split; explicit Close forgets it.
  With this setting off, full-restart target restoration is not enabled.

Supported: guild text/announcement channels and public/private/news threads.
Not supported: DMs, group DMs, forums and voice channels.

## Status and troubleshooting

The final behavior has 126 passing automated tests and bounded live Linux checks.
Windows/macOS and every attachment/read-state edge case are not certified. Native
window creation can take roughly 1–2 seconds. A native duplicate menu-listener
warning can still appear with multiple windows; menus and cleanup worked in the
checked cycles. See the [changelog](CHANGELOG.md#verification-and-compatibility).

Discord updates may change its internal APIs. If a pane stops rendering, disable
BetterChat and report your Discord/BetterDiscord versions, platform and steps to
reproduce at the [issue tracker](https://github.com/DylDigitals/Splitview-BD/issues).

Optional DevTools diagnostics:

```js
BetterChatDebug.dumpStatus()
BetterChatDebug.inspectPane()
BetterChatDebug.printCrashLog()
```

Inspect output and remove channel IDs or other personal data before sharing.

## Privacy and license

Diagnostics stay local. BetterChat adds no telemetry or external message-content
collection. Native Discord network operations remain Discord's responsibility.

MIT — see [LICENSE](LICENSE).
