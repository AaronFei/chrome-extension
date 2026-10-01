#!/bin/bash
# YT Audio Grabber - uninstall the local helper
#
#   bash uninstall.sh            互動式：問你要不要一併刪掉設定與 token
#   bash uninstall.sh --purge    直接連設定與 token 一起刪
#   bash uninstall.sh --keep     只停服務，設定全部保留
#
# 不會碰你下載好的音檔，也不會移除 yt-dlp / ffmpeg。
set -u
GREEN=$'\033[32m'; YEL=$'\033[33m'; RED=$'\033[31m'; DIM=$'\033[2m'; OFF=$'\033[0m'
say(){ printf "%s\n" "$*"; }

PLIST="$HOME/Library/LaunchAgents/com.ytaudiograbber.helper.plist"
CONFDIR="$HOME/.config/yt-audio-grabber"
LOG="$HOME/Library/Logs/yt-audio-grabber.log"
ERRLOG="$HOME/Library/Logs/yt-audio-grabber.err.log"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"

MODE="ask"
for a in "$@"; do
  case "$a" in
    --purge) MODE="purge" ;;
    --keep)  MODE="keep" ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) say "${RED}unknown option: $a${OFF}"; exit 1 ;;
  esac
done

PORT=8787
if [ -f "$CONFDIR/config.json" ]; then
  P=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("port",8787))' "$CONFDIR/config.json" 2>/dev/null)
  [ -n "${P:-}" ] && PORT="$P"
fi

say "${GREEN}==> stopping service${OFF}"
if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null && say "  launch agent unloaded" || say "  ${DIM}launch agent was not loaded${OFF}"
  rm -f "$PLIST" && say "  removed $PLIST"
else
  say "  ${DIM}no launch agent found${OFF}"
fi

# kill any helper started by hand (never kill this script's own shell)
KILLED=0
for p in $(pgrep -f 'yt_audio_helper\.py' 2>/dev/null); do
  [ "$p" = "$$" ] && continue
  kill "$p" 2>/dev/null && KILLED=$((KILLED+1))
done
[ "$KILLED" -gt 0 ] && say "  stopped $KILLED stray helper process(es)"

sleep 1
if curl -s --max-time 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  say "  ${RED}警告：127.0.0.1:$PORT 還有東西在回應${OFF}"
else
  say "  port $PORT 已釋放"
fi

say "${GREEN}==> logs${OFF}"
rm -f "$LOG" "$ERRLOG" && say "  removed helper logs"

say "${GREEN}==> config / token${OFF}"
if [ ! -d "$CONFDIR" ]; then
  say "  ${DIM}沒有設定目錄${OFF}"
else
  DO_PURGE=0
  case "$MODE" in
    purge) DO_PURGE=1 ;;
    keep)  DO_PURGE=0 ;;
    ask)
      say "  設定目錄：$CONFDIR"
      say "  ${DIM}(含 token 與 config.json；保留的話之後重裝不用重貼 token)${OFF}"
      printf "  要一併刪除嗎？ [y/N] "
      read -r ans </dev/tty || ans="n"
      [[ "$ans" =~ ^[Yy]$ ]] && DO_PURGE=1
      ;;
  esac
  if [ "$DO_PURGE" = 1 ]; then
    rm -rf "$CONFDIR" && say "  ${YEL}已刪除 $CONFDIR${OFF}"
  else
    say "  保留 $CONFDIR"
  fi
fi

# --- things we deliberately do NOT touch -----------------------------
OUTDIR="$HOME/Downloads"
[ -f "$CONFDIR/config.json" ] && OUTDIR=$(python3 -c '
import json,sys,os
print(os.path.expanduser(json.load(open(sys.argv[1])).get("output_dir","~/Downloads")))' "$CONFDIR/config.json" 2>/dev/null || echo "$OUTDIR")

echo
say "${GREEN}======================================================${OFF}"
say " 本機服務已移除。以下${YEL}沒有${OFF}動，需要的話自己處理："
echo
if [ -d "$OUTDIR" ]; then
  say "  已下載的音檔  $OUTDIR  ($(du -sh "$OUTDIR" 2>/dev/null | cut -f1))"
else
  say "  已下載的音檔  (找不到輸出資料夾)"
fi
say "  yt-dlp/ffmpeg 若要移除：${DIM}brew uninstall yt-dlp ffmpeg${OFF}"
say "  Chrome 擴充     chrome://extensions → YT Audio Grabber → 移除"
say "  專案原始碼      $ROOT"
say "${GREEN}======================================================${OFF}"
