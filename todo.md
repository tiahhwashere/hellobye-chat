# Request AV — advanced voice UI + fix lag / voice delay / whole delay

## Diagnosis
- [x] Socket starts on `['polling','websocket']` → every message waits for the HTTP long-poll upgrade (~1-2s). Should try websocket first.
- [x] Voice start delay: `getUserMedia` is awaited on every tap (device init + permission). No pre-warm.
- [x] Voice stop→preview delay: `recorder.start()` with NO timeslice → all data buffered until stop; `onstop` waits for the final blob.
- [x] Voice send delay: upload round-trip blocks any feedback; nothing shown until the server echoes back.
- [x] Render lag: `markContinuation` does `serverMessages.find()` (O(n)) per message → O(n²) on render; `scrollBottom()` writes scrollTop synchronously on every append (layout thrash).
- [x] Audio in messages uses bare `<audio controls>` (no preload, no custom UI).

## Tasks
- [x] Advanced voice recorder panel: live waveform canvas, timer, pause/resume, discard, send, sending spinner
- [x] Advanced in-chat voice player: custom play/pause, waveform seek, duration, speed toggle, download
- [x] Fix socket transport (websocket-first) + server ping tuning
- [x] Fix voice start latency (pre-warm mic on pointerdown)
- [x] Fix voice stop latency (timeslice recording)
- [x] Fix voice send latency (optimistic local echo)
- [x] Fix render lag (O(1) message index, rAF batched scroll, fragment render)
- [x] Verify syntax + local smoke test, no data loss
- [x] Commit + push + verify Render deploy live
