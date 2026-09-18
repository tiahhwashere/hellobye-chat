# Hellobye-Chat — Round 13

## Request
- Have the iPhone (iMessage) text animation also play in the chatroom.

## Root cause
- The chatroom lives inside #chat-app, and compact mode disables ALL
  animations on message groups:
    #chat-app.compact .message-group { animation: none; ... }
  That ID-selector rule overrode `.message-group.imsg-in`, so in compact mode
  the iPhone animation played in DMs / groups / encrypted (which are OUTSIDE
  #chat-app) but NOT in the chatroom.

## Tasks
- [x] A. Re-enable the iPhone animation in compact mode:
         #chat-app.compact .message-group.imsg-in { animation: imsgSend ... }
- [x] B. Verify locally:
         - normal mode: chatroom anim = imsgSend.
         - compact mode: chatroom anim = imsgSend (was 'none' before fix).
         - silent bulk render: no animation (msgIn only).
         - animationstart event fires imsgSend in compact mode.
         - node --check passes.
- [x] C. Commit & push.
- [x] D. Verify live.
