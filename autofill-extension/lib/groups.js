/* Auto Login — 共用帳密（憑證組）
 *
 * 公司的 AD 密碼每隔一段時間就要換，而 JIRA、wiki、各種內部系統都是同一組帳密。
 * 以前每個網站各存一份，換一次密碼就要一張張卡片改。
 *
 * 做法：網站上多一個 credGroup 欄位（組名）。「組」不是另外一份資料，
 * 而是「credGroup 相同的那些網站」。改組的帳密 = 把新值寫進每一個成員，並各自蓋新的 updatedAt。
 *
 * 刻意不另開一個 creds 儲存區：
 *  - content script 完全不用改，照樣讀 site.username / site.password
 *  - 雲端同步、匯出匯入、墓碑、合併全部原封不動就支援（每個成員照 updatedAt 合併，結果一致）
 *  - 還沒升級的其他機器也不會壞：它們只是把 credGroup 當成不認得的欄位原樣帶著走，
 *    而且它們讀到的 username / password 本來就是新的
 */
"use strict";

(function (root) {
  const norm = (g) => String(g ?? "").trim();
  const key = (g) => norm(g).toLowerCase();

  // 回傳 Map<組名 key, { name, members[], username, consistent }>
  function groupsOf(sites) {
    const m = new Map();
    for (const s of sites || []) {
      const k = key(s.credGroup);
      if (!k) continue;
      if (!m.has(k)) m.set(k, { name: norm(s.credGroup), members: [] });
      m.get(k).members.push(s);
    }
    for (const g of m.values()) {
      const newest = [...g.members].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      g.username = newest.username || "";
      g.consistent = g.members.every((s) => s.username === newest.username && s.password === newest.password);
    }
    return m;
  }

  // 把帳密寫進同組所有網站。回傳被改到的網站數。
  function applyToGroup(sites, group, { username, password }) {
    const k = key(group);
    if (!k) return 0;
    const now = Date.now();
    let n = 0;
    for (const s of sites) {
      if (key(s.credGroup) !== k) continue;
      if (username != null) s.username = username;
      if (password != null) s.password = password;
      s.updatedAt = now;
      n++;
    }
    return n;
  }

  // 還沒分組、但帳號相同的網站（≥2 個）→ 建議合成一組
  function suggestions(sites) {
    const m = new Map();
    for (const s of sites || []) {
      if (key(s.credGroup) || !s.username) continue;
      const k = s.username.toLowerCase();
      if (!m.has(k)) m.set(k, { username: s.username, members: [] });
      m.get(k).members.push(s);
    }
    return [...m.values()].filter((x) => x.members.length >= 2);
  }

  root.AL_GROUPS = { norm, key, groupsOf, applyToGroup, suggestions };
})(typeof self !== "undefined" ? self : globalThis);
