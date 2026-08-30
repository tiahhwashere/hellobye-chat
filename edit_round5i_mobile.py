import io

path = 'index.html'
with io.open(path, 'r', encoding='utf-8') as f:
    s = f.read()

# ============================================================
# TASK 3: Update mobile responsive overrides to match wider embeds
# ============================================================

# --- 3a: Update the @media (max-width: 768px) .message-file overrides ---
old_mobile_768 = """  .message-file img { max-width: 240px; max-height: 240px; }
  .message-file video { max-width: 280px; max-height: 240px; }
  .message-file audio { width: 240px; }
  .message-file-attachment { max-width: 280px; padding: 10px 12px; gap: 10px; }
  .file-icon { width: 36px; height: 36px; }
  .file-name { font-size: 12px; }
  .file-size { font-size: 10px; }"""

new_mobile_768 = """  .message-file img { max-width: 320px; max-height: 320px; }
  .message-file video { max-width: 340px; max-height: 300px; }
  .message-file audio { width: 280px; }
  .message-file-attachment { max-width: 340px; padding: 10px 13px; gap: 10px; }
  .file-icon { width: 38px; height: 38px; }
  .file-name { font-size: 12px; }
  .file-size { font-size: 10px; }"""

assert old_mobile_768 in s, "Could not find old mobile 768px .message-file overrides"
s = s.replace(old_mobile_768, new_mobile_768, 1)
print("3a: Updated mobile 768px .message-file overrides (wider)")

# --- 3b: Update the @media (max-width: 480px) small mobile overrides ---
old_mobile_480 = """  .message-file img { max-width: 200px; max-height: 200px; }
  .message-file video { max-width: 220px; max-height: 200px; }
  .message-file-attachment { max-width: 240px; padding: 8px 10px; }"""

new_mobile_480 = """  .message-file img { max-width: 260px; max-height: 260px; }
  .message-file video { max-width: 280px; max-height: 240px; }
  .message-file-attachment { max-width: 280px; padding: 9px 12px; }"""

assert old_mobile_480 in s, "Could not find old mobile 480px .message-file overrides"
s = s.replace(old_mobile_480, new_mobile_480, 1)
print("3b: Updated mobile 480px .message-file overrides (wider)")

# --- 3c: Update .message-image / .dm-message-image mobile override ---
old_msg_img_mobile = """  .message-image, .message-image img { max-width: 100%; max-height: 300px; }
  .dm-message-image, .dm-message-image img { max-width: 100%; max-height: 300px; }"""

new_msg_img_mobile = """  .message-image, .message-image img { max-width: 100%; max-height: 380px; }
  .dm-message-image, .dm-message-image img { max-width: 100%; max-height: 380px; }"""

assert old_msg_img_mobile in s, "Could not find old .message-image mobile override"
s = s.replace(old_msg_img_mobile, new_msg_img_mobile, 1)
print("3c: Updated .message-image / .dm-message-image mobile override (380px)")

with io.open(path, 'w', encoding='utf-8') as f:
    f.write(s)
print("All mobile CSS changes written successfully")
