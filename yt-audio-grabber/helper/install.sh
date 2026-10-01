#!/bin/bash
# YT Audio Grabber - one-time setup for macOS
set -u
GREEN=$'\033[32m'; YEL=$'\033[33m'; RED=$'\033[31m'; OFF=$'\033[0m'
say(){ printf "%s\n" "$*"; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say "${GREEN}==> checking dependencies${OFF}"

if ! command -v brew >/dev/null 2>&1; then
  if   [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew   ]; then eval "$(/usr/local/bin/brew shellenv)"
  fi
fi

need_brew=0
command -v yt-dlp >/dev/null 2>&1 || need_brew=1
command -v ffmpeg >/dev/null 2>&1 || need_brew=1

if [ "$need_brew" = 1 ]; then
  if command -v brew >/dev/null 2>&1; then
    say "${YEL}installing yt-dlp / ffmpeg via Homebrew...${OFF}"
    command -v yt-dlp >/dev/null 2>&1 || brew install yt-dlp
    command -v ffmpeg >/dev/null 2>&1 || brew install ffmpeg
  else
    say "${RED}Homebrew not found.${OFF}"
    say "Install it:  /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
    say "then re-run this script. (Alternatively: pip3 install -U yt-dlp)"
    exit 1
  fi
fi

say "  yt-dlp : $(command -v yt-dlp)  $(yt-dlp --version 2>/dev/null)"
say "  ffmpeg : $(command -v ffmpeg)"

say "${GREEN}==> installing launch agent (auto-start at login)${OFF}"
PLIST="$HOME/Library/LaunchAgents/com.ytaudiograbber.helper.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
PY="$(command -v python3)"
# make sure brew bin dirs are on the agent's PATH
AGENT_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cat > "$PLIST" <<PEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ytaudiograbber.helper</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$HERE/yt_audio_helper.py</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$AGENT_PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/yt-audio-grabber.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/yt-audio-grabber.err.log</string>
</dict>
</plist>
PEOF

launchctl unload "$PLIST" 2>/dev/null
launchctl load  "$PLIST"
sleep 2

say "${GREEN}==> checking service${OFF}"
if curl -s --max-time 5 http://127.0.0.1:8787/health >/dev/null; then
  curl -s http://127.0.0.1:8787/health
  echo
else
  say "${RED}service did not answer on :8787 — see ~/Library/Logs/yt-audio-grabber.err.log${OFF}"
fi

TOKEN="$(cat "$HOME/.config/yt-audio-grabber/token" 2>/dev/null)"
echo
say "${GREEN}======================================================${OFF}"
say " Done. Paste this TOKEN into the extension options page:"
say ""
say "   ${YEL}${TOKEN}${OFF}"
say ""
say " Audio output folder: $HOME/Downloads"
say " Logs              : ~/Library/Logs/yt-audio-grabber.log"
say " Stop  service     : launchctl unload $PLIST"
say " Start service     : launchctl load   $PLIST"
say "${GREEN}======================================================${OFF}"
