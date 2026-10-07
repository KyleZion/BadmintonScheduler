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
 * @property {boolean} [stay]        連打：true 時，只要他所在的場地結束，他會直接留在原地打下一場，
 *                                   不回等待區排隊，無視「打一休一」的公平排程，直到手動關閉為止。
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
export function createSession(playersInput, options = {}) {
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
 *   沒標記「連打」的人回到等待區隊尾 → 等待區最前面補上空缺 → 標記「連打」的人直接留在原地
 *   （整組都沒人連打時，就是原本的行為：全部清空，換等待區最前面的一組上場）
 * @param {Session} session
 * @param {number} courtIndex  從 0 開始
 * @param {{rng?: () => number, mix?: boolean}} [options]  mix 預設 true（見上方「混搭」說明）
 * @returns {Session}
 */
export function finishCourt(session, courtIndex, options = {}) {
  const rng = options.rng || Math.random;
  const match = session.courts[courtIndex];
  if (!match) return session;

  const s = clone(session);
  s.history.push({ id: match.id, seq: s.history.length + 1, court: courtIndex + 1, teamA: match.teamA, teamB: match.teamB });

  const stayOf = {};
  s.players.forEach((p) => (stayOf[p.id] = !!p.stay));
  const four = match.teamA.concat(match.teamB);
  const rotators = four.filter((id) => !stayOf[id]); // 要回等待區排隊的人
  const stayers = four.filter((id) => stayOf[id]); // 連打：直接留在原本的場地

  // 連打只生效這一次：用掉之後自動清掉標記，下次比賽結束就恢復正常排程，不用手動關閉
  if (stayers.length > 0) {
    const used = new Set(stayers);
    s.players = s.players.map((p) => (used.has(p.id) ? { ...p, stay: false } : p));
  }

  // 回等待區的人排進隊尾：已打場數少的排前面（同數量隨機）
  const games = countGames(s);
  const back = rotators
    .map((id) => ({ id, g: games[id] || 0, r: rng() }))
    .sort((a, b) => a.g - b.g || a.r - b.r)
    .map((x) => x.id);
  s.pending.push(...back);

  if (stayers.length === four.length) {
    // 整組都連打：原班人馬直接再打一場，不動等待區
    s.seq += 1;
    s.courts[courtIndex] = { id: "g" + s.seq, teamA: match.teamA, teamB: match.teamB, startedAt: Date.now() };
    return s;
  }

  const need = rotators.length; // 連打的人越多，需要遞補的人越少
  fillQueue(s, rng); // 湊滿 4 人就成組
  const flat = s.queue.flatMap((g) => g.teamA.concat(g.teamB)).concat(s.pending);
  const fill = flat.slice(0, need);
  s.queue = [];
  s.pending = flat.slice(need);
  fillQueue(s, rng);

  if (options.mix !== false) mixFront(s, countGames(s));

  const nextFour = stayers.concat(fill);
  const best = bestSplit(buildPairCounter(s), nextFour, rng);
  s.seq += 1;
  s.courts[courtIndex] = { id: "g" + s.seq, teamA: best.a, teamB: best.b, startedAt: Date.now() };
  return s;
}

/**
 * 標記（或取消標記）某位球員「連打下一場」：開啟後，下一次他所在的場地結束比賽時，
 * 他會直接留在原地再打一場，不會回到等待區排隊，無視「打一休一」的公平排程。
 * 只生效一次：用掉之後會自動清掉標記，之後恢復正常輪替，不用手動關閉。
 * 在他的場次結束「之前」，可以隨時用這個函式重新開啟或取消。
 * @param {Session} session
 * @param {string} id
 * @param {boolean} stay
 * @returns {Session}
 */
export function setStay(session, id, stay) {
  return { ...session, players: session.players.map((p) => (p.id === id ? { ...p, stay: !!stay } : p)) };
}

/**
 * 任兩位球員互換位置（可跨場地、跨等待區、包含候補）
 * @param {Session} session
 * @param {string} aId
 * @param {string} bId
 * @returns {Session}
 */
export function swapPlayers(session, aId, bId) {
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
export function reshuffleWaiting(session, options = {}) {
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
export function leavePlayer(session, id, options = {}) {
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
export function countGames(session) {
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
export function locatePlayers(session) {
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
export function buildPairCounter(session) {
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
export function createSeededRng(seed) {
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
