/* 選股策略驗證（管理後台用）：每天追蹤篩選器「大型股」四種策略的前三名，每檔買一張，再同時用多種賣出規則比較長期報酬。
   由夜間排程（screener_job.js）呼叫，結果存成 forward.json，管理後台讀它來畫表和圖。

   規則（都可以在下面的常數改）：
   ‧ 每個交易日收盤後，用篩選器的條件（起漲、穩健、低接、順勢）從內建大型股挑出「全部條件都達標」的股票，依綜合評分排名。
   ‧ 前三名各買一張；達標的不到三檔，有幾檔就買幾檔，一檔都沒有就不買（不拿「最接近」的湊數）。
   ‧ 買進：隔天開盤價。賣出：每個賣出規則都在收盤後判斷，隔天開盤價成交。
   ‧ 每一張都是獨立的「庫存」，每種賣出規則各自記一份，只賣自己手上有的，不會放空。
   ‧ 成本：手續費 0.1425%（買賣各一次）、證交稅 0.3%（賣出）。
   ‧ 第一次執行會用歷史資料「回補」過去一段時間，之後每天只往後追加；回補期和之後的「實際追蹤期」分開統計。
   ‧ 已經算過的日子不會被改動（每天的名單存在 forward.json 的 days 裡）。 */

const STRATS = { rise: "起漲", steady: "穩健", dip: "低接", trend: "順勢" };
const POLS = {
  hold20: "持有 20 日後賣出", hold60: "持有 60 日後賣出", tp: "停利 10%／停損 7%",
  sr: "壓力停利、跌破支撐停損", ma20: "收盤跌破 20 日線", drop: "跌出該策略名單", hold: "只買不賣（買進持有）"
};
const NEED = 3, FEE = 0.001425, TAX = 0.003, LOT = 1000, BACKFILL = 250, MIN_ROWS = 300, WIN = 1500;
const r2 = x => Math.round(x * 100) / 100;

const condOf = P => ({ score: P.score, tech: P.tech, sig: P.sig, near: P.near, str: P.str / 100, rr: P.rr, cov: P.cov / 100, bull: P.bull, stopBuf: 1, tp: 10, sort: "comb" });
// 某一天（第 i 筆）的篩選資料，只用到那天為止的價量（不偷看未來）
function metricsAt(metricsOf, st, i, name) {
  const a = Math.max(0, i - WIN + 1), s = { code: st.code, shares: st.shares, d: st.d.slice(a, i + 1), o: st.o.slice(a, i + 1), h: st.h.slice(a, i + 1), l: st.l.slice(a, i + 1), c: st.c.slice(a, i + 1), v: st.v.slice(a, i + 1) };
  return metricsOf(s, name);
}

// 一檔股票放到「全體交易日」的時間軸上（停牌那天沿用前一天的價格）
function align(st, dates) {
  const ix = new Map(st.d.map((d, i) => [d, i])), o = new Array(dates.length).fill(null), c = new Array(dates.length).fill(null), real = new Array(dates.length).fill(false);
  let lc = null;
  for (let g = 0; g < dates.length; g++) {
    const i = ix.get(dates[g]);
    if (i != null) { o[g] = st.o[i]; c[g] = st.c[i]; lc = st.c[i]; real[g] = true; }
    else if (lc != null) { o[g] = lc; c[g] = lc; }
  }
  const ma = new Array(dates.length).fill(null);
  for (let g = 19; g < dates.length; g++) { let s = 0, ok = true; for (let k = g - 19; k <= g; k++) { if (c[k] == null) { ok = false; break; } s += c[k]; } if (ok) ma[g] = s / 20; }
  return { o, c, real, ma };
}

// 一張的買賣：回傳 { j(買進日), p0, x(賣出日或 -1), px(賣出價), why }
function simLot(A, g, pick, pol, strat, code, days, dates) {
  const j = g + 1, last = dates.length - 1;
  if (j > last || A.o[j] == null) return null;
  const p0 = A.o[j], pp = A.c[g];
  const out = (x, why) => ({ j, p0, x, px: x >= 0 ? A.o[x] : null, why });
  const target = pick.rr && pick.rr >= 1.02 ? pp * pick.rr : pp * 1.10, stop = pick.ss ? pp * pick.ss * 0.99 : pp * 0.92;
  for (let t = j; t <= last; t++) {
    const c = A.c[t]; if (c == null) continue;
    let sig = "";
    if (pol === "hold20") { if (t - j >= 20 - 1) sig = "持有滿 20 日"; }
    else if (pol === "hold60") { if (t - j >= 60 - 1) sig = "持有滿 60 日"; }
    else if (pol === "tp") { const r = c / p0 - 1; if (r >= 0.10) sig = "停利"; else if (r <= -0.07) sig = "停損"; }
    else if (pol === "sr") { if (c >= target) sig = "到壓力停利"; else if (c <= stop) sig = "跌破支撐停損"; else if (t - j >= 60 - 1) sig = "持有滿 60 日"; }
    else if (pol === "ma20") { if (t > j && A.ma[t] != null && c < A.ma[t]) sig = "跌破 20 日線"; }
    else if (pol === "drop") { const dr = days[dates[t]] && days[dates[t]][strat]; if (dr && !dr.pass.includes(code)) sig = "跌出名單"; }
    if (sig) return t + 1 <= last && A.o[t + 1] != null ? out(t + 1, sig) : { j, p0, x: -1, px: null, why: "", pending: sig };
  }
  return out(-1, "");
}
const netRet = (p0, px) => px * (1 - FEE - TAX) / (p0 * (1 + FEE)) - 1;

function summarize(lots, last, A) {
  if (!lots.length) return { n: 0 };
  let cost = 0, pnl = 0, win = 0, hold = 0, worst = 0, closed = 0, sum = 0;
  for (const L of lots) {
    const px = L.x >= 0 ? L.px : A[L.code].c[last], c0 = L.p0 * (1 + FEE) * LOT, v = px * (1 - FEE - TAX) * LOT, r = v / c0 - 1;
    cost += c0; pnl += v - c0; sum += r; if (r > 0) win++; if (r < worst) worst = r;
    if (L.x >= 0) { closed++; hold += L.x - L.j; } else hold += last - L.j;
  }
  return { n: lots.length, closed, open: lots.length - closed, win: r2(win / lots.length * 100), avg: r2(sum / lots.length * 100), pnl: Math.round(pnl), cost: Math.round(cost), ret: r2(pnl / cost * 100), hold: r2(hold / lots.length), worst: r2(worst * 100), day: r2(sum / lots.length * 100 / Math.max(1, hold / lots.length) * 100) / 100 };
}

function update({ metricsOf, scrEval, presets, stocks, names, prev, today, log = () => {} }) {
  const codes = [...stocks.keys()];
  const dates = [...new Set(codes.flatMap(c => stocks.get(c).d))].sort();
  if (dates.length < 400) throw new Error("歷史資料不夠");
  const A = {}, IX = {};
  for (const c of codes) { A[c] = align(stocks.get(c), dates); IX[c] = new Map(stocks.get(c).d.map((d, i) => [d, i])); }
  const days = prev && prev.days ? prev.days : {};
  const lastDay = Object.keys(days).sort().pop() || "";
  const first = !lastDay;
  let todo = dates.filter(d => d > lastDay);
  if (first) todo = todo.slice(-BACKFILL);
  const conds = Object.fromEntries(Object.keys(STRATS).map(k => [k, condOf(presets[k])]));
  for (const d of todo) {
    const evs = [];
    for (const c of codes) {
      const i = IX[c].get(d); if (i == null || i < MIN_ROWS) continue;
      const m = metricsAt(metricsOf, stocks.get(c), i, names.get(c) || "");
      if (m) evs.push({ c, m });
    }
    const rec = {};
    for (const k of Object.keys(STRATS)) {
      const pass = evs.map(x => ({ c: x.c, m: x.m, ev: scrEval(x.m, conds[k]) })).filter(x => x.ev.pass).sort((a, b) => b.ev.comb - a.ev.comb || b.ev.score - a.ev.score);
      rec[k] = { pass: pass.map(x => x.c), top: pass.slice(0, NEED).map(x => ({ c: x.c, rr: x.m.r1 ? r2(x.m.r1.peak / x.m.price * 100) / 100 : null, ss: x.m.s1 ? r2(x.m.s1.low / x.m.price * 100) / 100 : null, k: x.ev.comb })) };
    }
    days[d] = rec;
    if (todo.indexOf(d) % 20 === 0) log(`選股驗證：回補／追加 ${d}（${todo.indexOf(d) + 1} / ${todo.length}）`);
  }
  const liveFrom = prev && prev.liveFrom ? prev.liveFrom : (dates[dates.length - 1]);
  const gOf = new Map(dates.map((d, g) => [d, g])), last = dates.length - 1, dayList = Object.keys(days).sort();
  const accounts = {};
  for (const s of Object.keys(STRATS)) for (const pol of Object.keys(POLS)) {
    const lots = [];
    for (const d of dayList) {
      const top = days[d][s].top, g = gOf.get(d); if (!top.length || g == null) continue;
      for (const pk of top) { const a = A[pk.c]; if (!a) continue; const L = simLot(a, g, pk, pol, s, pk.c, days, dates); if (L) lots.push({ code: pk.c, pick: d, ...L }); }
    }
    const live = lots.filter(L => L.pick >= liveFrom);
    // 累積報酬率曲線：到那天為止的總損益 ÷ 到那天為止投入的總成本
    const curve = [], startG = lots.length ? Math.min(...lots.map(L => L.j)) : last;
    for (let g = startG; g <= last; g++) {
      let cost = 0, pnl = 0;
      for (const L of lots) { if (L.j > g) continue; const c0 = L.p0 * (1 + FEE) * LOT, px = L.x >= 0 && L.x <= g ? L.px : A[L.code].c[g]; cost += c0; pnl += px * (1 - FEE - TAX) * LOT - c0; }
      if (cost) curve.push([dates[g], r2(pnl / cost * 100)]);
    }
    const lotRow = L => { const px = L.x >= 0 ? L.px : A[L.code].c[last]; return { c: L.code, n: names.get(L.code) || "", b: dates[L.j], p0: r2(L.p0), x: L.x >= 0 ? dates[L.x] : "", px: r2(px), r: r2(netRet(L.p0, px) * 100), w: L.why || L.pending || "" }; };
    accounts[`${s}|${pol}`] = {
      all: summarize(lots, last, A), live: summarize(live, last, A), curve,
      open: lots.filter(L => L.x < 0).sort((a, b) => b.j - a.j).slice(0, 40).map(lotRow),
      recent: lots.filter(L => L.x >= 0).sort((a, b) => b.x - a.x).slice(0, 20).map(lotRow)
    };
  }
  // 基準：內建大型股「每一檔、每個交易日各買一張」，分別持有 20 日、60 日的平均每筆報酬（買隔天開盤、賣滿 N 日後的開盤）
  const bench = { hold20: { all: [0, 0], live: [0, 0] }, hold60: { all: [0, 0], live: [0, 0] } };
  for (const c of codes) for (const d of dayList) {
    const g = gOf.get(d), a = A[c]; if (g == null || !a.real[g]) continue;
    for (const [k, N] of [["hold20", 20], ["hold60", 60]]) {
      const j = g + 1, x = j + N; if (x > last || a.o[j] == null || a.o[x] == null) continue;
      const r = netRet(a.o[j], a.o[x]); bench[k].all[0] += r; bench[k].all[1]++; if (d >= liveFrom) { bench[k].live[0] += r; bench[k].live[1]++; }
    }
  }
  for (const k of Object.keys(bench)) for (const p of ["all", "live"]) { const [s, n] = bench[k][p]; bench[k][p] = n ? { avg: r2(s / n * 100), n } : null; }
  const lastRec = days[dayList[dayList.length - 1]] || {};
  const todayPicks = Object.fromEntries(Object.keys(STRATS).map(k => [k, { n: (lastRec[k] || { pass: [] }).pass.length, top: ((lastRec[k] || { top: [] }).top || []).map(x => ({ c: x.c, n: names.get(x.c) || "", k: x.k })) }]));
  return { v: 1, updated: new Date().toISOString(), asOf: dates[last], liveFrom, startDay: dayList[0], strategies: STRATS, policies: POLS, need: NEED, cost: { fee: FEE, tax: TAX }, days, accounts, bench, today: todayPicks };
}

if (typeof module !== "undefined") module.exports = { update, STRATS, POLS };
else if (typeof window !== "undefined") window.FORWARD = { update, STRATS, POLS };
