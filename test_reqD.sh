#!/bin/bash
# Request D backend smoke test
set -e
BASE=http://localhost:3000

# 1. CAPTCHA
CH=$(curl -s $BASE/api/captcha-challenge)
TOK=$(echo "$CH" | python3 -c "import sys,json;print(json.load(sys.stdin)['challenge'])")
sleep 1

# 2. Register owner
U="dtest$(date +%s)"
REG=$(curl -s -X POST $BASE/api/register -H 'Content-Type: application/json' \
  -d "{\"username\":\"$U\",\"password\":\"Passw0rd!23\",\"captchaToken\":\"$TOK\"}")
SID=$(echo "$REG" | python3 -c "import sys,json;print(json.load(sys.stdin).get('sessionId',''))")
echo "owner=$U sid=$SID"

# 3. Create server
SRV=$(curl -s -X POST $BASE/api/servers/create -H "X-Session-Id: $SID" -H 'Content-Type: application/json' \
  -d '{"name":"ReqD Test Server"}')
SID_SRV=$(echo "$SRV" | python3 -c "import sys,json;print(json.load(sys.stdin)['server']['id'])")
echo "server=$SID_SRV"

# 4. Create a role
ROLE=$(curl -s -X POST $BASE/api/servers/$SID_SRV/roles -H "X-Session-Id: $SID" -H 'Content-Type: application/json' \
  -d '{"name":"VIP","color":"#ff00ff","badge":"⭐","permissions":{"invite":true}}')
RID=$(echo "$ROLE" | python3 -c "import sys,json;print(json.load(sys.stdin)['role']['id'])")
echo "role=$RID"

# 5. Create a private channel with chat disabled for members
CH1=$(curl -s -X POST $BASE/api/servers/$SID_SRV/channels -H "X-Session-Id: $SID" -H 'Content-Type: application/json' \
  -d '{"name":"secret","topic":"top secret"}')
CHID=$(echo "$CH1" | python3 -c "import sys,json;print(json.load(sys.stdin)['channel']['id'])")
echo "channel=$CHID"

# 6. Update channel: private + allowedRoles + chatDisabledFor=members
UPD=$(curl -s -X POST $BASE/api/servers/$SID_SRV/channels/$CHID -H "X-Session-Id: $SID" -H 'Content-Type: application/json' \
  -d "{\"private\":true,\"allowedRoles\":[\"$RID\"],\"chatDisabledFor\":\"members\"}")
echo "--- channel after update ---"
echo "$UPD" | python3 -c "import sys,json;c=json.load(sys.stdin)['channel'];print('private=',c['private'],'allowedRoles=',c['allowedRoles'],'chatDisabledFor=',c['chatDisabledFor'])"

# 7. Update server settings (new fields)
SET=$(curl -s -X POST $BASE/api/servers/$SID_SRV/settings -H "X-Session-Id: $SID" -H 'Content-Type: application/json' \
  -d "{\"name\":\"ReqD Test Server\",\"bio\":\"hello\",\"systemChannelId\":\"$CHID\",\"defaultNotifications\":\"mentions\",\"verificationLevel\":2,\"slowmodeSeconds\":30,\"welcomeMessage\":\"Welcome!\",\"discoverable\":true}")
echo "--- server settings ---"
echo "$SET" | python3 -c "import sys,json;s=json.load(sys.stdin)['server'];print('notif=',s['defaultNotifications'],'verif=',s['verificationLevel'],'slow=',s['slowmodeSeconds'],'welcome=',s['welcomeMessage'],'discoverable=',s['discoverable'],'sysCh=',s['systemChannelId'])"

# 8. Verify publicServer includes new channel fields
GET=$(curl -s $BASE/api/servers/$SID_SRV -H "X-Session-Id: $SID")
echo "--- publicServer channel fields ---"
echo "$GET" | python3 -c "import sys,json;s=json.load(sys.stdin)['server'];c=s['channels'][0];print('private=',c['private'],'allowedRoles=',c['allowedRoles'],'chatDisabledFor=',c['chatDisabledFor'],'canChat=',c['canChat'])"

echo "ALL TESTS PASSED"
