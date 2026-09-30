/**
 * badmintonScheduler.js — 羽球雙打「排隊輪替」核心（Pure JS，零依賴）
 *
 * 運作方式（不再預先排好 N 輪）：
 *   1. createSession()  把球員隨機打散，前 4×場地數 人放進「上場區」，
 *                       其餘依序排進「等待區」（每 4 人一組，最後不足 4 人的是「候補」）。
 *   2. finishCourt()    某場地比賽結束 → 該場人員清空並回到等待區隊尾，
 *                       等待區最前面的一組自動推上該場地。
 *   3. swapPlayers()    任兩位球員（不論在上場區或等待區）互換位置，對應 UI 的下拉選單換人。
 *
 * 所有函式都是「純函式」：不修改傳入的 session，而是回傳新的 session，
 * 所以 React 的 useState、復原（undo）堆疊都可以直接用。
 *
 * 公平性設計
 *   - 等待區是 FIFO：先休息的人先上場，休息時間自然平均。
 *   - 結束的人回到隊尾時，已打場數較少的排在前面，場數多的排在後面。
 *   - 每一組（4 人）分成 A、B 兩隊時，從 3 種拆法中挑「隊友重複最少、對手重複最少」的。
 *   - 混搭（mix，預設開）：等待人數剛好是 4 的倍數時，同一批 4 人會永遠一起輪替，
 *     隊友只剩 3 種搭法。開啟後，只在「下一場又會出現重複隊友」時，
 *     才讓下一場與後面一組互換 1 人（優先換場數差不多的人），打破固定四人組。
 */

/* ------------------------------------------------------------------ *
 * 資料結構 (JSDoc typedef)
 * ------------------------------------------------------------------ */

/**
 * 輸入球員：可以只給字串（名字即 id），或給物件。
 * @typedef {string | { id: string, name?: string, gender?: 'M'|'F'|null }} PlayerInput
 */

/**
 * @typedef {Object} Player
 * @property {string} id
 * @property {string} name
 * @property {'M'|'F'|null} gender   'M' 男、'F' 女、null 未指定
 */

/**
 * 一場 2v2 的組合。可能正在球場上，也可能還在等待區排隊。
 * @typedef {Object} Group
 * @property {string} id
 * @property {[string,string]} teamA   A 組球員 id
 * @property {[string,string]} teamB   B 組球員 id
 * @property {number} [startedAt]      這組被排上場地的時間戳（Date.now()）；只有上場區的組合才有，用來算「已進行多久」。換人、互換位置不會重設這個時間，只有換成全新的一組才會。
 */

/**
 * 已結束的比賽紀錄
 * @typedef {Object} FinishedMatch
 * @property {string} id
 * @property {number} seq              第幾場結束（從 1 開始）
 * @property {number} court            在哪個場地打的（從 1 開始）
 * @property {[string,string]} teamA
 * @property {[string,string]} teamB
 */

/**
 * 整個排程狀態（不可變，每次操作都回傳新物件）
 * @typedef {Object} Session
 * @property {Player[]} players
 * @property {(Group|null)[]} courts    上場區：長度 = 場地數，courts[0] 是場地 1
 * @property {Group[]} queue            等待區：完整的組合，queue[0] 是「下一場」
 * @property {string[]} pending         等待區：不足 4 人、尚未成組的候補（依排隊順序）
 * @property {FinishedMatch[]} history  已結束的比賽
 * @property {number} seq               組合 id 的流水號
 */

const PAIRINGS = [
  [[0, 1], [2, 3]],
  [[0, 2], [1, 3]],
  [[0, 3], [1, 2]],
];
const W_PARTNER = 100; // 每重複搭檔 1 次的懲罰
const W_OPPONENT = 15; // 每重複對打 1 次的懲罰
const W_FAIR = 60; // 混搭時，讓場數較多的人提前上場的懲罰（每多 1 場）

/* ------------------------------------------------------------------ *
 * 主要 API
 * ------------------------------------------------------------------ */

/**
 * 建立排程：隨機排出第一輪（上場區 + 等待區）
 * @param {PlayerInput[]} playersInput
 * @param {{courts?: number, rng?: () => number}} [options]  rng 預設 Math.random
 * @returns {Session}
 */
function createSession(playersInput, options = {}) {
  const rng = options.rng || Math.random;
  const players = normalizePlayers(playersInput);
  const n = players.length;
  if (n < 4) throw new Error("至少需要 4 位球員才能排雙打");

  const courtCount = Math.max(1, Math.min(Math.floor(options.courts ?? 1), Math.floor(n / 4)));
  const order = shuffle(players.map((p) => p.id), rng);

  const s = { players, courts: Array(courtCount).fill(null), queue: [], pending: order.slice(4 * courtCount), history: [], seq: 0 };
  for (let c = 0; c < courtCount; c++) s.courts[c] = { ...makeGroup(s, order.slice(4 * c, 4 * c + 4), rng), startedAt: Date.now() };
  fillQueue(s, rng);
  return s;
}

/**
 * 某個場地比賽結束：
 *   人員清空 → 回到等待區隊尾 → 等待區最前面的一組推上該場地
 * @param {Session} session
 * @param {number} courtIndex  從 0 開始
 * @param {{rng?: () => number, mix?: boolean}} [options]  mix 預設 true（見上方「混搭」說明）
 * @returns {Session}
 */
function finishCourt(session, courtIndex, options = {}) {
  const rng = options.rng || Math.random;
  const match = session.courts[courtIndex];
  if (!match) return session;

  const s = clone(session);
  s.history.push({ id: match.id, seq: s.history.length + 1, court: courtIndex + 1, teamA: match.teamA, teamB: match.teamB });
  s.courts[courtIndex] = null;

  // 結束的 4 人回到隊尾：已打場數少的排前面（同數量隨機）
  const games = countGames(s);
  const back = match.teamA
    .concat(match.teamB)
    .map((id) => ({ id, g: games[id] || 0, r: rng() }))
    .sort((a, b) => a.g - b.g || a.r - b.r)
    .map((x) => x.id);
  s.pending.push(...back);

  fillQueue(s, rng); // 湊滿 4 人就成組
  if (options.mix !== false) mixFront(s, games);
  s.courts[courtIndex] = { ...s.queue.shift(), startedAt: Date.now() }; // 最前面的一組上場（pending 已 ≥4，所以一定有）
  return s;
}

/**
 * 任兩位球員互換位置（可跨場地、跨等待區、包含候補）
 * @param {Session} session
 * @param {string} aId
 * @param {string} bId
 * @returns {Session}
 */
function swapPlayers(session, aId, bId) {
  if (aId === bId) return session;
  const swap = (id) => (id === aId ? bId : id === bId ? aId : id);
  const swapGroup = (g) => (g ? { ...g, teamA: g.teamA.map(swap), teamB: g.teamB.map(swap) } : g);
  return {
    ...session,
    courts: session.courts.map(swapGroup),
    queue: session.queue.map(swapGroup),
    pending: session.pending.map(swap),
  };
}

/**
 * 重新打散等待區：把所有等待中的人隨機洗牌後重新成組。
 * （等待人數剛好是 4 的倍數時，同一批人會一起輪替；打散可以增加隊友變化）
 * @param {Session} session
 * @param {{rng?: () => number}} [options]
 * @returns {Session}
 */
function reshuffleWaiting(session, options = {}) {
  const rng = options.rng || Math.random;
  const s = clone(session);
  const waiting = s.queue.flatMap((g) => g.teamA.concat(g.teamB)).concat(s.pending);
  s.queue = [];
  s.pending = shuffle(waiting, rng);
  fillQueue(s, rng);
  return s;
}

/**
 * 讓某位球員中途離場：從目前所在位置移除（上場區／等待區／候補都可以）。
 *   - 在等待區或候補：直接移除，剩下的人依原順序重新湊組。
 *   - 在上場區：從等待區最前面遞補 1 人上來；如果沒有人可以遞補，
 *     就關閉這個場地，該場其餘 3 人回到等待區重新湊組。
 * 球員仍保留在 session.players（標記 left: true），已結束的比賽紀錄不會受影響、
 * 名字也不會消失；之後的排程不會再把他排進去。
 * @param {Session} session
 * @param {string} id
 * @param {{rng?: () => number}} [options]
 * @returns {Session}
 */
function leavePlayer(session, id, options = {}) {
  const rng = options.rng || Math.random;
  const s = clone(session);
  s.players = s.players.map((p) => (p.id === id ? { ...p, left: true } : p));

  if (s.pending.indexOf(id) !== -1) {
    s.pending = s.pending.filter((x) => x !== id);
    return s;
  }

  const inQueue = s.queue.some((g) => g.teamA.indexOf(id) !== -1 || g.teamB.indexOf(id) !== -1);
  if (inQueue) {
    const flat = s.queue.flatMap((g) => g.teamA.concat(g.teamB)).concat(s.pending).filter((x) => x !== id);
    s.queue = [];
    s.pending = flat;
    fillQueue(s, rng);
    return s;
  }

  const courtIdx = s.courts.findIndex((g) => g && (g.teamA.indexOf(id) !== -1 || g.teamB.indexOf(id) !== -1));
  if (courtIdx !== -1) {
    const group = s.courts[courtIdx];
    const team = group.teamA.indexOf(id) !== -1 ? "teamA" : "teamB";
    const slot = group[team].indexOf(id);
    const flat = s.queue.flatMap((g) => g.teamA.concat(g.teamB)).concat(s.pending);

    if (flat.length === 0) {
      // 沒有人可以遞補：關閉這個場地，其餘 3 人回到等待區
      const rest = group.teamA.concat(group.teamB).filter((x) => x !== id);
      s.courts = s.courts.filter((_, i) => i !== courtIdx);
      s.queue = [];
      s.pending = rest;
      fillQueue(s, rng);
      return s;
    }

    const replacement = flat[0];
    s.queue = [];
    s.pending = flat.slice(1);
    fillQueue(s, rng);
    const newTeam = group[team].slice();
    newTeam[slot] = replacement;
    s.courts[courtIdx] = { ...group, [team]: newTeam };
    return s;
  }

  return s; // 已經離場，或不在任何位置
}

/* ------------------------------------------------------------------ *
 * 查詢 / 統計
 * ------------------------------------------------------------------ */

/**
 * 每位球員「已結束」的場數
 * @param {Session} session
 * @returns {Record<string, number>}
 */
function countGames(session) {
  const games = {};
  session.players.forEach((p) => (games[p.id] = 0));
  session.history.forEach((m) => m.teamA.concat(m.teamB).forEach((id) => (games[id] = (games[id] || 0) + 1)));
  return games;
}

/**
 * 每位球員目前在哪：{ zone: 'court'|'queue'|'pending', label, gid, order }
 * order 是「上場順序」：上場區 < 等待區（下一場最小）< 候補，方便排序。
 * @param {Session} session
 * @returns {Map<string, {zone: string, label: string, gid: string|null, order: number}>}
 */
function locatePlayers(session) {
  const where = new Map();
  session.courts.forEach((g, i) => {
    if (g) g.teamA.concat(g.teamB).forEach((id, k) => where.set(id, { zone: "court", label: "場地 " + (i + 1), gid: g.id, order: i * 4 + k }));
  });
  session.queue.forEach((g, i) => {
    g.teamA.concat(g.teamB).forEach((id, k) =>
      where.set(id, { zone: "queue", label: i === 0 ? "下一場" : "第 " + (i + 1) + " 組", gid: g.id, order: 1000 + i * 4 + k })
    );
  });
  session.pending.forEach((id, k) => where.set(id, { zone: "pending", label: "候補", gid: null, order: 2000 + k }));
  return where;
}

/**
 * 隊友 / 對手的累計次數（已結束 + 上場區 + 等待區的組合）
 * @param {Session} session
 */
function buildPairCounter(session) {
  const partner = new Map();
  const opponent = new Map();
  const key = (a, b) => (a < b ? a + "\u0000" + b : b + "\u0000" + a);
  const add = (m, a, b) => m.set(key(a, b), (m.get(key(a, b)) || 0) + 1);
  const feed = (g) => {
    if (!g) return;
    add(partner, g.teamA[0], g.teamA[1]);
    add(partner, g.teamB[0], g.teamB[1]);
    g.teamA.forEach((x) => g.teamB.forEach((y) => add(opponent, x, y)));
  };
  session.history.forEach(feed);
  session.courts.forEach(feed);
  session.queue.forEach(feed);

  let partnerRepeats = 0;
  partner.forEach((c) => (partnerRepeats += c - 1));
  return {
    partner: (a, b) => partner.get(key(a, b)) || 0,
    opponent: (a, b) => opponent.get(key(a, b)) || 0,
    partnerRepeats, // 隊友「多餘重複」總次數（0 = 完全沒有重複）
  };
}

/** 可重現的亂數（mulberry32）：createSession(players, { rng: createSeededRng(123) }) */
function createSeededRng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * 內部
 * ------------------------------------------------------------------ */

/** 一個分法（A、B 兩隊）的成本：隊友重複、對手重複 */
function groupCost(counter, a, b) {
  let cost = W_PARTNER * (counter.partner(a[0], a[1]) + counter.partner(b[0], b[1]));
  a.forEach((x) => b.forEach((y) => (cost += W_OPPONENT * counter.opponent(x, y))));
  return cost;
}

/** 4 人的三種 2v2 拆法中成本最低者（rng 用來讓同分時隨機決定） */
function bestSplit(counter, four, rng) {
  let best = null;
  for (const [[i, j], [k, l]] of PAIRINGS) {
    const a = [four[i], four[j]];
    const b = [four[k], four[l]];
    const cost = groupCost(counter, a, b) + (rng ? rng() * 0.5 : 0);
    if (!best || cost < best.cost) best = { cost, a, b };
  }
  return best;
}

/** 從 4 人中挑最好的 A/B 分法，回傳新的 Group（會遞增 s.seq） */
function makeGroup(s, four, rng) {
  const best = bestSplit(buildPairCounter(s), four, rng);
  s.seq += 1;
  return { id: "g" + s.seq, teamA: best.a, teamB: best.b };
}

/**
 * 混搭：若「下一場」（queue[0]）會出現重複隊友，就試著和後面一組（queue[1]）互換 1 人，
 * 挑成本最低的一種；改善不夠明顯就不動。只調整這兩組，不影響已上場的比賽。
 */
function mixFront(s, games) {
  if (s.queue.length < 2) return;
  const front = s.queue[0];
  const back = s.queue[1];
  // 不含這兩組的累計次數，才能公平比較「換人前 / 換人後」
  const base = buildPairCounter({ history: s.history, courts: s.courts, queue: s.queue.slice(2) });
  if (base.partner(front.teamA[0], front.teamA[1]) + base.partner(front.teamB[0], front.teamB[1]) === 0) return;

  const cur = groupCost(base, front.teamA, front.teamB) + groupCost(base, back.teamA, back.teamB);
  const frontIds = front.teamA.concat(front.teamB);
  const backIds = back.teamA.concat(back.teamB);
  let best = null;
  for (const x of frontIds) {
    for (const y of backIds) {
      const f = bestSplit(base, frontIds.map((id) => (id === x ? y : id)));
      const b = bestSplit(base, backIds.map((id) => (id === y ? x : id)));
      const cost = f.cost + b.cost + W_FAIR * ((games[y] || 0) - (games[x] || 0));
      if (!best || cost < best.cost) best = { cost, f, b };
    }
  }
  if (best && best.cost < cur - W_PARTNER / 2) {
    s.queue[0] = { ...front, teamA: best.f.a, teamB: best.f.b };
    s.queue[1] = { ...back, teamA: best.b.a, teamB: best.b.b };
  }
}

/** 候補湊滿 4 人就成組，依序排進等待區隊尾（會直接修改傳入的 s，只用在 clone 之後） */
function fillQueue(s, rng) {
  while (s.pending.length >= 4) s.queue.push(makeGroup(s, s.pending.splice(0, 4), rng));
}

function clone(s) {
  return { ...s, courts: [...s.courts], queue: [...s.queue], pending: [...s.pending], history: [...s.history] };
}

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function normalizePlayers(input) {
  if (!Array.isArray(input)) throw new Error("球員名單必須是陣列");
  const seen = new Set();
  return input.map((p) => {
    const player =
      typeof p === "string"
        ? { id: p, name: p, gender: null }
        : { id: String(p.id), name: p.name ?? String(p.id), gender: p.gender === "M" || p.gender === "F" ? p.gender : null };
    if (seen.has(player.id)) throw new Error("球員 id 重複：" + player.id);
    seen.add(player.id);
    return player;
  });
}

/* ================================================================== *
 * App 邏輯（與 React 無關的純函式，可單獨測試）
 * ================================================================== */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const uid = () => "p" + Math.random().toString(36).slice(2, 9);
const SAMPLE = [["阿明", "M"], ["小美", "F"], ["大雄", "M"], ["Amy", "F"], ["Ben", "M"], ["Cindy", "F"], ["阿凱", "M"], ["小華", "F"]];
const makeSample = () => SAMPLE.map(([name, gender]) => ({ id: uid(), name, gender }));

/* ---- 性別 ---- */
const nextGender = (g) => (g === "M" ? "F" : g === "F" ? null : "M"); // 未指定 → 男 → 女 → 未指定

/**
 * 解析輸入的一筆名字，支援在名字後面標註性別（必須有分隔字元，避免誤判名字本身）：
 *   "小明 男"  "小明:女"  "小明(男)"  "Amy F"  "Ben/M"  →  { name, gender }
 *   "阿男" "Adam" 這類沒有分隔的，一律視為名字
 */
function parseNameToken(raw) {
  const m = raw.match(/^(.+?)[\s:：(（/／-]+(男|女|M|F)\s*[)）]?$/i);
  if (!m) return { name: raw, gender: null };
  return { name: m[1].trim(), gender: /男|m/i.test(m[2]) ? "M" : "F" };
}

/** 一組（2 人）的類型：男雙 / 女雙 / 混雙；有人未指定性別時回傳空字串 */
function teamType(ids, byId) {
  const g = ids.map((id) => byId[id] && byId[id].gender);
  if (g.some((x) => !x)) return "";
  const men = g.filter((x) => x === "M").length;
  return men === 2 ? "男雙" : men === 0 ? "女雙" : "混雙";
}

/**
 * 匯出球員名單：以半形逗號分隔的字串。
 * 含性別時輸出 "阿明 男,小美 女,Ben"，可直接貼回輸入框還原（格式與匯入語法相同）。
 * 名字本身不會含逗號（輸入時逗號會被當成分隔符號），所以不需要跳脫。
 */
function exportRoster(players, withGender = true) {
  return players
    .map((p) => (withGender && p.gender ? p.name + " " + (p.gender === "M" ? "男" : "女") : p.name))
    .join(",");
}

/** 一批組合（已結束 + 上場區）的隊伍組成統計 */
function teamMix(groups, byId) {
  const r = { mixed: 0, men: 0, women: 0, unknown: 0 };
  groups.forEach((g) =>
    [g.teamA, g.teamB].forEach((ids) => {
      const t = teamType(ids, byId);
      if (t === "混雙") r.mixed++;
      else if (t === "男雙") r.men++;
      else if (t === "女雙") r.women++;
      else r.unknown++;
    })
  );
  return r;
}

/** 由目前名單與設定推導出「實際場地數」 */
function derive(players, courts) {
  const n = players.length;
  const maxCourts = Math.max(1, Math.floor(n / 4));
  return { n, maxCourts, effCourts: Math.min(courts, maxCourts) };
}

/** 名單 + 場地數的簽章：用來判斷已開始的排程是否「過期」（性別不列入） */
const makeSig = (players, courts) => players.length + "|" + players.map((p) => p.id + ":" + p.name).join(",") + "|" + courts;

/** 呼叫核心：隨機排出第一輪，並附上簽章 */
function startSession(players, courts) {
  return Object.assign(createSession(players, { courts }), { sig: makeSig(players, courts) });
}

/** 讀回存檔的排程時做基本檢查，不合格就回傳 null（重新開始） */
function restoreSession(s) {
  const ok =
    s && Array.isArray(s.players) && Array.isArray(s.courts) &&
    Array.isArray(s.queue) && Array.isArray(s.pending) && Array.isArray(s.history) && typeof s.sig === "string";
  if (!ok) return null;
  // 中途離場的人仍留在 players 裡（標記 left），但不會出現在任何區域，所以只用「未離場」的人數來核對
  const activeIds = new Set(s.players.filter((p) => !p.left).map((p) => p.id));
  const seen = [];
  s.courts.forEach((g) => g && seen.push(...g.teamA, ...g.teamB));
  s.queue.forEach((g) => seen.push(...g.teamA, ...g.teamB));
  seen.push(...s.pending);
  if (s.courts.some((g) => !g) || seen.length !== activeIds.size || seen.some((id) => !activeIds.has(id))) return null;
  return { ...s, players: s.players.map((p) => ({ ...p, gender: p.gender === "M" || p.gender === "F" ? p.gender : null })) };
}

/** 換人選單內容：依「等待區 / 上場區其他場地 / 同一場（組）」分組 */
function menuGroups(where, players, games, group, team, curId) {
  const buckets = { wait: [], court: [], same: [] };
  players.forEach((p) => {
    if (p.id === curId) return;
    const w = where.get(p.id) || { zone: "pending", label: "候補", gid: null, order: 9999 };
    let kind;
    let tag;
    if (group && w.gid === group.id) {
      kind = "same";
      tag = group[team].indexOf(p.id) !== -1 ? "同組" : "對手";
    } else if (w.zone === "court") {
      kind = "court";
      tag = w.label;
    } else {
      kind = "wait";
      tag = w.label;
    }
    buckets[kind].push({ id: p.id, name: p.name, gender: p.gender || null, tag, games: games[p.id] || 0, order: w.order });
  });
  Object.values(buckets).forEach((g) => g.sort((a, b) => a.order - b.order));
  const cur = where.get(curId);
  const inCourt = cur && cur.zone === "court";
  const wait = { key: "wait", title: "等待區（選了會互換）", items: buckets.wait };
  const court = { key: "court", title: "上場區其他場地（選了會互換）", items: buckets.court };
  const same = { key: "same", title: inCourt ? "同一場（選了會互換）" : "同一組（選了會互換）", items: buckets.same };
  return inCourt ? [wait, court, same] : [court, wait, same];
}

/** 目前場面轉成可貼到 LINE 的純文字 */
function boardToText(s) {
  const nm = {};
  s.players.forEach((p) => (nm[p.id] = p.name));
  const names = (ids) => ids.map((id) => nm[id]).join("、");
  const line = (g) => names(g.teamA) + "  vs  " + names(g.teamB);
  const out = ["【上場區】"];
  s.courts.forEach((g, i) => g && out.push("場地" + (i + 1) + "：" + line(g)));
  out.push("", "【等待區】");
  s.queue.forEach((g, i) => out.push((i === 0 ? "下一場" : "第 " + (i + 1) + " 組") + "：" + line(g)));
  if (s.pending.length) out.push("候補：" + names(s.pending));
  if (!s.queue.length && !s.pending.length) out.push("（目前沒有人在等待）");
  const left = s.players.filter((p) => p.left).map((p) => p.name);
  if (left.length) out.push("", "離場：" + left.join("、"));
  return out.join("\n");
}

/* ---- 儲存（try/catch：儲存空間可能不可用） ---- */
const STORE_KEY = "badminton-scheduler-v1";
function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
function saveStore(v) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(v));
  } catch (e) {
    /* 忽略 */
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

/* ================================================================== *
 * React 介面
 * 發佈頁面無法執行 JSX 編譯，所以用 React.createElement 的薄封裝；
 * 搬到 Vite / CRA 專案時，把 div(...) 改回 JSX 即可。
 * ================================================================== */

const { useState, useMemo, useEffect, useLayoutEffect, useRef } = React;
const h = React.createElement;
const tag = (name) => (props, ...kids) => h(name, props, ...kids);
const div = tag("div"), span = tag("span"), btn = tag("button"), inp = tag("input"), ul = tag("ul"), li = tag("li");
const h1 = tag("h1"), h2 = tag("h2"), para = tag("p"), lbl = tag("label"), details = tag("details"), summary = tag("summary");
const section = tag("section"), article = tag("article"), header = tag("header"), main = tag("main");
const cx = (...a) => a.filter(Boolean).join(" ");

const ICON = {
  x: "M18 6 6 18M6 6l12 12",
  plus: "M12 5v14M5 12h14",
  down: "m6 9 6 6 6-6",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  check: "m5 12 5 5 9-10",
  undo: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  board: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
  sliders: "M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4",
  leave: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
};
const Ico = (d, cls) =>
  h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", className: cls || "h-4 w-4", "aria-hidden": true }, h("path", { d }));

/* 雙打球場線（13.4m × 6.1m，以 10 倍座標繪製） */
const COURT_LINES = "M0 4.6H134M0 56.4H134M47.2 0V61M86.8 0V61M7.6 0V61M126.4 0V61M0 30.5H47.2M86.8 30.5H134";

/* 性別標記（男 = 藍、女 = 粉；未指定不顯示） */
const G_TEXT = { M: "男", F: "女" };
const G_STYLE = { M: "bg-gm text-gmink", F: "bg-gf text-gfink" };
function GenderMark({ g }) {
  if (!g) return null;
  return span({ className: cx("inline-grid h-4 w-4 shrink-0 place-items-center rounded-sm text-[10px] font-bold leading-none", G_STYLE[g]) }, G_TEXT[g]);
}

/* 常用樣式 */
const BTN_PRIMARY = "inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-sm font-bold text-brandink transition-opacity hover:opacity-90 disabled:opacity-40";
const BTN_GHOST = "inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-soft";
const BTN_LINK = "rounded px-1.5 py-0.5 text-xs text-mute underline-offset-2 hover:text-ink hover:underline";


/* ------------------------------------------------------------------ *
 * 計時器：顯示某個場地已經開打多久（mm:ss，超過 1 小時變 h:mm:ss）
 *   每秒鐘只有自己重新算一次，不會拖著整個畫面一起重繪。
 * ------------------------------------------------------------------ */
function Timer({ startedAt }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const h = Math.floor(m / 60);
  const text = (h > 0 ? h + ":" + String(m % 60).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  return span(
    { className: "inline-flex items-center gap-1 tabular-nums", title: "這場已經開打 " + text },
    ClockIcon(),
    text
  );
}
/** 內嵌一顆時鐘圖示，不透過 Ico()（那個只支援單一 path），供 Timer 使用 */
function ClockIcon() {
  return h(
    "svg",
    { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", className: "h-3 w-3 shrink-0 opacity-80", "aria-hidden": true },
    h("circle", { cx: 12, cy: 12, r: 9 }),
    h("polyline", { points: "12 7 12 12 15.5 14" })
  );
}

/* ------------------------------------------------------------------ *
 * 球場：每一組以「俯視球場」呈現，A 組在左半場、B 組在右半場
 *   variant = "live"（上場區，深綠） / "wait"（等待區，灰綠）
 * ------------------------------------------------------------------ */
function Court({ variant, children }) {
  return div(
    { className: cx("relative aspect-[2.15/1] w-full rounded-xl", variant === "wait" ? "bg-courtwait" : "bg-court") },
    div(
      { className: "pointer-events-none absolute inset-2 text-courtline" },
      h(
        "svg",
        { viewBox: "0 0 134 61", preserveAspectRatio: "none", fill: "none", stroke: "currentColor", className: "h-full w-full", "aria-hidden": true },
        h("rect", { x: 0, y: 0, width: 134, height: 61, vectorEffect: "non-scaling-stroke", strokeWidth: 1.5 }),
        h("path", { d: COURT_LINES, vectorEffect: "non-scaling-stroke", strokeWidth: 1.5 }),
        h("path", { d: "M67 0V61", vectorEffect: "non-scaling-stroke", strokeWidth: 3, strokeDasharray: "4 3" })
      )
    ),
    div({ className: "absolute inset-2 grid grid-cols-2 grid-rows-2" }, children)
  );
}

/* ------------------------------------------------------------------ *
 * 球員按鈕 + 下拉選單
 * ------------------------------------------------------------------ */
/** 已打場數的小徽章：彩色球隊底色上用半透明黑；候補的白底用 soft 灰 */
function GamesBadge({ n, dim }) {
  return span(
    { className: cx("grid h-5 min-w-[1.35rem] shrink-0 place-items-center rounded-full px-1 text-[10px] font-bold tabular-nums", dim ? "bg-soft text-mute" : "bg-black/10 text-current"), title: "已打 " + n + " 場" },
    n
  );
}

function PlayerSlot({ name, gender, games, badgeDim, tone, wrap, inner, isOpen, flash, align, onToggle, onClose, children }) {
  const ref = useRef(null);
  const [up, setUp] = useState(false);
  useLayoutEffect(() => {
    if (!isOpen) {
      setUp(false);
      return;
    }
    // 手機版有固定在底部的分頁列：先以「向下」量測，放不下、而上方空間較大時改為向上展開
    const bar = document.querySelector('nav[aria-label="主要分頁"]');
    const pop = ref.current && ref.current.querySelector('[role="listbox"]');
    const trigger = ref.current && ref.current.querySelector("button");
    if (!bar || !pop || !trigger) return;
    const r = trigger.getBoundingClientRect();
    const below = bar.getBoundingClientRect().top - r.bottom - 8;
    const above = r.top - 8;
    setUp(pop.offsetHeight > below && above > below);
  }, [isOpen]);
  useEffect(() => {
    if (!isOpen) return undefined;
    const down = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const key = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("touchstart", down);
    document.addEventListener("keydown", key);
    const pop = ref.current && ref.current.querySelector('[role="listbox"]');
    if (pop && pop.scrollIntoView) pop.scrollIntoView({ block: "nearest" });
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("touchstart", down);
      document.removeEventListener("keydown", key);
    };
  }, [isOpen]);

  return div(
    { ref, className: wrap || "flex items-center justify-center px-1" },
    div(
      { className: inner || "relative w-full max-w-[9.5rem]" },
      btn(
        {
          type: "button",
          "aria-haspopup": "listbox",
          "aria-expanded": isOpen,
          "aria-label": "更換選手：" + name + (gender ? "（" + G_TEXT[gender] + "）" : ""),
          onClick: onToggle,
          className: cx(
            "chip-ring flex w-full items-center justify-between gap-1 rounded-md px-2.5 py-1.5 text-left text-sm font-bold shadow-sm",
            tone,
            flash ? "ring-[3px] ring-flash" : isOpen ? "ring-2 ring-ink" : ""
          ),
        },
        span({ className: "flex min-w-0 items-center gap-1.5" }, GenderMark({ g: gender }), span({ className: "truncate" }, name)),
        span({ className: "flex shrink-0 items-center gap-1" }, games !== undefined && h(GamesBadge, { n: games, dim: badgeDim }), Ico(ICON.down, "h-3.5 w-3.5 opacity-60"))
      ),
      isOpen && children ? React.cloneElement(children, { up }) : null
    )
  );
}

function SwapMenu({ title, groups, align, up, onPick, onLeave }) {
  return div(
    {
      role: "listbox",
      className: cx(
        "absolute z-30 flex max-h-80 w-64 flex-col overflow-hidden rounded-xl border border-line bg-panel text-ink shadow-xl",
        up ? "bottom-full mb-1.5" : "top-full mt-1.5",
        align === "right" ? "right-0" : "left-0"
      ),
    },
    div(
      { className: "min-h-0 flex-1 scroll-mb-24 overflow-y-auto" },
      div({ className: "sticky top-0 border-b border-line bg-panel px-3 py-2" }, div({ className: "text-sm font-bold" }, title), div({ className: "text-xs font-normal text-mute" }, "選擇要互換位置的人")),
      groups.map((g) =>
        g.items.length === 0
          ? null
          : div(
              { key: g.key },
              div({ className: "px-3 pb-0.5 pt-2 text-xs font-medium text-mute" }, g.title),
              g.items.map((o) =>
                btn(
                  {
                    key: o.id,
                    type: "button",
                    role: "option",
                    "aria-selected": false,
                    onClick: () => onPick(o.id),
                    className: "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium hover:bg-soft",
                  },
                  span({ className: "flex min-w-0 items-center gap-1.5" }, GenderMark({ g: o.gender }), span({ className: "truncate" }, o.name)),
                  span(
                    { className: "flex shrink-0 items-center gap-1.5 text-xs font-normal text-mute" },
                    o.tag && span({ className: "rounded bg-soft px-1.5 py-0.5" }, o.tag),
                    span({ className: "tabular-nums" }, "已打 " + o.games + " 場")
                  )
                )
              )
            )
      )
    ),
    onLeave &&
      div(
        { className: "shrink-0 border-t border-line p-1.5" },
        btn(
          { type: "button", onClick: onLeave, className: "flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-bold text-warn hover:bg-warn/10" },
          Ico(ICON.leave, "h-4 w-4"),
          "此人離場，不再排入"
        )
      )
  );
}

/* 一個位置（球場上、等待區的組合、候補都用同一個元件） */
const TONE_A = "bg-chipa text-chipaink";
const TONE_B = "bg-chipb text-chipbink";
const TONE_WAIT = "border border-line bg-panel text-ink";

function Slot({ id, group, team, slotKey, tone, wrap, inner, align, ctx }) {
  const p = ctx.byId[id];
  const open = ctx.openKey === slotKey;
  return h(
    PlayerSlot,
    {
      name: p ? p.name : "?",
      gender: p ? p.gender || null : null,
      games: ctx.games[id] || 0,
      badgeDim: tone === TONE_WAIT,
      tone,
      wrap,
      inner,
      isOpen: open,
      align,
      flash: !!ctx.flash && ctx.flash.ids.indexOf(id) !== -1,
      onToggle: () => ctx.setOpenKey(open ? null : slotKey),
      onClose: () => ctx.setOpenKey(null),
    },
    open
      ? h(SwapMenu, {
          title: "更換「" + (p ? p.name : "?") + "」",
          groups: menuGroups(ctx.where, ctx.players, ctx.games, group, team, id),
          align,
          onPick: (newId) => ctx.onPick(id, newId),
          onLeave: ctx.onLeave ? () => ctx.onLeave(id) : undefined,
        })
      : null
  );
}

/* ------------------------------------------------------------------ *
 * 一組（2v2）：標題 + 球場 + A/B 圖例；上場區會多一個「結束」按鈕
 * ------------------------------------------------------------------ */
function GroupBlock({ group, variant, title, sub, action, ctx }) {
  const dupA = ctx.counter.partner(group.teamA[0], group.teamA[1]);
  const dupB = ctx.counter.partner(group.teamB[0], group.teamB[1]);
  const typeA = teamType(group.teamA, ctx.byId);
  const typeB = teamType(group.teamB, ctx.byId);
  const swatch = (bg, text) => span({ className: "inline-flex items-center gap-1" }, span({ className: cx("h-2.5 w-2.5 rounded-sm border border-line", bg) }), text);
  const slot = (team, i) =>
    h(Slot, {
      key: group.id + team + i,
      id: group[team][i],
      group,
      team,
      slotKey: group.id + ":" + team + ":" + i,
      tone: team === "teamA" ? TONE_A : TONE_B,
      align: team === "teamA" ? "left" : "right",
      ctx,
    });

  return div(
    null,
    div(
      { className: "mb-1.5 flex min-h-[2rem] items-center justify-between gap-2" },
      div({ className: "flex items-baseline gap-2" }, span({ className: cx("font-bold", variant === "wait" ? "text-sm" : "text-base") }, title), sub && span({ className: "text-xs text-mute" }, sub)),
      action
    ),
    h(Court, { variant }, slot("teamA", 0), slot("teamB", 0), slot("teamA", 1), slot("teamB", 1)),
    div(
      { className: "mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-xs text-mute" },
      span(
        { className: "flex flex-wrap gap-x-2 font-medium text-warn" },
        dupA > 1 && span({ title: "A 組這對搭檔在整份賽程中出現 " + dupA + " 次" }, "A 組重複搭檔 ×" + dupA),
        dupB > 1 && span({ title: "B 組這對搭檔在整份賽程中出現 " + dupB + " 次" }, "B 組重複搭檔 ×" + dupB)
      ),
      span(
        { className: "flex items-center gap-2.5" },
        swatch("bg-chipa", "A 組" + (typeA ? " " + typeA : "")),
        swatch("bg-chipb", "B 組" + (typeB ? " " + typeB : ""))
      )
    )
  );
}

/* ------------------------------------------------------------------ *
 * FancyBox 風格的燈箱（Lightbox）
 *   - 半透明遮罩 + 置中面板，淡入放大 / 淡出縮小
 *   - 點遮罩、按 ✕、按 Esc 都能關閉；開啟時鎖定背景捲動
 *   - 焦點會困在對話框內（Tab 循環），關閉後回到原本的按鈕
 *   - 標題列是分頁（tabs），可以在不關閉的情況下切換內容，方向鍵可切換
 * ------------------------------------------------------------------ */
function Modal({ tabs, active, onTab, onClose, children }) {
  const panelRef = useRef(null);
  const downOnBackdrop = useRef(false);
  const timer = useRef(null);
  const [closing, setClosing] = useState(false);

  const requestClose = () => {
    if (timer.current) return;
    setClosing(true); // 先播放淡出動畫，再真正卸載
    timer.current = setTimeout(onClose, 160);
  };
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;

  useEffect(() => {
    const prevFocus = document.activeElement;
    const body = document.body;
    const prevOverflow = body.style.overflow;
    const prevPad = body.style.paddingRight;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = "hidden"; // 鎖定背景捲動（補上捲軸寬度，避免畫面跳動）
    if (scrollbar > 0) body.style.paddingRight = scrollbar + "px";
    if (panelRef.current) panelRef.current.focus();

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const f = Array.prototype.slice
        .call(panelRef.current.querySelectorAll('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter((el) => el.offsetParent !== null);
      if (f.length === 0) {
        e.preventDefault();
        return;
      }
      const cur = document.activeElement;
      if (!panelRef.current.contains(cur) || (e.shiftKey && (cur === f[0] || cur === panelRef.current))) {
        e.preventDefault();
        f[f.length - 1].focus();
      } else if (!e.shiftKey && cur === f[f.length - 1]) {
        e.preventDefault();
        f[0].focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPad;
      if (timer.current) clearTimeout(timer.current);
      if (prevFocus && prevFocus.focus) prevFocus.focus(); // 焦點回到觸發的按鈕
    };
  }, []);

  const idx = tabs.findIndex((t) => t.key === active);
  const onTabKey = (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = tabs[(idx + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    onTab(next.key);
    setTimeout(() => {
      const el = panelRef.current && panelRef.current.querySelector('[role="tab"][aria-selected="true"]');
      if (el) el.focus();
    }, 0);
  };

  return ReactDOM.createPortal(
    div(
      {
        className: cx("fb-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-[2px] sm:p-6", closing && "fb-out"),
        onMouseDown: (e) => { downOnBackdrop.current = e.target === e.currentTarget; },
        onClick: (e) => { if (downOnBackdrop.current && e.target === e.currentTarget) requestClose(); },
      },
      div(
        {
          ref: panelRef,
          role: "dialog",
          "aria-modal": true,
          "aria-label": tabs[idx].label,
          tabIndex: -1,
          className: cx("fb-panel flex max-h-[85vh] w-full max-w-xl flex-col rounded-2xl border border-line bg-panel text-ink shadow-2xl outline-none", closing && "fb-out"),
        },
        div(
          { className: "flex items-end justify-between gap-2 border-b border-line px-3 pt-2" },
          div(
            { role: "tablist", onKeyDown: onTabKey, className: "flex gap-1" },
            tabs.map((t) =>
              btn(
                {
                  key: t.key,
                  type: "button",
                  role: "tab",
                  "aria-selected": t.key === active,
                  tabIndex: t.key === active ? 0 : -1,
                  onClick: () => onTab(t.key),
                  className: cx("-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm", t.key === active ? "border-brand font-bold text-ink" : "border-transparent text-mute hover:text-ink"),
                },
                t.label,
                t.badge !== undefined && span({ className: "rounded-full bg-soft px-1.5 text-xs font-normal tabular-nums text-mute" }, t.badge)
              )
            )
          ),
          btn({ type: "button", onClick: requestClose, "aria-label": "關閉", className: "mb-1 grid h-9 w-9 shrink-0 place-items-center rounded-lg text-mute hover:bg-soft hover:text-ink" }, Ico(ICON.x, "h-5 w-5"))
        ),
        div({ role: "tabpanel", className: "min-h-0 flex-1 overflow-y-auto px-5 pb-5" }, children)
      )
    ),
    document.body
  );
}

/* ------------------------------------------------------------------ *
 * 燈箱內容：球員狀態（誰打了幾場、現在在哪）
 * ------------------------------------------------------------------ */
function StatusContent({ session, byId, where, games, counter }) {
  const rowOf = (p) => ({ id: p.id, name: p.name, gender: p.gender || null, games: games[p.id] || 0, at: where.get(p.id) });
  const rows = session.players.filter((p) => !p.left).map(rowOf);
  const leftRows = session.players.filter((p) => p.left).map(rowOf);
  const vals = rows.map((r) => r.games);
  const spread = vals.length ? Math.max.apply(null, vals) - Math.min.apply(null, vals) : 0;
  const mix = teamMix(session.history.concat(session.courts.filter(Boolean)), byId);
  const mixText =
    mix.mixed + mix.men + mix.women > 0
      ? "隊伍組成（已結束加上場中）：混雙 " + mix.mixed + " 組、男雙 " + mix.men + " 組、女雙 " + mix.women + " 組" + (mix.unknown ? "（另有 " + mix.unknown + " 組含未指定性別）" : "") + "。"
      : "";
  const th = "sticky top-0 bg-panel pb-1.5 pt-1 text-xs font-normal text-mute";
  const gridRow = (r, muted) =>
    h(
      React.Fragment,
      { key: r.id },
      span({ className: cx("flex min-w-0 items-center gap-1.5", muted && "opacity-60") }, GenderMark({ g: r.gender }), span({ className: "truncate" }, r.name)),
      span({ className: cx("text-right tabular-nums", muted && "opacity-60") }, r.games),
      muted
        ? span({ className: "truncate text-xs text-mute" }, "已離場")
        : span({ className: cx("truncate text-xs", r.at && r.at.zone === "court" ? "font-bold text-brand" : "text-mute") }, r.at ? r.at.label : "")
    );
  return div(
    null,
    div(
      { className: "flex flex-wrap gap-x-5 gap-y-1 py-4 text-sm" },
      span(null, "已結束 ", span({ className: "font-bold tabular-nums" }, session.history.length), " 場"),
      span(null, "場數差 ", span({ className: "font-bold tabular-nums" }, spread)),
      span({ className: counter.partnerRepeats > 0 ? "text-warn" : "" }, "隊友重複 ", span({ className: "font-bold tabular-nums" }, counter.partnerRepeats))
    ),
    para({ className: "mb-3 text-xs text-mute" }, "「已打」只計算已結束的比賽；「目前」是此刻所在的位置；場數差只計算仍在場上的人。" + mixText),
    div(
      { className: "grid grid-cols-[minmax(0,1fr)_3.5rem_6.5rem] items-baseline gap-x-2 gap-y-1.5 text-sm" },
      span({ className: th }, "球員"),
      span({ className: cx(th, "text-right") }, "已打"),
      span({ className: th }, "目前"),
      rows.map((r) => gridRow(r, false))
    ),
    leftRows.length > 0 &&
      div(
        { className: "mt-4" },
        div({ className: "mb-1.5 text-xs font-medium text-mute" }, "已離場"),
        div({ className: "grid grid-cols-[minmax(0,1fr)_3.5rem_6.5rem] items-baseline gap-x-2 gap-y-1.5 text-sm" }, leftRows.map((r) => gridRow(r, true)))
      )
  );
}

/* ------------------------------------------------------------------ *
 * 燈箱內容：已結束的比賽（最新的在最上面）
 * ------------------------------------------------------------------ */
function HistoryContent({ session, byId }) {
  const nm = (ids) => ids.map((id) => (byId[id] ? byId[id].name : "?")).join("、");
  const list = session.history.slice().reverse();
  if (list.length === 0) return para({ className: "py-8 text-center text-sm text-mute" }, "還沒有結束的比賽。");
  return ul(
    { className: "space-y-2 pt-4 text-sm" },
    list.map((m) =>
      li(
        { key: m.id + ":" + m.seq, className: "flex gap-3" },
        span({ className: "w-9 shrink-0 text-right text-xs tabular-nums text-mute" }, "#" + m.seq),
        div(
          { className: "min-w-0" },
          div({ className: "text-xs text-mute" }, "場地 " + m.court),
          div(null, nm(m.teamA), span({ className: "mx-2 text-mute" }, "vs"), nm(m.teamB))
        )
      )
    )
  );
}

/* ------------------------------------------------------------------ *
 * 手機：判斷是否為窄螢幕（< 1024px）
 * ------------------------------------------------------------------ */
function useMedia(query) {
  const get = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    if (mq.addEventListener) mq.addEventListener("change", on);
    else mq.addListener(on);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", on);
      else mq.removeListener(on);
    };
  }, [query]);
  return matches;
}

/* ------------------------------------------------------------------ *
 * 手機：精簡看板的一組（不畫球場，A 隊左欄、B 隊右欄）
 *   kind = "live"（上場區，綠底）/ "wait"（等待區，灰底）
 * ------------------------------------------------------------------ */
function CompactGroup({ group, kind, title, sub, action, ctx }) {
  const live = kind === "live";
  const dupA = ctx.counter.partner(group.teamA[0], group.teamA[1]);
  const dupB = ctx.counter.partner(group.teamB[0], group.teamB[1]);
  const typeA = teamType(group.teamA, ctx.byId);
  const typeB = teamType(group.teamB, ctx.byId);
  const meta = [typeA && "A " + typeA, typeB && "B " + typeB].filter(Boolean).join("　");
  const flags = [dupA > 1 && "A 組重複搭檔", dupB > 1 && "B 組重複搭檔"].filter(Boolean).join("、");
  const slot = (team, i) =>
    h(Slot, {
      key: group.id + team + i,
      id: group[team][i],
      group,
      team,
      slotKey: group.id + ":" + team + ":" + i,
      tone: team === "teamA" ? TONE_A : TONE_B,
      wrap: "w-full",
      inner: "relative w-full",
      align: team === "teamA" ? "left" : "right",
      ctx,
    });

  return div(
    { className: cx("rounded-xl p-2", live ? "bg-court text-courtline" : "border border-line bg-soft text-ink") },
    div(
      { className: cx("mb-1.5 flex items-center justify-between gap-2", live ? "min-h-[2.25rem]" : "min-h-[1.5rem]") },
      div(
        { className: "min-w-0" },
        div({ className: "flex items-baseline gap-2" }, span({ className: "text-sm font-bold" }, title), sub && span({ className: "text-[11px]" }, sub)),
        (meta || flags) &&
          div({ className: "truncate text-[11px]" }, meta, flags && span({ className: cx("font-bold", meta ? "ml-2" : "", live ? "text-chipb" : "text-warn") }, flags))
      ),
      action
    ),
    div(
      { className: "grid grid-cols-2 gap-2" },
      div({ className: "flex flex-col gap-1.5" }, slot("teamA", 0), slot("teamA", 1)),
      div({ className: "flex flex-col gap-1.5" }, slot("teamB", 0), slot("teamB", 1))
    )
  );
}

/* ------------------------------------------------------------------ *
 * 手機：底部分頁列（場次 / 名單 / 設定），固定在螢幕下方，方便單手操作
 * ------------------------------------------------------------------ */
function TabBar({ tab, onTab, rosterCount, staleDot }) {
  const item = (key, label, icon, badge, dot) =>
    btn(
      {
        key,
        type: "button",
        "aria-current": tab === key ? "page" : undefined,
        onClick: () => onTab(key),
        className: cx("relative flex flex-col items-center gap-0.5 border-t-2 pb-1.5 pt-2 text-xs", tab === key ? "border-brand font-bold text-brand" : "border-transparent text-mute"),
      },
      span(
        { className: "relative" },
        Ico(icon, "h-5 w-5"),
        badge !== undefined && span({ className: "absolute -right-4 -top-1.5 rounded-full bg-soft px-1.5 text-[10px] font-medium tabular-nums text-ink" }, badge),
        dot && span({ className: "absolute -right-1.5 -top-0.5 h-2 w-2 rounded-full bg-warn", title: "名單或場地數已變更" })
      ),
      label
    );
  return h(
    "nav",
    { "aria-label": "主要分頁", className: "fixed inset-x-0 bottom-0 z-40 border-t border-line bg-panel", style: { paddingBottom: "env(safe-area-inset-bottom, 0px)" } },
    div({ className: "mx-auto grid max-w-lg grid-cols-3" }, item("board", "場次", ICON.board, undefined, staleDot), item("roster", "名單", ICON.users, rosterCount), item("settings", "設定", ICON.sliders))
  );
}

/* ------------------------------------------------------------------ *
 * 浮動提示（Toast）
 *   - position: fixed，不佔頁面版面，所以出現 / 消失時上場區不會被推動
 *   - 手機：浮在底部分頁列上方；桌機：置中浮在視窗下方
 *   - 6 秒後自動消失；可按「復原」或 ✕ 立即處理
 * ------------------------------------------------------------------ */
function Toast({ msg, mobile, onUndo, onClose }) {
  useEffect(() => {
    if (!msg) return undefined;
    const t = setTimeout(onClose, 6000);
    return () => clearTimeout(t);
  }, [msg]);
  if (!msg) return null;
  return div(
    {
      role: "status",
      "aria-live": "polite",
      className: "toast-in fixed inset-x-3 z-[45] mx-auto flex max-w-md items-center gap-3 rounded-xl bg-ink py-2.5 pl-4 pr-2 text-sm text-page shadow-xl",
      style: { bottom: mobile ? "calc(4.5rem + env(safe-area-inset-bottom, 0px))" : "1.5rem" },
    },
    span({ className: "min-w-0 flex-1" }, msg.text),
    msg.undo && btn({ type: "button", onClick: onUndo, className: "shrink-0 rounded-md bg-page px-3 py-1.5 font-bold text-ink" }, "復原"),
    btn({ type: "button", onClick: onClose, "aria-label": "關閉提示", className: "grid h-8 w-8 shrink-0 place-items-center rounded-md text-page hover:bg-soft hover:text-ink" }, Ico(ICON.x, "h-4 w-4"))
  );
}

/* ------------------------------------------------------------------ *
 * App
 * ------------------------------------------------------------------ */
function App() {
  const saved = useMemo(loadStore, []);

  const [players, setPlayers] = useState(() =>
    saved && Array.isArray(saved.players)
      ? saved.players.map((p) => ({ ...p, gender: p.gender === "M" || p.gender === "F" ? p.gender : null }))
      : makeSample()
  );
  const [courts, setCourts] = useState((saved && saved.courts) || 1);
  const [mix, setMix] = useState(saved ? saved.mix !== false : true); // 混搭：打破固定四人組
  const [draft, setDraft] = useState("");
  const [newGender, setNewGender] = useState(null); // 新增球員時的預設性別
  const [notice, setNotice] = useState("");
  const [openKey, setOpenKey] = useState(null);
  const [flash, setFlash] = useState(null);
  const [msg, setMsg] = useState(null); // 最近一次操作的浮動提示：{ text, undo }
  const [modal, setModal] = useState(null); // 燈箱："status" 球員狀態 / "history" 已結束的比賽 / null
  const [undo, setUndo] = useState([]); // 復原堆疊（存放先前的 session）
  const [confirmReset, setConfirmReset] = useState(false);
  const [copied, setCopied] = useState(null);
  const [showExport, setShowExport] = useState(false);
  const [exportGender, setExportGender] = useState(true);
  const [expCopied, setExpCopied] = useState(null);

  const d = derive(players, courts);
  const isMobile = useMedia("(max-width: 1023px)"); // 手機 / 平板直式：精簡看板 + 底部分頁

  const [session, setSession] = useState(() => {
    const restored = restoreSession(saved && saved.session);
    if (restored) return restored;
    const init = derive(players, courts);
    return init.n >= 4 ? startSession(players, init.effCourts) : null;
  });
  const [tab, setTab] = useState(() => (session ? "board" : "roster")); // 手機底部分頁："board" | "roster" | "settings"

  useEffect(() => {
    saveStore({ players, courts, mix, session });
  }, [players, courts, mix, session]);

  const autoClear = (value, setter, ms) =>
    useEffect(() => {
      if (value === null || value === false) return undefined;
      const t = setTimeout(() => setter(value === true ? false : null), ms);
      return () => clearTimeout(t);
    }, [value]);
  autoClear(flash, setFlash, 1800);
  autoClear(copied, setCopied, 2000);
  autoClear(expCopied, setExpCopied, 2000);
  autoClear(confirmReset, setConfirmReset, 4000);

  const where = useMemo(() => (session ? locatePlayers(session) : new Map()), [session]);
  const games = useMemo(() => (session ? countGames(session) : {}), [session]);
  const counter = useMemo(() => (session ? buildPairCounter(session) : null), [session]);
  const byId = useMemo(() => {
    const m = {};
    if (session) session.players.forEach((p) => (m[p.id] = p));
    return m;
  }, [session]);

  const stale = !!session && session.sig !== makeSig(players, d.effCourts);
  const waitingCount = session ? session.queue.length * 4 + session.pending.length : 0;

  /* ---- 名單操作 ---- */
  function addNames(raw) {
    // 先切開多筆，再解析每筆名字後面的性別標註（"小明 男"、"Amy F"）
    const items = raw.split(/[\n,，、;；]+/).map((s) => s.trim()).filter(Boolean).map(parseNameToken);
    if (items.length === 0) return;
    const seen = new Set(players.map((p) => p.name.toLowerCase()));
    const added = [];
    const skipped = [];
    items.forEach((it) => {
      const name = it.name.slice(0, 16);
      const k = name.toLowerCase();
      if (!name) return;
      if (seen.has(k)) skipped.push(name);
      else {
        seen.add(k);
        added.push({ id: uid(), name, gender: it.gender || newGender });
      }
    });
    if (added.length) setPlayers(players.concat(added));
    setNotice(skipped.length ? "已略過重複的名字：" + skipped.join("、") : "");
    setDraft("");
  }
  const onDraftKey = (e) => {
    // 中文輸入法選字時按 Enter 不應送出
    if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      addNames(draft);
    }
  };
  // 切換性別：未指定 → 男 → 女 → 未指定；進行中的排程也同步更新顯示（不列入復原）
  function cycleGender(id) {
    const cur = players.find((p) => p.id === id);
    if (!cur) return;
    const g = nextGender(cur.gender);
    const patch = (list) => list.map((p) => (p.id === id ? { ...p, gender: g } : p));
    setPlayers(patch(players));
    setSession((s) => (s ? { ...s, players: patch(s.players) } : s));
  }
  const removePlayer = (id) => {
    setPlayers(players.filter((p) => p.id !== id));
    setNotice("");
  };

  /* ---- 排程操作（每一步都可復原） ----
   * 大部分操作只改 session；「離場」還會同時把人從名單移除、可能連場地數都變，
   * 所以復原堆疊記錄的是 { session, players, courts } 這一組快照，一次全部復原。
   */
  function commit(next, message, flashIds, opts) {
    setUndo((u) => (session ? u.concat([{ session, players, courts }]).slice(-40) : u));
    if (opts && opts.players) setPlayers(opts.players);
    if (opts && opts.courts !== undefined) setCourts(opts.courts);
    setSession(next);
    setMsg(message ? { text: message, undo: true } : null);
    setFlash(flashIds ? { ids: flashIds } : null);
    setOpenKey(null);
  }
  function undoLast() {
    if (undo.length === 0) return;
    const last = undo[undo.length - 1];
    setSession(last.session);
    setPlayers(last.players);
    setCourts(last.courts);
    setUndo(undo.slice(0, -1));
    setMsg({ text: "已復原上一步。", undo: false });
    setFlash(null);
    setOpenKey(null);
  }
  function generate() {
    // 已經打過比賽時，需要再按一次確認，避免誤觸清掉進度（也可以按「復原」救回）
    if (session && session.history.length > 0 && !confirmReset) {
      setConfirmReset(true);
      return;
    }
    setConfirmReset(false);
    commit(startSession(players, d.effCourts), "已隨機重排第一輪。");
    setTab("board"); // 手機：排好後直接回到場次分頁
  }
  function finish(ci) {
    const next = finishCourt(session, ci, { mix });
    const g = next.courts[ci];
    const nm = (ids) => ids.map((id) => (byId[id] ? byId[id].name : "?")).join("、");
    commit(next, "場地 " + (ci + 1) + " 結束。換上場：" + nm(g.teamA) + "  vs  " + nm(g.teamB), g.teamA.concat(g.teamB));
  }
  function pick(curId, newId) {
    commit(swapPlayers(session, curId, newId), null, [curId, newId]);
  }
  function reshuffle() {
    commit(reshuffleWaiting(session), "已重新打散等待區。");
  }
  function leave(id) {
    const name = byId[id] ? byId[id].name : "?";
    const oldCourts = session.courts;
    const next = leavePlayer(session, id);
    const newRoster = players.filter((p) => p.id !== id);

    const courtIdx = oldCourts.findIndex((g) => g && (g.teamA.indexOf(id) !== -1 || g.teamB.indexOf(id) !== -1));
    let message;
    if (courtIdx !== -1 && next.courts.length < oldCourts.length) {
      message = name + " 已離場。人數不足，場地 " + (courtIdx + 1) + " 已關閉。";
    } else if (courtIdx !== -1) {
      const oldIds = oldCourts[courtIdx].teamA.concat(oldCourts[courtIdx].teamB);
      const newIds = next.courts[courtIdx].teamA.concat(next.courts[courtIdx].teamB);
      const replId = newIds.find((x) => oldIds.indexOf(x) === -1);
      const replName = replId && byId[replId] ? byId[replId].name : replId;
      message = name + " 已離場" + (replName ? "，" + replName + " 遞補上場。" : "。");
    } else {
      message = name + " 已離場。";
    }

    // 場地數若因離場而變少，順便同步「場次設定」裡的場地數，這樣的變更不算「已變更」，不用重新開始
    const courtsChanged = next.courts.length !== oldCourts.length;
    commit({ ...next, sig: makeSig(newRoster, next.courts.length) }, message, null, { players: newRoster, courts: courtsChanged ? next.courts.length : courts });
  }
  function openModal(key) {
    setOpenKey(null); // 先收起換人選單
    setModal(key);
  }
  async function copyBoard() {
    setCopied((await copyText(boardToText(session))) ? "ok" : "fail");
  }

  /* ---------------- 版面 ---------------- */
  const heroCourt = h(
    "svg",
    { viewBox: "-2 -2 138 65", fill: "none", stroke: "currentColor", strokeWidth: 1.2, className: "pointer-events-none absolute right-4 top-6 hidden w-72 text-brand opacity-25 sm:block", "aria-hidden": true },
    h("rect", { x: 0, y: 0, width: 134, height: 61 }),
    h("path", { d: COURT_LINES }),
    h("path", { d: "M67 -2V63", strokeDasharray: "3 2.5", strokeWidth: 2 })
  );

  const genderCount = { M: 0, F: 0, none: 0 };
  players.forEach((p) => (p.gender === "M" ? genderCount.M++ : p.gender === "F" ? genderCount.F++ : genderCount.none++));

  const genderSeg = (g, text) =>
    btn(
      {
        type: "button",
        "aria-pressed": newGender === g,
        onClick: () => setNewGender(g),
        className: cx("px-2.5 py-1 text-xs", newGender === g ? "bg-ink font-bold text-page" : "hover:bg-soft"),
      },
      text
    );

  const exportText = exportRoster(players, exportGender);
  const exportPanel = div(
    { className: "mb-3 rounded-lg border border-line bg-page p-2.5" },
    lbl({ htmlFor: "export-text", className: "mb-1 block text-xs font-medium text-mute" }, "名單字串（以逗號分隔）"),
    h("textarea", {
      id: "export-text",
      readOnly: true,
      rows: 3,
      value: exportText,
      onFocus: (e) => e.target.select(),
      className: "block w-full resize-none rounded-md border border-line bg-panel px-2 py-1.5 text-sm",
    }),
    div(
      { className: "mt-2 flex items-center justify-between gap-2" },
      lbl(
        { className: "flex cursor-pointer items-center gap-1.5 text-xs" },
        inp({ type: "checkbox", checked: exportGender, onChange: (e) => setExportGender(e.target.checked), className: "h-3.5 w-3.5 accent-brand" }),
        "包含性別"
      ),
      btn(
        {
          type: "button",
          onClick: async () => setExpCopied((await copyText(exportText)) ? "ok" : "fail"),
          className: cx(BTN_GHOST, "!py-1 !text-xs"),
        },
        Ico(expCopied === "ok" ? ICON.check : ICON.copy, "h-3.5 w-3.5"),
        expCopied === "ok" ? "已複製" : expCopied === "fail" ? "複製失敗，請手動選取" : "複製"
      )
    ),
    para({ className: "mt-1.5 text-xs text-mute" }, "貼回下方輸入框按 Enter，就能還原名單與性別。")
  );

  const roster = div(
    { className: "p-4" },
    div(
      { className: "mb-3 flex items-center justify-between" },
      h2({ className: "text-base font-bold" }, "球員名單", span({ className: "ml-2 rounded-full bg-soft px-2 py-0.5 text-xs font-medium text-mute" }, players.length + " 人")),
      div(
        { className: "flex gap-0.5" },
        btn({ type: "button", onClick: () => { setPlayers(makeSample()); setNotice(""); }, className: BTN_LINK }, "範例名單"),
        players.length > 0 && btn({ type: "button", "aria-expanded": showExport, onClick: () => setShowExport(!showExport), className: cx(BTN_LINK, showExport && "text-ink underline") }, "匯出"),
        players.length > 0 && btn({ type: "button", onClick: () => { setPlayers([]); setNotice(""); }, className: BTN_LINK }, "清空")
      )
    ),
    showExport && players.length > 0 && exportPanel,
    div(
      { className: "flex gap-2" },
      inp({
        type: "text",
        value: draft,
        onChange: (e) => { setDraft(e.target.value); setNotice(""); },
        onKeyDown: onDraftKey,
        // 單行輸入框會把貼上內容的換行吃掉，所以多行貼上時直接攔截處理
        onPaste: (e) => {
          const text = e.clipboardData ? e.clipboardData.getData("text") : "";
          if (/[\r\n]/.test(text)) {
            e.preventDefault();
            addNames(draft.trim() ? draft + "\n" + text : text);
          }
        },
        placeholder: "輸入名字，按 Enter 新增",
        "aria-label": "新增球員",
        className: "min-w-0 flex-1 rounded-lg border border-line bg-page px-3 py-2 text-sm placeholder:text-mute",
      }),
      btn({ type: "button", disabled: !draft.trim(), onClick: () => addNames(draft), className: BTN_PRIMARY }, Ico(ICON.plus), "新增")
    ),
    div(
      { className: "mt-2 flex items-center gap-2 text-xs text-mute" },
      span(null, "新增的人預設為"),
      div({ className: "flex overflow-hidden rounded-md border border-line" }, genderSeg(null, "未指定"), genderSeg("M", "男"), genderSeg("F", "女"))
    ),
    para(
      { className: cx("mt-1.5 text-xs", notice ? "font-medium text-warn" : "text-mute"), "aria-live": "polite" },
      notice || "可一次貼上多個名字，用逗號或換行分隔。性別寫在名字後面，例如「小明 男」、「Amy F」。"
    ),
    players.length === 0
      ? para({ className: "mt-4 text-sm text-mute" }, "還沒有球員。至少要 4 位才能排場次。")
      : ul(
          { className: "mt-3 flex max-h-56 flex-wrap gap-1.5 overflow-y-auto" },
          players.map((p) =>
            li(
              { key: p.id, className: "inline-flex items-center gap-1.5 rounded-md bg-soft py-1 pl-1.5 pr-1 text-sm" },
              btn(
                {
                  type: "button",
                  title: "點擊切換性別（未指定、男、女）",
                  "aria-label": p.name + " 性別：" + (p.gender ? G_TEXT[p.gender] : "未指定") + "，點擊切換",
                  onClick: () => cycleGender(p.id),
                  className: cx("grid h-5 w-5 shrink-0 place-items-center rounded text-[11px] font-bold leading-none", p.gender ? G_STYLE[p.gender] : "border border-dashed border-mute text-mute"),
                },
                p.gender ? G_TEXT[p.gender] : "?"
              ),
              span(null, p.name),
              btn({ type: "button", "aria-label": "刪除 " + p.name, onClick: () => removePlayer(p.id), className: "rounded p-0.5 text-mute hover:bg-line hover:text-warn" }, Ico(ICON.x, "h-3.5 w-3.5"))
            )
          )
        ),
    players.length > 0 &&
      para(
        { className: "mt-2 text-xs text-mute" },
        "男 " + genderCount.M + " 位、女 " + genderCount.F + " 位" + (genderCount.none ? "、未指定 " + genderCount.none + " 位" : "")
      )
  );

  const stepBtn = "h-8 w-8 rounded-lg border border-line text-lg leading-none hover:bg-soft disabled:opacity-40 disabled:hover:bg-transparent";

  const settings = div(
    { className: cx("space-y-4 p-4", !isMobile && "border-t border-line") },
    h2({ className: "text-base font-bold" }, "場次設定"),
    div(
      { className: "flex items-center justify-between gap-3" },
      div(null, div({ className: "text-sm font-medium" }, "場地數"), div({ className: "text-xs text-mute" }, "每個場地需要 4 人，目前最多 " + d.maxCourts + " 個")),
      div(
        { className: "flex items-center gap-2" },
        btn({ type: "button", "aria-label": "減少場地", disabled: d.effCourts <= 1, onClick: () => setCourts(Math.max(1, d.effCourts - 1)), className: stepBtn }, "−"),
        span({ className: "w-5 text-center font-display text-lg font-bold tabular-nums" }, d.effCourts),
        btn({ type: "button", "aria-label": "增加場地", disabled: d.effCourts >= d.maxCourts, onClick: () => setCourts(Math.min(d.maxCourts, d.effCourts + 1)), className: stepBtn }, "+")
      )
    ),
    lbl(
      { className: "flex cursor-pointer items-start gap-2 text-sm" },
      inp({ type: "checkbox", checked: mix, onChange: (e) => setMix(e.target.checked), className: "mt-0.5 h-4 w-4 accent-brand" }),
      span(
        null,
        "混搭，避免固定四人組",
        span({ className: "block text-xs text-mute" }, "等待人數剛好是 4 的倍數時，同一批人會一直同組。開啟後，只在「下一場」會出現重複隊友時，才讓 1 位球員與後面一組互換。")
      )
    ),
    div(
      null,
      btn(
        { type: "button", disabled: d.n < 4, onClick: generate, className: cx(BTN_PRIMARY, "w-full py-2.5") },
        confirmReset ? "再按一次確認，重新開始" : session ? "重新開始（隨機重排）" : "開始排程"
      ),
      d.n < 4
        ? para({ className: "mt-1.5 text-xs text-warn" }, "至少需要 4 位球員。")
        : para({ className: "mt-1.5 text-xs text-mute" }, "會把所有人隨機分配到上場區與等待區，作為第一輪。")
    )
  );

  /* ---------------- 右側：上場區 / 等待區 ---------------- */
  const ctx = session && { byId, where, games, counter, players: session.players, openKey, setOpenKey, flash, onPick: pick, onLeave: leave };

  const toolbar = div(
    { className: "mb-4 flex flex-wrap items-end justify-between gap-2" },
    div(null, h2({ className: "text-lg font-bold" }, "場次控制台"), para({ className: "text-xs text-mute" }, session ? "已結束 " + session.history.length + " 場。點球員名字可以換人。" : "尚未開始")),
    session &&
      div(
        { className: "flex gap-2" },
        btn({ type: "button", disabled: undo.length === 0, onClick: undoLast, className: cx(BTN_GHOST, "disabled:opacity-40 disabled:hover:bg-transparent") }, Ico(ICON.undo), "復原"),
        btn(
          { type: "button", onClick: copyBoard, className: BTN_GHOST },
          Ico(copied === "ok" ? ICON.check : ICON.copy),
          copied === "ok" ? "已複製" : copied === "fail" ? "複製失敗，請手動選取" : "複製成文字"
        )
      )
  );

  const staleBar =
    stale &&
    div(
      { role: "status", className: "mb-4 flex flex-wrap items-center justify-between gap-2 border-l-4 border-warn bg-soft px-3 py-2 text-sm" },
      span(null, "名單或場地數已變更，目前進行中的仍是舊設定。"),
      d.n >= 4 && btn({ type: "button", onClick: generate, className: "font-bold text-brand underline underline-offset-2" }, confirmReset ? "再按一次確認，重新開始" : "套用並重新開始")
    );

  const courtsSection =
    session &&
    section(
      { className: "mb-9" },
      div(
        { className: "mb-3 flex items-baseline justify-between border-b border-line pb-1" },
        h2({ className: "text-xl font-black" }, "上場區"),
        span({ className: "text-xs text-mute" }, session.courts.length + " 個場地，比賽結束請按「結束」")
      ),
      div(
        { className: "grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-x-5 gap-y-6" },
        session.courts.map((g, i) =>
          g
            ? h(GroupBlock, {
                key: g.id,
                group: g,
                variant: "live",
                title: "場地 " + (i + 1),
                sub: g.startedAt && h(Timer, { startedAt: g.startedAt }),
                ctx,
                action: btn(
                  { type: "button", onClick: () => finish(i), "aria-label": "結束場地 " + (i + 1) + " 的比賽", className: cx(BTN_PRIMARY, "!px-3 !py-1.5") },
                  Ico(ICON.check, "h-4 w-4"),
                  "結束"
                ),
              })
            : null
        )
      )
    );

  const waitSection =
    session &&
    section(
      { className: "mb-8" },
      div(
        { className: "mb-1 flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-1" },
        h2({ className: "text-xl font-black" }, "等待區", span({ className: "ml-2 text-sm font-normal text-mute" }, waitingCount + " 人排隊")),
        waitingCount > 1 &&
          btn({ type: "button", onClick: reshuffle, title: "把等待中的人隨機洗牌後重新分組", className: BTN_GHOST }, "打散等待區")
      ),
      para({ className: "mb-3 text-xs text-mute" }, "依「下一場」、第 2 組、第 3 組的順序上場。場地一結束，最前面的一組會自動推上去，剛結束的人回到隊尾。"),
      session.queue.length > 0 &&
        div(
          { className: "grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-x-5 gap-y-5" },
          session.queue.map((g, i) =>
            h(GroupBlock, { key: g.id, group: g, variant: "wait", title: i === 0 ? "下一場" : "第 " + (i + 1) + " 組", sub: i === 0 ? "最先上場" : "", ctx })
          )
        ),
      session.pending.length > 0 &&
        div(
          { className: cx(session.queue.length > 0 ? "mt-6" : "") },
          div(
            { className: "mb-2 text-sm font-medium" },
            "候補",
            span({ className: "ml-2 text-xs font-normal text-mute" }, session.pending.length + " 人，還差 " + (4 - session.pending.length) + " 人成組")
          ),
          div(
            { className: "flex flex-wrap gap-2" },
            session.pending.map((id) =>
              h(Slot, { key: id, id, group: null, team: null, slotKey: "pending:" + id, tone: TONE_WAIT, wrap: "w-36", align: "left", ctx })
            )
          )
        ),
      waitingCount === 0 && para({ className: "rounded-lg border border-dashed border-line px-3 py-4 text-sm text-mute" }, "目前沒有人在等待：所有球員都在場上。結束一場後，剛下場的人會馬上重新分組上場。")
    );

  // 檢視按鈕：點了以燈箱（FancyBox 效果）顯示，不佔用頁面版面
  const viewBar =
    session &&
    div(
      { className: "mb-5 flex flex-wrap gap-2" },
      btn({ type: "button", onClick: () => openModal("status"), className: BTN_GHOST }, Ico(ICON.users), "球員狀態"),
      btn(
        { type: "button", onClick: () => openModal("history"), className: BTN_GHOST },
        Ico(ICON.list),
        "已結束的比賽",
        span({ className: "rounded-full bg-soft px-1.5 text-xs tabular-nums text-mute" }, session.history.length)
      )
    );

  // 浮動提示：固定在畫面下方，不佔版面，不會把上場區往下推
  const toastEl = h(Toast, { msg, mobile: isMobile, onUndo: undoLast, onClose: () => setMsg(null) });

  const modalEl =
    session &&
    modal &&
    h(
      Modal,
      {
        tabs: [
          { key: "status", label: "球員狀態" },
          { key: "history", label: "已結束的比賽", badge: session.history.length },
        ],
        active: modal,
        onTab: setModal,
        onClose: () => setModal(null),
      },
      modal === "status" ? h(StatusContent, { session, byId, where, games, counter }) : h(HistoryContent, { session, byId })
    );

  const emptyView =
    !session &&
    div(
      { className: "rounded-2xl border border-dashed border-line p-8" },
      para({ className: "text-base font-bold" }, "還沒有開始"),
      para({ className: "mt-1 max-w-sm text-sm text-mute" }, "在左側加入至少 4 位球員，設定場地數後按「開始排程」。系統會隨機排出第一輪，之後靠「結束」按鈕輪替。")
    );

  const headerEl = header(
    { className: "relative overflow-hidden" },
    heroCourt,
    div(
      { className: "relative mx-auto max-w-6xl px-4 pb-3 pt-4 sm:pb-7 sm:pt-9" },
      h1({ className: "text-2xl font-black tracking-tight sm:text-4xl lg:text-5xl" }, "羽球雙打排程"),
      para({ className: "mt-2 hidden max-w-md text-sm text-mute sm:block" }, "隨機排出第一輪。比賽結束按「結束」，等待區最前面的一組就自動上場，隨時可以換人。")
    )
  );

  /* ---------------- 手機版：精簡看板 + 底部分頁 ---------------- */
  const swatch = (bg, text) => span({ className: "inline-flex items-center gap-1" }, span({ className: cx("h-2.5 w-2.5 rounded-sm border border-line", bg) }), text);
  const smallBtn = "inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium hover:bg-soft disabled:opacity-40 disabled:hover:bg-transparent";

  const mobileActions =
    session &&
    div(
      { className: "mb-3 flex flex-wrap items-center gap-1.5" },
      btn({ type: "button", disabled: undo.length === 0, onClick: undoLast, className: smallBtn }, Ico(ICON.undo, "h-3.5 w-3.5"), "復原"),
      btn(
        { type: "button", onClick: copyBoard, "aria-label": "複製成文字", className: smallBtn },
        Ico(copied === "ok" ? ICON.check : ICON.copy, "h-3.5 w-3.5"),
        copied === "ok" ? "已複製" : copied === "fail" ? "複製失敗" : null
      ),
      btn({ type: "button", onClick: () => openModal("status"), className: smallBtn }, Ico(ICON.users, "h-3.5 w-3.5"), "球員狀態"),
      btn({ type: "button", onClick: () => openModal("history"), className: smallBtn }, Ico(ICON.list, "h-3.5 w-3.5"), "已結束 " + session.history.length)
    );

  const courtsMobile =
    session &&
    section(
      { className: "mb-5" },
      div(
        { className: "mb-2 flex items-center justify-between gap-2" },
        h2({ className: "text-lg font-black" }, "上場區"),
        span({ className: "flex items-center gap-2.5 text-xs text-mute" }, swatch("bg-chipa", "A 組"), swatch("bg-chipb", "B 組"))
      ),
      div(
        { className: "grid gap-2.5 sm:grid-cols-2" },
        session.courts.map((g, i) =>
          g
            ? h(CompactGroup, {
                key: g.id,
                group: g,
                kind: "live",
                title: "場地 " + (i + 1),
                sub: g.startedAt && h(Timer, { startedAt: g.startedAt }),
                ctx,
                action: btn(
                  { type: "button", onClick: () => finish(i), "aria-label": "結束場地 " + (i + 1) + " 的比賽", className: "inline-flex items-center gap-1 rounded-lg bg-chipa px-3.5 py-1.5 text-sm font-bold text-chipaink" },
                  Ico(ICON.check, "h-4 w-4"),
                  "結束"
                ),
              })
            : null
        )
      )
    );

  const waitMobile =
    session &&
    section(
      null,
      div(
        { className: "mb-2 flex items-center justify-between gap-2" },
        h2({ className: "text-lg font-black" }, "等待區", span({ className: "ml-2 text-xs font-normal text-mute" }, waitingCount + " 人排隊")),
        waitingCount > 1 && btn({ type: "button", onClick: reshuffle, title: "把等待中的人隨機洗牌後重新分組", className: smallBtn }, "打散")
      ),
      session.queue.length > 0 &&
        div(
          { className: "grid gap-2 sm:grid-cols-2" },
          session.queue.map((g, i) => h(CompactGroup, { key: g.id, group: g, kind: "wait", title: i === 0 ? "下一場" : "第 " + (i + 1) + " 組", ctx }))
        ),
      session.pending.length > 0 &&
        div(
          { className: session.queue.length > 0 ? "mt-3" : "" },
          div({ className: "mb-1.5 text-sm font-medium" }, "候補", span({ className: "ml-2 text-xs font-normal text-mute" }, session.pending.length + " 人，還差 " + (4 - session.pending.length) + " 人成組")),
          div(
            { className: "flex flex-wrap gap-1.5" },
            session.pending.map((id, k) => h(Slot, { key: id, id, group: null, team: null, slotKey: "pending:" + id, tone: TONE_WAIT, wrap: "w-[calc(50%-3px)]", inner: "relative w-full", align: k % 2 === 0 ? "left" : "right", ctx }))
          )
        ),
      waitingCount === 0 && para({ className: "rounded-lg border border-dashed border-line px-3 py-3 text-sm text-mute" }, "目前沒有人在等待：所有球員都在場上。")
    );

  const emptyMobile = div(
    { className: "rounded-2xl border border-dashed border-line p-6" },
    para({ className: "text-base font-bold" }, "還沒有開始"),
    para({ className: "mt-1 text-sm text-mute" }, "先到「名單」加入至少 4 位球員，再到「設定」按「開始排程」。"),
    btn({ type: "button", onClick: () => setTab("roster"), className: cx(BTN_PRIMARY, "mt-3") }, "前往名單")
  );

  if (isMobile) {
    const panel = (child) => section({ className: "rounded-2xl border border-line bg-panel" }, child);
    const mobileBody =
      tab === "roster" ? panel(roster) : tab === "settings" ? panel(settings) : session ? div(null, mobileActions, staleBar, courtsMobile, waitMobile) : emptyMobile;
    return div(
      { className: "min-h-screen" },
      // 手機版不顯示標題列，只保留給讀屏軟體的 h1，內容直接從畫面頂端開始
      h1({ className: "sr-only" }, "羽球雙打排程"),
      main({ className: "mx-auto max-w-2xl px-3 pb-28 pt-3" }, mobileBody),
      h(TabBar, { tab, onTab: setTab, rosterCount: players.length, staleDot: stale }),
      modalEl,
      toastEl
    );
  }

  /* ---------------- 桌機版：球場示意圖 + 左右兩欄 ---------------- */
  return div(
    { className: "min-h-screen" },
    headerEl,
    main(
      { className: "mx-auto grid max-w-6xl items-start gap-8 px-4 pb-20 lg:grid-cols-[21rem_minmax(0,1fr)]" },
      section({ className: "rounded-2xl border border-line bg-panel lg:sticky lg:top-4" }, roster, settings),
      section(null, toolbar, viewBar, staleBar, courtsSection, waitSection, emptyView)
    ),
    modalEl,
    toastEl
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(h(App));

