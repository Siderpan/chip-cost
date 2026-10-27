/* 自動最佳策略（管理後台「選股驗證 → 最佳策略」用）
   由夜間排程呼叫，把結果存成 strategy.json。系統自己調整下面這些參數，找出目前最好的一組，並告訴你「現在買哪幾檔、什麼價位賣」：
     ‧ 投資標的：用哪一種篩選策略（起漲、穩健、低接、順勢、共識＝同時被兩種以上策略選中），取前幾名
     ‧ 買進時間：隔日開盤買／回檔 1.5% 掛單（3 日內沒成交就取消）／隔日收盤確認不比今天弱才買
     ‧ 賣出時間：最長持有 5、10、20、40、60 個交易日
     ‧ 停利、停損、移動停損（從最高價回落多少就賣）；停損和移動停損至少要設一個，這樣每一檔都有明確的「跌到哪裡就賣」
     ‧ 過去時間：用最近 60、120、250、500 個交易日的表現來挑參數，哪一種回頭看最準，就用哪一種
   怎麼避免「事後諸葛」：
     ‧ 走前一步驗證（walk-forward）：每 5 個交易日，只用「當時已經結束的交易」挑出最好的參數，再拿它去做接下來 5 天的新訊號，這些成績才算數。
     ‧ 挑參數時用「平均報酬扣掉兩倍標準誤」再除以持有天數，樣本太少或波動太大的組合會被扣分；樣本不足 20 筆的組合不考慮；平均報酬不是正的就空手。
     ‧ 停利停損用盤中最高最低價判斷，同一天都碰到時一律當作先停損；跳空直接用開盤價成交；成本含手續費與證交稅。
     ‧ 每天夜間整份重算，歷史不會被改寫；參數有變動會記在 log。 */

const FEE = 0.001425, TAX = 0.003, LOT = 1000;
const STR = { rise: "起漲", steady: "穩健", dip: "低接", trend: "順勢", cons: "共識" };
const SKEYS = Object.keys(STR);
const ENTRY = ["隔日開盤買", "回檔 1.5% 掛單", "隔日收盤確認"];
const KS = [1, 2, 3], HOLDS = [5, 10, 20, 40, 60], TPS = [0, 5, 8, 12, 18, 25], SLS = [0, 3, 5, 7, 10, 15], TRS = [0, 8];
const LOOKS = [60, 120, 250, 500];
let NMIN = 20, Z = 2, HYST = 1.3;
const BLK = 5, NP = 3 * HOLDS.length * TPS.length * SLS.length * TRS.length, NK = KS.length, NS = SKEYS.length, ST = 5;
const r2 = x => Math.round(x * 100) / 100;
const netRet = (p0, px) => px * (1 - FEE - TAX) / (p0 * (1 + FEE)) - 1;

// 參數編號 ↔ (買進方式, 最長持有, 停利, 停損, 移動停損)
const decode = p => { const tr = p % TRS.length; p = (p - tr) / TRS.length; const sl = p % SLS.length; p = (p - sl) / SLS.length; const tp = p % TPS.length; p = (p - tp) / TPS.length; const h = p % HOLDS.length; const e = (p - h) / HOLDS.length; return { e, H: HOLDS[h], tp: TPS[tp], sl: SLS[sl], tr: TRS[tr], h }; };
const PAR = Array.from({ length: NP }, (_, p) => decode(p));

// 一張的買賣。成功回傳 true，結果放在 S：j 買進日、p0 買進價、x 賣出日（-1 還沒賣）、px 賣出價（沒賣就是最後收盤）、why 原因
const S = { j: 0, p0: 0, x: -1, px: 0, why: "" };
function sim(a, g, par, last) {
  const o = a.o, c = a.c, hi = a.hi, lo = a.lo, re = a.real;
  let j, p0, t0;
  if (par.e === 0) { j = g + 1; if (j > last || o[j] == null || !re[j]) return false; p0 = o[j]; t0 = j; }
  else if (par.e === 1) {
    const lim = c[g] * 0.985; let f = -1;
    for (let k = g + 1; k <= g + 3 && k <= last; k++) { if (o[k] == null || !re[k]) continue; if (o[k] <= lim) { f = k; p0 = o[k]; break; } if (lo[k] <= lim) { f = k; p0 = lim; break; } }
    if (f < 0) return false; j = f; t0 = j;
  } else { j = g + 1; if (j > last || c[j] == null || !re[j] || c[g] == null || c[j] < c[g]) return false; p0 = c[j]; t0 = j + 1; }
  const tpP = par.tp ? p0 * (1 + par.tp / 100) : 0, slP = par.sl ? p0 * (1 - par.sl / 100) : 0, tk = par.tr ? 1 - par.tr / 100 : 0, end = j + par.H;
  let peak = p0;
  S.j = j; S.p0 = p0;
  for (let t = t0; t <= last && t <= end; t++) {
    if (t === end) { S.x = t; S.px = o[t]; S.why = "時間到"; return true; }
    let stop = slP; if (tk) { const ts = peak * tk; if (ts > stop) stop = ts; }
    if (stop > 0) {
      if (o[t] <= stop) { S.x = t; S.px = o[t]; S.why = slP && stop === slP ? "停損" : "移動停損"; return true; }
      if (lo[t] <= stop) { S.x = t; S.px = stop; S.why = slP && stop === slP ? "停損" : "移動停損"; return true; }
    }
    if (tpP) {
      if (o[t] >= tpP) { S.x = t; S.px = o[t]; S.why = "停利"; return true; }
      if (hi[t] >= tpP) { S.x = t; S.px = tpP; S.why = "停利"; return true; }
    }
    if (hi[t] > peak) peak = hi[t];
  }
  S.x = -1; S.px = c[last]; S.why = "";
  return true;
}

// 台股升降單位
const tickOf = p => p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5;
const rt = (p, dir) => { const t = tickOf(p), q = p / t, n = dir < 0 ? Math.floor(q + 1e-9) : dir > 0 ? Math.ceil(q - 1e-9) : Math.round(q); return +(n * t).toFixed(2); };
const addBiz = (ds, n) => { const d = new Date(ds + "T00:00:00Z"); let k = 0; while (k < n) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) k++; } return d.toISOString().slice(0, 10); };

// 共識：被兩種以上策略同時選中的股票，依「被選中的策略數」、再依各策略排名
function consOf(L) {
  const cnt = new Map(), rk = new Map();
  for (const s of ["rise", "steady", "dip", "trend"]) (L[s] || []).forEach((c, i) => { cnt.set(c, (cnt.get(c) || 0) + 1); rk.set(c, (rk.get(c) || 0) + i); });
  return [...cnt.keys()].filter(c => cnt.get(c) >= 2).sort((a, b) => cnt.get(b) - cnt.get(a) || rk.get(a) - rk.get(b));
}
const listOf = (L, s) => s === "cons" ? consOf(L) : (L[s] || []);

const comboOf = (s, k, p) => (s * NK + k) * NP + p;
const label = cf => `${STR[cf.strat]}前 ${cf.K} 名・${ENTRY[cf.e]}・停利 ${cf.tp ? cf.tp + "%" : "不設"}・停損 ${cf.sl ? cf.sl + "%" : "不設"}・移動停損 ${cf.tr ? cf.tr + "%" : "不設"}・最長持有 ${cf.H} 日`;

function run({ dates, A, lists, names, prev, top, opts = {} }) {
  NMIN = opts.nmin || 20; Z = opts.z == null ? 2 : opts.z; HYST = opts.hyst == null ? 1.3 : opts.hyst;
  const last = dates.length - 1, nb = Math.floor(last / BLK) + 2, stride = nb * ST;
  const pickDays = dates.map((d, g) => lists[d] ? g : -1).filter(g => g >= 0);
  if (pickDays.length < 200) throw new Error("可用的選股紀錄不到 200 天，先不做最佳化（需要先補足歷史名單）。");
  const firstG = pickDays[0];
  // 1) 每一個候選訊號 × 每一組參數，模擬買賣，累加到「區塊累積表」
  const cum = new Float32Array(NS * NK * NP * stride);
  const lotsBy = new Array(last + 1).fill(null);                       // 每天各策略的前三名（代碼）
  for (const g of pickDays) { const L = lists[dates[g]], o = {}; for (const s of SKEYS) o[s] = listOf(L, s).slice(0, 3); lotsBy[g] = o; }
  for (let si = 0; si < NS; si++) for (const g of pickDays) {
    const cs = lotsBy[g][SKEYS[si]], b = Math.floor(g / BLK) + 1;
    for (let r = 0; r < cs.length; r++) {
      const a = A[cs[r]]; if (!a) continue;
      for (let p = 0; p < NP; p++) {
        if (!sim(a, g, PAR[p], last) || S.x < 0) continue;
        const rr = netRet(S.p0, S.px), hold = Math.max(1, S.x - S.j), w = rr > 0 ? 1 : 0;
        for (let k = r; k < NK; k++) { const i = comboOf(si, k, p) * stride + b * ST; cum[i] += 1; cum[i + 1] += rr; cum[i + 2] += rr * rr; cum[i + 3] += hold; cum[i + 4] += w; }
      }
    }
  }
  for (let cb = 0; cb < NS * NK * NP; cb++) { const base = cb * stride; for (let b = 1; b < nb; b++) for (let q = 0; q < ST; q++) cum[base + b * ST + q] += cum[base + (b - 1) * ST + q]; }
  // 2) 在某一天 t，用「過去 L 天、而且已經結束的交易」替每一組參數打分，回傳最好的
  const statOf = (cb, lb, ub) => { const base = cb * stride, n = cum[base + ub * ST] - cum[base + lb * ST]; if (n <= 0) return null; const sum = cum[base + ub * ST + 1] - cum[base + lb * ST + 1], sq = cum[base + ub * ST + 2] - cum[base + lb * ST + 2], hold = cum[base + ub * ST + 3] - cum[base + lb * ST + 3], win = cum[base + ub * ST + 4] - cum[base + lb * ST + 4]; return { n, sum, sq, hold, win }; };
  const scoreAt = (t, L, want) => {
    const lb = Math.max(0, Math.ceil((t - L) / BLK)), res = [];
    let best = null;
    for (let h = 0; h < HOLDS.length; h++) {
      const ub = Math.min(nb - 1, Math.floor((t - (HOLDS[h] + 4) + 1) / BLK)); if (ub <= lb) continue;
      for (let p = 0; p < NP; p++) {
        if (PAR[p].h !== h || !(PAR[p].sl || PAR[p].tr)) continue;   // 一定要有停損價（停損或移動停損），才給得出「跌到哪裡賣」
        for (let si = 0; si < NS; si++) for (let k = 0; k < NK; k++) {
          const st = statOf(comboOf(si, k, p), lb, ub); if (!st || st.n < NMIN) continue;
          const mean = st.sum / st.n; if (mean <= 0) continue;
          const sd = Math.sqrt(Math.max(0, st.sq / st.n - mean * mean)), se = sd / Math.sqrt(st.n), hold = st.hold / st.n, score = (mean - Z * se) / Math.max(hold, 2);
          if (score <= 0) continue;
          if (want) res.push({ si, k, p, score, n: st.n, mean, win: st.win / st.n, hold });
          else if (!best || score > best.score) best = { si, k, p, score, n: st.n, mean, win: st.win / st.n, hold };
        }
      }
    }
    return want ? res.sort((a, b) => b.score - a.score) : best;
  };
  // 指定某一組參數，算它在 t 這天的分數（用來判斷「現有的參數要不要換」）
  const scoreOne = (c, t, L) => {
    if (!(PAR[c.p].sl || PAR[c.p].tr)) return null;
    const lb = Math.max(0, Math.ceil((t - L) / BLK)), h = PAR[c.p].h, ub = Math.min(nb - 1, Math.floor((t - (HOLDS[h] + 4) + 1) / BLK)); if (ub <= lb) return null;
    const st = statOf(comboOf(c.si, c.k, c.p), lb, ub); if (!st || st.n < NMIN) return null;
    const mean = st.sum / st.n; if (mean <= 0) return null;
    const sd = Math.sqrt(Math.max(0, st.sq / st.n - mean * mean)), hold = st.hold / st.n, score = (mean - Z * sd / Math.sqrt(st.n)) / Math.max(hold, 2);
    return score > 0 ? { si: c.si, k: c.k, p: c.p, score, n: st.n, mean, win: st.win / st.n, hold } : null;
  };
  // 換參數要有明顯更好（超過現有的 HYST 倍）才換，避免每次都跟著雜訊跳來跳去
  const keepOr = (best, cur, t, L) => { if (!cur) return best; const kp = scoreOne(cur, t, L); return kp && (!best || best.score < kp.score * HYST) ? kp : best; };
  const cfOf = c => ({ strat: SKEYS[c.si], K: KS[c.k], ...PAR[c.p] });
  // 3) 走前一步驗證：每 5 天重選一次參數，只拿來做接下來 5 天的新訊號
  const tStart = Math.ceil((firstG + 100) / BLK) * BLK;
  const wf = Object.fromEntries(LOOKS.map(L => [L, { lots: [], picks: [], cur: null }]));
  for (let t = tStart; t <= last; t += BLK) {
    for (const L of LOOKS) {
      const best = keepOr(scoreAt(t, L, false), wf[L].cur, t, L); wf[L].cur = best; wf[L].picks.push({ t, best });
      if (!best) continue;
      const cf = cfOf(best), par = PAR[best.p];
      for (let g = t; g < t + BLK && g <= last; g++) {
        if (!lotsBy[g]) continue;
        const cs = lotsBy[g][cf.strat].slice(0, cf.K);
        for (const c of cs) { const a = A[c]; if (!a || !sim(a, g, par, last)) continue; wf[L].lots.push({ c, g, j: S.j, p0: S.p0, x: S.x, px: S.px, why: S.why, train: best.mean }); }
      }
    }
  }
  const summ = lots => {
    if (!lots.length) return { n: 0 };
    let sum = 0, win = 0, hold = 0, closed = 0, worst = 0, pnl = 0, cost = 0, trn = 0;
    for (const l of lots) { const r = netRet(l.p0, l.px), c0 = l.p0 * (1 + FEE) * LOT; sum += r; if (r > 0) win++; if (r < worst) worst = r; trn += l.train; pnl += l.px * (1 - FEE - TAX) * LOT - c0; cost += c0; if (l.x >= 0) { closed++; hold += l.x - l.j; } else hold += last - l.j; }
    const avgHold = Math.max(1, hold / lots.length);
    return { n: lots.length, closed, open: lots.length - closed, win: r2(win / lots.length * 100), avg: r2(sum / lots.length * 100), hold: r2(avgHold), day: r2(sum / lots.length * 100 / avgHold), worst: r2(worst * 100), pnl: Math.round(pnl), ret: r2(pnl / cost * 100), train: r2(trn / lots.length * 100) };
  };
  const byL = {}; for (const L of LOOKS) byL[L] = { ...summ(wf[L].lots), changes: wf[L].picks.reduce((n, x, i, ar) => n + (i && JSON.stringify(x.best && [x.best.si, x.best.k, x.best.p]) !== JSON.stringify(ar[i - 1].best && [ar[i - 1].best.si, ar[i - 1].best.k, ar[i - 1].best.p]) ? 1 : 0), 0), steps: wf[L].picks.length, idle: wf[L].picks.filter(x => !x.best).length };
  // 選「過去時間」：走前一步驗證成績（日均報酬）最好的，樣本太少不算
  let Lstar = 120, bestDay = -1e9;
  for (const L of LOOKS) { const s = byL[L]; if (s.n >= 30 && s.day > bestDay) { bestDay = s.day; Lstar = L; } }
  // 4) 現在：用 Lstar 天的資料挑出目前最好的一組
  const tNow = last + 1;
  let ranked = scoreAt(tNow, Lstar, true);
  const kept = wf[Lstar].cur ? scoreOne(wf[Lstar].cur, tNow, Lstar) : null;
  if (kept && (!ranked.length || ranked[0].score < kept.score * HYST)) ranked = [kept, ...ranked.filter(x => !(x.si === kept.si && x.k === kept.k && x.p === kept.p))];
  const now = ranked[0] || null;
  // 累積報酬曲線（走前一步驗證那些單子）
  const lots = wf[Lstar].lots, curve = [];
  if (lots.length) {
    const g0 = Math.min(...lots.map(l => l.j));
    for (let g = g0; g <= last; g += g === last ? 1 : 2) {
      let cost = 0, pnl = 0, cnt = 0;
      for (const l of lots) { if (l.j > g) continue; cnt++; pnl += netRet(l.p0, l.x >= 0 && l.x <= g ? l.px : A[l.c].c[g]); cost += 1; }   // 每筆等權重：到那天為止的平均報酬
      if (cnt >= 10) curve.push([dates[g], r2(pnl / cost * 100)]);   // 前面只有幾張單的時候，累積報酬會亂跳，先不畫
      if (g === last) break;
    }
  }
  // 參數歷史、選用比例
  const hist = wf[Lstar].picks, mix = { strat: {}, H: {}, e: {} };
  for (const x of hist) { if (!x.best) { mix.strat["空手"] = (mix.strat["空手"] || 0) + 1; continue; } const cf = cfOf(x.best); mix.strat[STR[cf.strat]] = (mix.strat[STR[cf.strat]] || 0) + 1; mix.H[cf.H] = (mix.H[cf.H] || 0) + 1; mix.e[ENTRY[cf.e]] = (mix.e[ENTRY[cf.e]] || 0) + 1; }
  const history = []; let prevLab = null;       // 只記「換了參數」的那幾次
  for (const x of hist) { const lab = x.best ? label(cfOf(x.best)) : ""; if (lab !== prevLab) history.push({ d: dates[Math.min(last, x.t)], cf: lab, idle: !x.best }); prevLab = lab; }
  const cfOut = c => { const cf = cfOf(c); return { ...cf, strat: cf.strat, stratName: STR[cf.strat], eName: ENTRY[cf.e], label: label(cf), n: c.n, avg: r2(c.mean * 100), win: r2(c.win * 100), hold: r2(c.hold), day: r2(c.mean / Math.max(c.hold, 2) * 100 * 100) / 100, score: r2(c.score * 10000) / 100 }; };
  // 5) 今日建議
  const lastL = lists[dates[last]] || null, asOf = dates[last];
  const planFor = (c, pred, maxN) => {
    const cf = cfOf(c), par = PAR[c.p], items = [];
    const all = lastL ? listOf(lastL, cf.strat) : [], cs = pred ? all.filter(pred).slice(0, maxN) : all.slice(0, cf.K);
    for (const code of cs) {
      const a = A[code]; if (!a || a.c[last] == null) continue;
      const close = a.c[last], tp = top && top[asOf] && top[asOf][cf.strat === "cons" ? "rise" : cf.strat] ? top[asOf][cf.strat === "cons" ? "rise" : cf.strat].top.find(x => x.c === code) : null;
      const base = par.e === 1 ? rt(close * 0.985, -1) : close;
      const buy = par.e === 0 ? { kind: "隔日開盤買", text: `明天開盤市價買進（參考價約 ${close}）`, price: close } : par.e === 1 ? { kind: "掛單", text: `掛限價 ${base} 買進，3 個交易日內沒成交就取消`, price: base } : { kind: "收盤確認", text: `明天收盤前確認價格不低於 ${close} 再買進`, price: close };
      items.push({ c: code, n: names.get(code) || "", close, buy, tp: par.tp ? { pct: par.tp, price: rt(base * (1 + par.tp / 100), 1) } : null, sl: par.sl ? { pct: par.sl, price: rt(base * (1 - par.sl / 100), -1) } : null, tr: par.tr ? { pct: par.tr, price: rt(base * (1 - par.tr / 100), -1) } : null, exitBy: addBiz(asOf, par.H + (par.e === 1 ? 3 : 1)), H: par.H, rr: tp && tp.rr ? r2(close * tp.rr) : null, ss: tp && tp.ss ? r2(close * tp.ss) : null });
    }
    return items;
  };
  let reco = { items: [], cfg: null, alt: null };
  if (now) {
    reco.cfg = cfOut(now); reco.items = planFor(now);
    if (!reco.items.length) for (const c of ranked.slice(1, 300)) { if (c.si === now.si) continue; const it = planFor(c); if (it.length) { reco.alt = { cfg: cfOut(c), items: it }; break; } }
  }
  // 依股價分級（100 元以下／300 元以下／600 元以下／600 元以上），各推薦 1~3 檔：
  // 優先用「目前最佳」那組參數；它今天在這個價位沒有標的，就改用排名往後、今天在這個價位有標的的那一組（標示為備選）。
  const TIERS = [["100 元以下", 100], ["300 元以下", 300], ["600 元以下", 600], ["600 元以上", Infinity]], tierOf = p => p <= 100 ? 0 : p <= 300 ? 1 : p <= 600 ? 2 : 3;
  const todayBy = SKEYS.map(s => { const o = [[], [], [], []]; if (lastL) for (const code of listOf(lastL, s)) { const a = A[code]; if (a && a.c[last] != null) o[tierOf(a.c[last])].push(code); } return o; });
  const tierHist = [0, 1, 2, 3].map(ti => { const ls = wf[Lstar].lots.filter(l => tierOf(l.p0) === ti); if (!ls.length) return { n: 0 }; let sum = 0, win = 0; for (const l of ls) { const rr = netRet(l.p0, l.px); sum += rr; if (rr > 0) win++; } return { n: ls.length, avg: r2(sum / ls.length * 100), win: r2(win / ls.length * 100) }; });
  reco.tiers = TIERS.map(([name], ti) => {
    let cfg = null, items = [], fb = false;
    for (const c of ranked) { if (!todayBy[c.si][ti].length) continue; const pred = code => { const a = A[code]; return a && a.c[last] != null && tierOf(a.c[last]) === ti; }; items = planFor(c, pred, 3); if (items.length) { cfg = cfOut(c); fb = !!now && c.si !== now.si; break; } }
    return { name, items, cfg, fallback: fb, hist: tierHist[ti] };
  });
  // 以下只保留每個 (策略, 買進方式, 持有天數) 最好的前 5 組，免得全是相近的參數
  const seen = new Set(), topCfg = [];
  for (const c of ranked) { const key = `${c.si}|${c.k}|${PAR[c.p].e}|${PAR[c.p].h}`; if (seen.has(key)) continue; seen.add(key); topCfg.push(cfOut(c)); if (topCfg.length >= 5) break; }
  // 6) 紀錄參數有沒有換（每天整份重算，但換了就留一筆）
  const log = prev && prev.log ? prev.log.slice() : [];
  const curLabel = now ? label(cfOf(now)) : "空手";
  if (!log.length || log[log.length - 1].cf !== curLabel) log.push({ d: asOf, cf: curLabel, L: Lstar });
  return {
    v: 1, updated: new Date().toISOString(), asOf, range: { from: dates[firstG], to: asOf, days: pickDays.length }, lookback: Lstar,
    config: reco.cfg, reco, top: topCfg, byL,
    oos: { ...byL[Lstar], curve, from: dates[tStart], mix, history: history.slice(-10) },
    log: log.slice(-40), grid: { combos: NS * NK * NP, strategies: SKEYS.map(s => STR[s]) }
  };
}

if (typeof module !== "undefined") module.exports = { run, STR, ENTRY };
else if (typeof window !== "undefined") window.OPTIMIZER = { run, STR, ENTRY };
