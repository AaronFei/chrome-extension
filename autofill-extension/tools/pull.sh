#!/bin/sh
# Auto Login — 定時把程式碼拉下來
#
# extension 自己不能改自己的檔案（MV3 禁止），所以換檔案這件事只能由外面做。
# 換完之後 extension 會發現「磁碟上的 manifest 版本 ≠ 載入時的版本」，自己重載一次。
#
# 裝法：
#   chmod +x tools/pull.sh
#   cp tools/com.autologin.pull.plist ~/Library/LaunchAgents/
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.autologin.pull.plist
# 拆掉：
#   launchctl bootout gui/$(id -u)/com.autologin.pull

REPO="$HOME/Workspace/autotool/autofill-extension"
LOG="$HOME/Library/Logs/autologin-pull.log"

cd "$REPO" || exit 0

# 本機有沒提交的改動就停手 —— 寧可不更新，也不要把你正在改的東西弄壞
if [ -n "$(git status --porcelain)" ]; then
  echo "$(date '+%F %T') 本機有未提交的改動，跳過" >> "$LOG"
  exit 0
fi

git fetch --quiet origin main 2>>"$LOG" || exit 0

OLD=$(git rev-parse HEAD)
# 只快進。真的分岔了就停手，讓人去看
git merge --ff-only --quiet origin/main 2>>"$LOG" || {
  echo "$(date '+%F %T') 無法快進（分岔了），跳過" >> "$LOG"
  exit 0
}
NEW=$(git rev-parse HEAD)

[ "$OLD" != "$NEW" ] && echo "$(date '+%F %T') 更新 ${OLD%${OLD#???????}} → ${NEW%${NEW#???????}}" >> "$LOG"
exit 0
