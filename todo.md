# Request AU — message layout, mobile, server fixes, voice messages

## Diagnosis (done)
- [x] Invisible messages root cause: 7 legacy "zombie" messages stored with only an `e2e` envelope (no plaintext `text`), key is client-side only & unrecoverable → render as empty divs. Fix = graceful placeholder.
- [x] Channel drag-out bug: top-level "Text Channels" drop target only renders when uncategorised channels exist → can't drag out when all channels are categorised.
- [x] Scale preview bug: settings preview clips the icon (bottom:-30px inside overflow:hidden banner) and shows an icon the header no longer displays.

## Tasks
- [x] Improve message layout (grouping/spacing/typography, NO background layouts behind messages) — servers.html + index.html
- [x] Fix mobile support (100dvh, safe-area, scrolling, sizing) — servers.html + index.html
- [x] Fix Icon & Banner Scale preview in servers (settings + modal)
- [x] Allow dragging a channel back out of a category (always render top-level drop target)
- [x] Fix remaining invisible messages in server (graceful placeholder)
- [x] Add voice message system beside send media (record, preview, send)
- [x] Verify syntax + local smoke test, no data loss
- [ ] Commit + push + verify Render deploy live
