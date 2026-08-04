# Records demo/cut-list.gif — the beat this project exists for.
#
# Reproduce it:
#   make demo                      # loads data/demo_graph.json, starts the app
#   vhs demo/cut-list.tape         # override the host with API=... if not :8000
#
# Everything below runs against the shipped snapshot with no API keys.
# /api/delta/ takes a title fragment, which is why "Simple" is enough.

Output demo/cut-list.gif

Require curl
Require jq

Set Shell bash
Set FontSize 17
Set Width 1180
Set Height 700
Set Padding 22
Set TypingSpeed 28ms
Set Theme "Catppuccin Mocha"

Hide
Type "export API=${API:-http://localhost:8000} PS1='$ '" Enter
Type "clear" Enter
Show

Sleep 700ms
Type "# A 17-minute game theory talk. What is in it that I don't already know?" Sleep 300ms Enter
Sleep 800ms

Type 'curl -s "$API/api/delta/Simple" | jq .stats' Sleep 300ms Enter
Sleep 3500ms

Type "# 968 of 1067 seconds. 16:08 of 17:46, and nothing safe to skip --" Sleep 250ms Enter
Type "# this vault has never written down a word about game theory." Sleep 250ms Enter
Sleep 2500ms
Type "clear" Enter
Sleep 400ms

Type "# So I go watch a DIFFERENT game theory talk, and tell the graph:" Sleep 300ms Enter
Sleep 700ms

Type `curl -sX POST "$API/api/capture" -H 'content-type: application/json' \` Enter
Type `     -d '{"video": "How Decision Making"}' | jq -c .captured` Sleep 300ms Enter
Sleep 3500ms

Type "# Same talk as before. Same corpus. Nothing re-ingested or re-indexed." Sleep 300ms Enter
Sleep 700ms

Type 'curl -s "$API/api/delta/Simple" | jq .stats' Sleep 300ms Enter
Sleep 3500ms

Type "# 16:08 -> 9:32. 41% less to watch, and it can name the note that covers each skip." Sleep 300ms Enter
Sleep 1200ms
Type "# The corpus didn't change. I changed." Sleep 300ms Enter
Sleep 3s
