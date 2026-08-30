import io

path = 'index.html'
with io.open(path, 'r', encoding='utf-8') as f:
    s = f.read()

# ============================================================
# TASK 2: Wider media embeds + non-cartoony professional design
# ============================================================

# --- 2a: Images: 360px → 480px, non-cartoony styling ---
old_img = """.message-file img {
  max-width: 360px; max-height: 360px; border-radius: 10px; display: block; cursor: pointer;
  object-fit: cover; image-rendering: -webkit-optimize-contrast;
  border: 1px solid var(--border);
  transition: border-color 0.15s ease, transform 0.15s ease;
  box-shadow: none;
}
.message-file img:hover { border-color: var(--border-light); transform: scale(1.01); }"""

new_img = """.message-file img {
  max-width: 480px; max-height: 480px; border-radius: 6px; display: block; cursor: pointer;
  object-fit: cover; image-rendering: -webkit-optimize-contrast;
  border: 1px solid rgba(255,255,255,0.06);
  transition: border-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
  box-shadow: 0 1px 3px rgba(0,0,0,0.25);
}
.message-file img:hover {
  border-color: rgba(255,255,255,0.12); transform: scale(1.015);
  box-shadow: 0 4px 14px rgba(0,0,0,0.35);
}"""

assert old_img in s, "Could not find old .message-file img CSS"
s = s.replace(old_img, new_img, 1)
print("2a: Updated .message-file img (480px, non-cartoony)")

# --- 2b: Videos: 380px → 500px, non-cartoony styling ---
old_video = """.message-file video {
  max-width: 380px; max-height: 360px; border-radius: 10px; border: 1px solid var(--border);
  box-shadow: none; background: #000;
  transition: border-color 0.15s ease, transform 0.15s ease;
}
.message-file video:hover { border-color: var(--border-light); transform: scale(1.01); }"""

new_video = """.message-file video {
  max-width: 500px; max-height: 480px; border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.06);
  box-shadow: 0 1px 3px rgba(0,0,0,0.25); background: #000;
  transition: border-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
}
.message-file video:hover {
  border-color: rgba(255,255,255,0.12); transform: scale(1.015);
  box-shadow: 0 4px 14px rgba(0,0,0,0.35);
}"""

assert old_video in s, "Could not find old .message-file video CSS"
s = s.replace(old_video, new_video, 1)
print("2b: Updated .message-file video (500px, non-cartoony)")

# --- 2c: Audio: 320px → 400px ---
old_audio = """.message-file audio { width: 320px; border-radius: 10px; }"""
new_audio = """.message-file audio { width: 400px; border-radius: 6px; }"""
assert old_audio in s, "Could not find old .message-file audio CSS"
s = s.replace(old_audio, new_audio, 1)
print("2c: Updated .message-file audio (400px)")

# --- 2d: File attachment card: 360px → 480px, non-cartoony ---
old_attach = """.message-file-attachment {
  display: flex; align-items: center; gap: 12px;
  padding: 11px 14px; background: var(--bg-darker);
  border: 1px solid var(--border); border-radius: 10px;
  text-decoration: none; color: var(--text-primary);
  transition: border-color 0.15s ease, background 0.15s ease, transform 0.12s ease;
  max-width: 360px;
  box-shadow: none;
}
.message-group.own .message-file-attachment { background: rgba(0,0,0,0.15); border-color: rgba(255,255,255,0.12); }
.message-file-attachment:hover { border-color: var(--border-light); background: var(--bg-dark); transform: translateY(-1px); }
.message-group.own .message-file-attachment:hover { background: rgba(0,0,0,0.22); }"""

new_attach = """.message-file-attachment {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px; background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.07); border-radius: 6px;
  text-decoration: none; color: var(--text-primary);
  transition: border-color 0.2s ease, background 0.2s ease, transform 0.15s ease, box-shadow 0.2s ease;
  max-width: 480px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.2);
}
.message-group.own .message-file-attachment { background: rgba(0,0,0,0.18); border-color: rgba(255,255,255,0.10); }
.message-file-attachment:hover {
  border-color: rgba(255,255,255,0.14); background: rgba(255,255,255,0.06);
  transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.3);
}
.message-group.own .message-file-attachment:hover { background: rgba(0,0,0,0.25); }"""

assert old_attach in s, "Could not find old .message-file-attachment CSS"
s = s.replace(old_attach, new_attach, 1)
print("2d: Updated .message-file-attachment (480px, non-cartoony)")

# --- 2e: File icon: slightly larger, less rounded, cleaner ---
old_icon = """.file-icon {
  width: 40px; height: 40px; border-radius: 10px;
  background: var(--accent-dim); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 700; flex-shrink: 0;
  letter-spacing: 0.3px;
}"""

new_icon = """.file-icon {
  width: 42px; height: 42px; border-radius: 6px;
  background: var(--accent-dim); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 700; flex-shrink: 0;
  letter-spacing: 0.3px;
}"""

assert old_icon in s, "Could not find old .file-icon CSS"
s = s.replace(old_icon, new_icon, 1)
print("2e: Updated .file-icon (42px, 6px radius)")

with io.open(path, 'w', encoding='utf-8') as f:
    f.write(s)
print("All desktop CSS changes written successfully")
