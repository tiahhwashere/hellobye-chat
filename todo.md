# Hellobye Chat — Fix: red badge not showing for @lore (closedDMs suppressing it)

## Root cause (FOUND)
- @lore has closedDMs = ['test','snd_1787944754183_b','tst_1787943910896_a']
- Server /api/dm-conversations SKIPS closed conversations (server.js:1319)
  → conversation + unread count excluded from red badge
- Client dm-receive optimistically shows badge, then loadDMConversations()
  overwrites with server data → badge disappears for closed convos
- So a new DM to @lore (who closed that convo) never surfaces a red badge

## Fix
- [ ] Server: auto-reopen a conversation for the RECIPIENT when a new DM
      arrives (remove sender from recipient's closedDMs) so new messages
      always surface the conversation + red badge, regardless of prior close
- [ ] Also clean stale closedDMs entries (non-existent users) for all users
      on startup (defensive)
- [ ] Client: ensure loadDMConversations() doesn't wipe optimistic unread
      badge prematurely (keep unread count for newly-reopened convos)

## Data fix (no wipe)
- [ ] In live db.json: clear @lore's stale closedDMs (test/snd/tst entries)
      so the badge works immediately for existing conversations
- [ ] Push updated db.json to GitHub backup repo (tiahhwashere/hellobye-chat-data)
- [ ] Do NOT delete any users / messages / dms

## Deploy
- [ ] Commit + push code to GitHub master
- [ ] Render auto-deploy goes live
- [ ] Verify site online + badge works for @lore & everyone
