import io

path = 'index.html'
with io.open(path, 'r', encoding='utf-8') as f:
    s = f.read()

# ============================================================
# TASK 1: Add broader Enter-to-send on the media-send-modal
# ============================================================
# Current: Enter only works when the caption textarea is focused.
# New: Add a keydown listener on the modal overlay itself so Enter sends
# even if focus is elsewhere (e.g., on the modal but not in the textarea).
# Also add Enter on the media-send-confirm button and the preview area.
# Keep Shift+Enter for newlines in the caption textarea.

old_enter = """$('media-send-caption').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('media-send-confirm').click(); }
});"""

new_enter = """$('media-send-caption').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('media-send-confirm').click(); }
});
// Broader Enter-to-send: capture Enter on the entire modal so it sends
// even when focus is not in the caption textarea (e.g. just opened, or
// focus is on a button/preview). Shift+Enter still inserts a newline
// when the caption textarea is focused.
$('media-send-modal').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    // Don't interfere if the user is typing in the caption textarea —
    // the textarea's own handler above already deals with that case.
    if (e.target === $('media-send-caption')) return;
    e.preventDefault();
    $('media-send-confirm').click();
  }
});"""

assert old_enter in s, "Could not find old Enter handler for media-send-caption"
s = s.replace(old_enter, new_enter, 1)
print("Task 1: Added broader Enter-to-send on media-send-modal overlay")

with io.open(path, 'w', encoding='utf-8') as f:
    f.write(s)
print("File written successfully")
