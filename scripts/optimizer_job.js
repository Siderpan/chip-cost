/* 自動最佳策略（管理後台「選股驗證 → 最佳策略」用）
   由夜間排程呼叫，把結果存成 strategy.json。系統自己調整下面這些參數，找出目前最好的一組，並告訴你「現在買哪幾檔、什麼價位賣」：
     ‧ 投資標的：用哪一種篩選策略（起漲、穩健、低接、順勢、共識＝同時被兩種以上策略選中），取前幾名
     ‧ 買進時間：隔日開盤買／回檔 1.5% 掛單（3 日內沒成交就取消）／隔日收盤確認不比今天弱才買
     ‧ 賣出時間：最長持有 5、10、20、40、60 個交易日
     ‧ 停利、停損、移動停損（從最高價回落多少就賣）；停損和移動停損至少要設一個，這樣每一檔都有明確的「跌到哪裡就賣」
     ‧ 大盤濾網：不看大盤／加權指數在季線上才買／在月線上而且月線上揚才買（大盤不好就空手）
     ‧ 讓獲利奔跑：大盤偏多時不設停利、只用移動停損（最長可抱 120 日）；大盤偏弱才用固定停利
     ‧ 類股輪動：可以只買「近 20 日比整體強」的類股
     ‧ 分散：同一天要買好幾檔時，跳過和已選股票近 60 日走勢太像（相關係數 ≥ 0.6）的
     ‧ 部位大小：波動大的少買、波動小的多買（以每筆 10 萬為基準，0.4～2 倍）
     ‧ 另外三種賣法（和「策略驗證」的固定規則一樣）：到壓力價停利／跌破支撐停損、收盤跌破月線、掉出該策略名單
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
const KS = [1, 2, 3], HOLDS = [5, 10, 20, 40, 60, 120], TPS = [0, 5, 8, 12, 18, 25], SLS = [0, 3, 5, 7, 10, 15];
const RUN_TP = [8, 12, 18], RUN_TR = [10, 15, 20], RUN_SL = [5, 7, 10];
const LOOKS = [60, 120, 250, 500];
const RULES = ["", "壓力停利・支撐停損", "跌破月線賣", "掉出名單賣", "讓獲利奔跑"];
const ROTS = ["不看類股", "只買強勢類股"], PER = 100000, DIV_R = 0.6;
const MKS = ["不看大盤", "大盤在季線上才買", "大盤在月線上且月線上揚才買"];
let NMIN = 20, Z = 2, HYST = 1.3;
const r2 = x => Math.round(x * 100) / 100;
const netRet = (p0, px) => px * (1 - FEE - TAX) / (p0 * (1 + FEE)) - 1;

// 參數表：(買進方式, 最長持有, 停利, 停損, 移動停損, 賣法 x)
//   x=0 固定百分比停利停損；x=1 壓力價停利、跌破支撐停損；x=2 收盤跌破月線（可加停利）；x=3 掉出名單（要加停損）
//   x=4 讓獲利奔跑：買進那天大盤偏多（在季線上）就不設停利、只靠移動停損；偏弱時才用停利。120 日只給這種賣法
const PAR = [];
for (let e = 0; e < 3; e++) for (let h = 0; h < HOLDS.length; h++) {
  const H = HOLDS[h];
  if (H <= 60) {
    for (const tp of TPS) for (const sl of SLS) if (sl) PAR.push({ e, H, h, tp, sl, tr: 0, x: 0 });   // 一定要有停損
    PAR.push({ e, H, h, tp: 0, sl: 0, tr: 0, x: 1 });
    for (const tp of TPS) PAR.push({ e, H, h, tp, sl: 0, tr: 0, x: 2 });
    for (const sl of SLS) if (sl) PAR.push({ e, H, h, tp: 0, sl, tr: 0, x: 3 });
  }
  if (H >= 20) for (const tp of RUN_TP) for (const tr of RUN_TR) for (const sl of RUN_SL) PAR.push({ e, H, h, tp, sl, tr, x: 4 });
}
const BLK = 5, NP = PAR.length, NK = KS.length, NS = SKEYS.length, ST = 5;
const hasStop = par => !!(par.sl || par.tr || par.x === 1 || par.x === 2);   // 每一檔都要有「跌到哪裡（或什麼情況）就賣」

// 每天的名單與支撐壓力（run 開始時設定）：LISTG[g] 那天各策略達標的代碼，LVG[g] 代碼 → [壓力/收盤, 支撐/收盤]；BULL[g] 大盤在季線上
let LISTG = [], LVG = [], BULL = [];
const MEMC = new Map();
const inList = (g, s, code) => { const L = LISTG[g]; if (!L) return true; const k = g + "|" + s; let m = MEMC.get(k); if (!m) { m = new Set(listOf(L, s)); MEMC.set(k, m); } return m.has(code); };
// 支撐壓力賣法的兩個價：用買進前一天（選股那天）的收盤乘上比例；沒有壓力就 +10%、沒有支撐就 −8%（和策略驗證一樣）
const srPx = (g, code, cg) => { const lv = LVG[g] && LVG[g][code]; return { tp: cg * (lv && lv[0] >= 1.02 ? lv[0] : 1.10), sl: lv && lv[1] ? cg * lv[1] * 0.99 : cg * 0.92 }; };

// 一張的買賣。成功回傳 true，結果放在 S：j 買進日、p0 買進價、x 賣出日（-1 還沒賣）、px 賣出價（沒賣就是最後收盤）、why 原因
const S = { j: 0, p0: 0, x: -1, px: 0, why: "" };
function sim(a, g, par, last, code, strat) {
  const o = a.o, c = a.c, hi = a.hi, lo = a.lo, re = a.real, ma = a.ma, x = par.x || 0;
  let j, p0, t0;
  if (par.e === 0) { j = g + 1; if (j > last || o[j] == null || !re[j]) return false; p0 = o[j]; t0 = j; }
  else if (par.e === 1) {
    const lim = c[g] * 0.985; let f = -1;
    for (let k = g + 1; k <= g + 3 && k <= last; k++) { if (o[k] == null || !re[k]) continue; if (o[k] <= lim) { f = k; p0 = o[k]; break; } if (lo[k] <= lim) { f = k; p0 = lim; break; } }
    if (f < 0) return false; j = f; t0 = j;
  } else { j = g + 1; if (j > last || c[j] == null || !re[j] || c[g] == null || c[j] < c[g]) return false; p0 = c[j]; t0 = j + 1; }
  let tpP = par.tp ? p0 * (1 + par.tp / 100) : 0, slP = par.sl ? p0 * (1 - par.sl / 100) : 0;
  if (x === 1) { const v = srPx(g, code, c[g]); tpP = v.tp; slP = v.sl; }
  if (x === 4 && BULL[g]) tpP = 0;                   // 大盤偏多：不設停利，讓獲利奔跑
  const tk = par.tr ? 1 - par.tr / 100 : 0, end = j + par.H;
  let peak = p0;
  S.j = j; S.p0 = p0;
  for (let t = t0; t <= last && t <= end; t++) {
    if (t === end) { S.x = t; S.px = o[t]; S.why = "時間到"; return true; }
    let stop = slP; if (tk) { const ts = peak * tk; if (ts > stop) stop = ts; }
    if (stop > 0) {
      if (o[t] <= stop) { S.x = t; S.px = o[t]; S.why = slP && stop === slP ? (x === 1 ? "跌破支撐" : "停損") : "移動停損"; return true; }
      if (lo[t] <= stop) { S.x = t; S.px = stop; S.why = slP && stop === slP ? (x === 1 ? "跌破支撐" : "停損") : "移動停損"; return true; }
    }
    if (tpP) {
      if (o[t] >= tpP) { S.x = t; S.px = o[t]; S.why = x === 1 ? "到壓力停利" : "停利"; return true; }
      if (hi[t] >= tpP) { S.x = t; S.px = tpP; S.why = x === 1 ? "到壓力停利" : "停利"; return true; }
    }
    if (hi[t] > peak) peak = hi[t];
    // 收盤後才判斷的賣法：隔天開盤賣
    if (t + 1 <= last && t > j && o[t + 1] != null) {
      if (x === 2 && ma && ma[t] != null && c[t] < ma[t]) { S.x = t + 1; S.px = o[t + 1]; S.why = "跌破月線"; return true; }
      if (x === 3 && !inList(t, strat, code)) { S.x = t + 1; S.px = o[t + 1]; S.why = "掉出名單"; return true; }
    }
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

const label = cf => {
  const head = `${STR[cf.strat]}前 ${cf.K} 名${cf.rt ? "（強勢類股）" : ""}・${ENTRY[cf.e]}`, tail = `最長持有 ${cf.H} 日`;
  const mk = cf.m ? `・${MKS[cf.m]}` : "";
  if (cf.x === 1) return `${head}・到壓力價停利・跌破支撐停損・${tail}${mk}`;
  if (cf.x === 2) return `${head}・停利 ${cf.tp ? cf.tp + "%" : "不設"}・收盤跌破月線賣・${tail}${mk}`;
  if (cf.x === 3) return `${head}・停損 ${cf.sl}%・掉出名單賣・${tail}${mk}`;
  if (cf.x === 4) return `${head}・讓獲利奔跑（大盤偏多不設停利、偏弱停利 ${cf.tp}%）・移動停損 ${cf.tr}%・停損 ${cf.sl}%・${tail}${mk}`;
  return `${head}・停利 ${cf.tp ? cf.tp + "%" : "不設"}・停損 ${cf.sl ? cf.sl + "%" : "不設"}・移動停損 ${cf.tr ? cf.tr + "%" : "不設"}・${tail}${mk}`;
};

function run({ dates, A, lists, names, prev, prevPaper, top, opts = {} }) {
  NMIN = opts.nmin || 20; Z = opts.z == null ? 2 : opts.z; HYST = opts.hyst == null ? 1.3 : opts.hyst;
  const last = dates.length - 1, nb = Math.floor(last / BLK) + 2, stride = nb * ST;
  LISTG = dates.map(d => lists[d] || null); LVG = LISTG.map(L => (L && L.lv) || null); MEMC.clear();
  // 大盤濾網：加權指數對齊到每個交易日，OK[m][g] = 那天收盤後，濾網 m 允不允許進場
  const mkM = new Map(opts.mkt || []), MC = []; let mkLast = null;
  for (const d of dates) { const v = mkM.get(d); if (v != null) mkLast = v; MC.push(mkLast); }
  const maOf = n => MC.map((_, g) => { if (g < n - 1) return null; let s = 0; for (let q = g - n + 1; q <= g; q++) { if (MC[q] == null) return null; s += MC[q]; } return s / n; });
  const M20 = maOf(20), M60 = maOf(60), NM = MC.filter(v => v != null).length > 200 ? MKS.length : 1;
  const okFn = [() => true, g => M60[g] != null && MC[g] > M60[g], g => M20[g] != null && g >= 5 && M20[g - 5] != null && MC[g] > M20[g] && M20[g] >= M20[g - 5]];
  const OK = Array.from({ length: NM }, (_, m) => dates.map((_, g) => okFn[m](g)));
  BULL = dates.map((_, g) => NM > 1 && M60[g] != null && MC[g] > M60[g]);
  // 每檔每天的報酬：算波動（部位大小）和相關係數（分散）
  const RET = {}; for (const c of Object.keys(A)) { const a = A[c].c; RET[c] = a.map((v, g) => g && v != null && a[g - 1] ? v / a[g - 1] - 1 : null); }
  const corr60 = (x, y, g) => { const a = RET[x], b = RET[y]; if (!a || !b) return null; let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0; for (let q = Math.max(1, g - 59); q <= g; q++) { const u = a[q], v = b[q]; if (u == null || v == null) continue; n++; sa += u; sb += v; saa += u * u; sbb += v * v; sab += u * v; } if (n < 30) return null; const cv = sab / n - sa / n * sb / n, va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2; return va > 0 && vb > 0 ? cv / Math.sqrt(va * vb) : null; };
  const sizeAt = (c, g) => { const a = RET[c]; if (!a) return 1; let n = 0, s = 0, ss = 0; for (let q = Math.max(1, g - 19); q <= g; q++) { const v = a[q]; if (v == null) continue; n++; s += v; ss += v * v; } if (n < 10) return 1; const sd = Math.sqrt(Math.max(0, ss / n - (s / n) ** 2)); return sd > 0 ? Math.min(2, Math.max(0.4, 0.02 / sd)) : 1; };
  // 同一天要買好幾檔時，依名單順序挑，和已挑的走勢太像就跳過
  const divTop = (list, g, n) => { const out = []; for (const c of list) { if (out.length >= n) break; if (!A[c]) continue; if (out.every(o => { const v = corr60(o, c, g); return v == null || v < DIV_R; })) out.push(c); } return out; };
  // 類股強弱：選股範圍內同產業股票近 20 日平均漲幅，比全部股票的中位數高＝強勢
  const IND = opts.ind || {}, SECG = new Array(last + 1).fill(null);
  const secAt = g => { if (g < 20) return null; const by = new Map(), all = []; for (const c of Object.keys(A)) { const a = A[c].c, k = IND[c]; if (!k || a[g] == null || !a[g - 20]) continue; const v = a[g] / a[g - 20] - 1; all.push(v); if (!by.has(k)) by.set(k, []); by.get(k).push(v); } if (all.length < 20) return null; all.sort((p, q) => p - q); const med = all[all.length >> 1], m = new Map(); for (const [k, vs] of by) { const avg = vs.reduce((s, v) => s + v, 0) / vs.length; m.set(k, { avg, n: vs.length, strong: avg > med }); } return m; };
  const strongOf = (g, c) => { const s = SECG[g]; if (!s) return true; const v = s.get(IND[c]); return !!(v && v.strong); };
  const NR = Object.keys(IND).length ? ROTS.length : 1;
  const comboOf = (s, k, p, m, ro) => (((s * NK + k) * NP + p) * NM + m) * NR + ro;
  const pickDays = dates.map((d, g) => lists[d] ? g : -1).filter(g => g >= 0);
  if (pickDays.length < 200) throw new Error("可用的選股紀錄不到 200 天，先不做最佳化（需要先補足歷史名單）。");
  const firstG = pickDays[0];
  // 1) 每一個候選訊號 × 每一組參數，模擬買賣，累加到「區塊累積表」
  const cum = new Float32Array(NS * NK * NP * NM * NR * stride);
  for (const g of pickDays) SECG[g] = NR > 1 ? secAt(g) : null;
  // 每天各策略的前三名（已經避開走勢太像的）；lotsBy[1] 只從強勢類股裡挑
  const lotsBy = Array.from({ length: NR }, () => new Array(last + 1).fill(null));
  for (const g of pickDays) { const L = lists[dates[g]]; for (let ro = 0; ro < NR; ro++) { const o = {}; for (const s of SKEYS) { const l = listOf(L, s); o[s] = divTop(ro ? l.filter(c => strongOf(g, c)) : l, g, 3); } lotsBy[ro][g] = o; } }
  for (let ro = 0; ro < NR; ro++) for (let si = 0; si < NS; si++) for (const g of pickDays) {
    const cs = lotsBy[ro][g][SKEYS[si]], b = Math.floor(g / BLK) + 1;
    for (let r = 0; r < cs.length; r++) {
      const a = A[cs[r]]; if (!a) continue;
      for (let p = 0; p < NP; p++) {
        if (!sim(a, g, PAR[p], last, cs[r], SKEYS[si]) || S.x < 0) continue;
        const rr = netRet(S.p0, S.px), hold = Math.max(1, S.x - S.j), w = rr > 0 ? 1 : 0;
        for (let m = 0; m < NM; m++) { if (!OK[m][g]) continue; for (let k = r; k < NK; k++) { const i = comboOf(si, k, p, m, ro) * stride + b * ST; cum[i] += 1; cum[i + 1] += rr; cum[i + 2] += rr * rr; cum[i + 3] += hold; cum[i + 4] += w; } }
      }
    }
  }
  for (let cb = 0; cb < NS * NK * NP * NM * NR; cb++) { const base = cb * stride; for (let b = 1; b < nb; b++) for (let q = 0; q < ST; q++) cum[base + b * ST + q] += cum[base + (b - 1) * ST + q]; }
  // 2) 在某一天 t，用「過去 L 天、而且已經結束的交易」替每一組參數打分，回傳最好的
  const statOf = (cb, lb, ub) => { const base = cb * stride, n = cum[base + ub * ST] - cum[base + lb * ST]; if (n <= 0) return null; const sum = cum[base + ub * ST + 1] - cum[base + lb * ST + 1], sq = cum[base + ub * ST + 2] - cum[base + lb * ST + 2], hold = cum[base + ub * ST + 3] - cum[base + lb * ST + 3], win = cum[base + ub * ST + 4] - cum[base + lb * ST + 4]; return { n, sum, sq, hold, win }; };
  const scoreAt = (t, L, want) => {
    const lb = Math.max(0, Math.ceil((t - L) / BLK)), res = [];
    let best = null;
    for (let h = 0; h < HOLDS.length; h++) {
      const ub = Math.min(nb - 1, Math.floor((t - (HOLDS[h] + 4) + 1) / BLK)); if (ub <= lb) continue;
      for (let p = 0; p < NP; p++) {
        if (PAR[p].h !== h || !hasStop(PAR[p])) continue;   // 一定要有停損條件，才給得出「跌到哪裡賣」
        for (let si = 0; si < NS; si++) for (let k = 0; k < NK; k++) for (let m = 0; m < NM; m++) for (let ro = 0; ro < NR; ro++) {
          const st = statOf(comboOf(si, k, p, m, ro), lb, ub); if (!st || st.n < NMIN) continue;
          const mean = st.sum / st.n; if (mean <= 0) continue;
          const sd = Math.sqrt(Math.max(0, st.sq / st.n - mean * mean)), se = sd / Math.sqrt(st.n), hold = st.hold / st.n, score = (mean - Z * se) / Math.max(hold, 2);
          if (score <= 0) continue;
          if (want) res.push({ si, k, p, m, ro, score, n: st.n, mean, win: st.win / st.n, hold });
          else if (!best || score > best.score) best = { si, k, p, m, ro, score, n: st.n, mean, win: st.win / st.n, hold };
        }
      }
    }
    return want ? res.sort((a, b) => b.score - a.score) : best;
  };
  // 指定某一組參數，算它在 t 這天的分數（用來判斷「現有的參數要不要換」）
  const scoreOne = (c, t, L) => {
    if (!hasStop(PAR[c.p])) return null;
    const lb = Math.max(0, Math.ceil((t - L) / BLK)), h = PAR[c.p].h, ub = Math.min(nb - 1, Math.floor((t - (HOLDS[h] + 4) + 1) / BLK)); if (ub <= lb) return null;
    const cm = c.m || 0, cr = c.ro || 0; if (cm >= NM || cr >= NR) return null;
    const st = statOf(comboOf(c.si, c.k, c.p, cm, cr), lb, ub); if (!st || st.n < NMIN) return null;
    const mean = st.sum / st.n; if (mean <= 0) return null;
    const sd = Math.sqrt(Math.max(0, st.sq / st.n - mean * mean)), hold = st.hold / st.n, score = (mean - Z * sd / Math.sqrt(st.n)) / Math.max(hold, 2);
    return score > 0 ? { si: c.si, k: c.k, p: c.p, m: cm, ro: cr, score, n: st.n, mean, win: st.win / st.n, hold } : null;
  };
  // 換參數要有明顯更好（超過現有的 HYST 倍）才換，避免每次都跟著雜訊跳來跳去
  const keepOr = (best, cur, t, L) => { if (!cur) return best; const kp = scoreOne(cur, t, L); return kp && (!best || best.score < kp.score * HYST) ? kp : best; };
  const cfOf = c => ({ strat: SKEYS[c.si], K: KS[c.k], ...PAR[c.p], m: c.m || 0, rt: c.ro || 0 });
  // 3) 走前一步驗證：每 5 天重選一次參數，只拿來做接下來 5 天的新訊號
  const tStart = Math.ceil((firstG + 100) / BLK) * BLK;
  const wf = Object.fromEntries(LOOKS.map(L => [L, { lots: [], picks: [], cur: null }]));
  for (let t = tStart; t <= last; t += BLK) {
    for (const L of LOOKS) {
      const best = keepOr(scoreAt(t, L, false), wf[L].cur, t, L); wf[L].cur = best; wf[L].picks.push({ t, best });
      if (!best) continue;
      const cf = cfOf(best), par = PAR[best.p];
      for (let g = t; g < t + BLK && g <= last; g++) {
        if (!lotsBy[cf.rt][g] || !OK[cf.m][g]) continue;
        const cs = lotsBy[cf.rt][g][cf.strat].slice(0, cf.K);
        for (const c of cs) { const a = A[c]; if (!a || !sim(a, g, par, last, c, cf.strat)) continue; wf[L].lots.push({ c, g, j: S.j, p0: S.p0, x: S.x, px: S.px, why: S.why, train: best.mean, par, f: sizeAt(c, g) }); }
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
  const byL = {}; for (const L of LOOKS) byL[L] = { ...summ(wf[L].lots), changes: wf[L].picks.reduce((n, x, i, ar) => n + (i && JSON.stringify(x.best && [x.best.si, x.best.k, x.best.p, x.best.m, x.best.ro]) !== JSON.stringify(ar[i - 1].best && [ar[i - 1].best.si, ar[i - 1].best.k, ar[i - 1].best.p, ar[i - 1].best.m, ar[i - 1].best.ro]) ? 1 : 0), 0), steps: wf[L].picks.length, idle: wf[L].picks.filter(x => !x.best).length };
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
  const cfOut = c => { const cf = cfOf(c); return { ...cf, strat: cf.strat, stratName: STR[cf.strat], eName: ENTRY[cf.e], xName: RULES[cf.x || 0], mkName: MKS[cf.m || 0], rtName: ROTS[cf.rt || 0], label: label(cf), n: c.n, avg: r2(c.mean * 100), win: r2(c.win * 100), hold: r2(c.hold), day: r2(c.mean / Math.max(c.hold, 2) * 100 * 100) / 100, score: r2(c.score * 10000) / 100 }; };
  // 5) 今日建議
  const lastL = lists[dates[last]] || null, asOf = dates[last];
  const planFor = (c, pred, maxN) => {
    const cf = cfOf(c), par = PAR[c.p], items = [];
    if (!OK[cf.m][last]) return items;                // 大盤濾網今天不允許進場
    const all = lastL ? listOf(lastL, cf.strat) : [], pool = cf.rt ? all.filter(c2 => strongOf(last, c2)) : all, cs = divTop(pred ? pool.filter(pred) : pool, last, pred ? maxN : cf.K);
    for (const code of cs) {
      const a = A[code]; if (!a || a.c[last] == null) continue;
      const close = r2(a.c[last]), tp = top && top[asOf] && top[asOf][cf.strat === "cons" ? "rise" : cf.strat] ? top[asOf][cf.strat === "cons" ? "rise" : cf.strat].top.find(x => x.c === code) : null;
      const base = par.e === 1 ? rt(close * 0.985, -1) : close;
      const buy = par.e === 0 ? { kind: "隔日開盤買", text: `明天開盤市價買進（參考價約 ${close}）`, price: close } : par.e === 1 ? { kind: "掛單", text: `掛限價 ${base} 買進，3 個交易日內沒成交就取消`, price: base } : { kind: "收盤確認", text: `明天收盤前確認價格不低於 ${close} 再買進`, price: close };
      const votes = ["rise", "steady", "dip", "trend"].filter(s => lastL && (lastL[s] || []).includes(code)).length;   // 同時被幾種策略選中
      let tpI = par.tp ? { pct: par.tp, price: rt(base * (1 + par.tp / 100), 1) } : null, slI = par.sl ? { pct: par.sl, price: rt(base * (1 - par.sl / 100), -1) } : null, rule = null;
      if (par.x === 1) { const v = srPx(last, code, close); tpI = { pct: r2((v.tp / base - 1) * 100), price: rt(v.tp, 1), kind: "壓力" }; slI = { pct: r2((1 - v.sl / base) * 100), price: rt(v.sl, -1), kind: "支撐" }; }
      if (par.x === 2) rule = { kind: "ma20", text: `收盤跌破月線${a.ma && a.ma[last] != null ? `（目前約 ${r2(a.ma[last])}）` : ""}，隔天開盤賣` };
      if (par.x === 3) rule = { kind: "drop", text: `掉出「${STR[cf.strat]}」名單，隔天開盤賣` };
      if (par.x === 4 && BULL[last]) { tpI = null; rule = { kind: "run", text: `大盤偏多，不設停利；從最高價回落 ${par.tr}% 才賣` }; }
      const f = sizeAt(code, last), size = { f: r2(f), amt: Math.round(PER * f), shares: Math.floor(PER * f / base) };
      items.push({ c: code, n: names.get(code) || "", close, rank: all.indexOf(code) + 1, of: all.length, votes, buy, tp: tpI, sl: slI, rule, size, strong: SECG[last] ? strongOf(last, code) : null, tr: par.tr ? { pct: par.tr, price: rt(base * (1 - par.tr / 100), -1) } : null, exitBy: addBiz(asOf, par.H + (par.e === 1 ? 3 : 1)), H: par.H, rr: tp && tp.rr ? r2(close * tp.rr) : null, ss: tp && tp.ss ? r2(close * tp.ss) : null });
    }
    return items;
  };
  let reco = { items: [], cfg: null, alt: null };
  if (now) {
    reco.cfg = cfOut(now); reco.items = planFor(now); reco.mkOff = !OK[now.m || 0][last];
    if (!reco.items.length && !reco.mkOff) for (const c of ranked.slice(1, 300)) { if (c.si === now.si) continue; const it = planFor(c); if (it.length) { reco.alt = { cfg: cfOut(c), items: it }; break; } }
  }
  // 依股價分級（100 元以下／300 元以下／600 元以下／600 元以上），各推薦 1~3 檔：
  // 優先用「目前最佳」那組參數；它今天在這個價位沒有標的，就改用排名往後、今天在這個價位有標的的那一組（標示為備選）。
  const TIERS = [["100 元以下", 100], ["300 元以下", 300], ["600 元以下", 600], ["600 元以上", Infinity]], tierOf = p => p <= 100 ? 0 : p <= 300 ? 1 : p <= 600 ? 2 : 3;
  const todayBy = SKEYS.map(s => { const o = [[], [], [], []]; if (lastL) for (const code of listOf(lastL, s)) { const a = A[code]; if (a && a.c[last] != null) o[tierOf(a.c[last])].push(code); } return o; });
  const tierHist = [0, 1, 2, 3].map(ti => { const ls = wf[Lstar].lots.filter(l => tierOf(l.p0) === ti); if (!ls.length) return { n: 0 }; let sum = 0, win = 0; for (const l of ls) { const rr = netRet(l.p0, l.px); sum += rr; if (rr > 0) win++; } return { n: ls.length, avg: r2(sum / ls.length * 100), win: r2(win / ls.length * 100) }; });
  reco.tiers = TIERS.map(([name], ti) => {
    let cfg = null, items = [], fb = false;
    for (const c of ranked) { if (reco.mkOff && !(c.m > 0)) continue; if (!todayBy[c.si][ti].length) continue;   // 主策略因大盤空手時，分級也不拿「不看大盤」的組合來湊
 const pred = code => { const a = A[code]; return a && a.c[last] != null && tierOf(a.c[last]) === ti; }; items = planFor(c, pred, 3); if (items.length) { cfg = cfOut(c); fb = !!now && c.si !== now.si; break; } }
    return { name, items, cfg, fallback: fb, hist: tierHist[ti] };
  });
  // 以下只保留每個 (策略, 買進方式, 持有天數) 最好的前 5 組，免得全是相近的參數
  const seen = new Set(), topCfg = [];
  for (const c of ranked) { const key = `${c.si}|${c.k}|${PAR[c.p].e}|${PAR[c.p].h}|${c.m || 0}`; if (seen.has(key)) continue; seen.add(key); topCfg.push(cfOut(c)); if (topCfg.length >= 5) break; }
  // 7) 模擬交易：每天的推薦（主推薦＋四個價位）當天記下來、不再修改；之後用真實價格照計畫買賣，驗證推薦到底有沒有用。
  //    實際追蹤之前的部分，用「走前一步驗證」那些主推薦的單子回補近半年，讓一開始就有樣本可以看。
  const GR = { main: "主推薦", t0: "100 元以下", t1: "300 元以下", t2: "600 元以下", t3: "600 元以上" };
  const recs = (prevPaper || []).slice(), have = new Set(recs.filter(x => x.d === asOf).map(x => x.gr + "|" + x.c));
  const addRecs = (gr, cfg, items) => { for (const it of items) { const k = gr + "|" + it.c; if (have.has(k)) continue; have.add(k); recs.push({ d: asOf, gr, c: it.c, e: cfg.e, H: cfg.H, tp: cfg.tp, sl: cfg.sl, tr: cfg.tr, x: cfg.x || 0, s: cfg.strat }); } };
  if (reco.cfg) { if (reco.items.length) addRecs("main", reco.cfg, reco.items); else if (reco.alt) addRecs("main", reco.alt.cfg, reco.alt.items); }
  reco.tiers.forEach((T, ti) => { if (T.cfg) addRecs("t" + ti, T.cfg, T.items); });
  const gIdx = new Map(dates.map((d, g) => [d, g])), liveFromD = recs.length ? recs[0].d : asOf, gLive = gIdx.get(liveFromD);
  const trades = [], pend = [], miss = []; let unfilled = 0;
  for (const rc of recs) {
    const g = gIdx.get(rc.d), a = A[rc.c]; if (g == null || !a) continue;
    const par = { e: rc.e, H: rc.H, tp: rc.tp, sl: rc.sl, tr: rc.tr, x: rc.x || 0 };
    if (sim(a, g, par, last, rc.c, rc.s)) trades.push({ gr: rc.gr, c: rc.c, d: rc.d, j: S.j, p0: S.p0, x: S.x, px: S.px, why: S.why, par, live: true, f: sizeAt(rc.c, g) });
    else if (g === last || (rc.e === 1 && g + 3 > last)) pend.push({ gr: rc.gr, c: rc.c, d: rc.d, par });
    else { unfilled++; miss.push({ gr: rc.gr, c: rc.c, d: rc.d }); }
  }
  for (const l of wf[Lstar].lots) if (l.g < gLive && l.g >= last - 130) trades.push({ gr: "main", c: l.c, d: dates[l.g], j: l.j, p0: l.p0, x: l.x, px: l.px, why: l.why, par: l.par, live: false, f: l.f || 1 });
  const pst = ts => {
    if (!ts.length) return { n: 0 };
    let sum = 0, win = 0, hold = 0, closed = 0, worst = 0, pnl = 0;
    for (const t of ts) { const rr = netRet(t.p0, t.px); sum += rr; pnl += rr * PER * (t.f || 1); if (rr > 0) win++; if (rr < worst) worst = rr; if (t.x >= 0) { closed++; hold += t.x - t.j; } else hold += last - t.j; }
    return { n: ts.length, closed, open: ts.length - closed, win: r2(win / ts.length * 100), avg: r2(sum / ts.length * 100), hold: r2(Math.max(1, hold / ts.length)), worst: r2(worst * 100), pnl: Math.round(pnl) };
  };
  const grStats = ts => Object.fromEntries(Object.keys(GR).map(k => [k, pst(ts.filter(t => t.gr === k))]));
  const liveT = trades.filter(t => t.live);
  const curveOf = ts => { const o = []; if (!ts.length) return o; const g0 = Math.min(...ts.map(t => t.j)); for (let g = g0; g <= last; g++) { let s = 0, n = 0; for (const t of ts) { if (t.j > g) continue; n++; s += netRet(t.p0, t.x >= 0 && t.x <= g ? t.px : A[t.c].c[g]); } if (n >= 3) o.push([dates[g], r2(s / n * 100)]); } return o; };
  const exitOf = (par, code, d, base) => { if (par.x === 1) { const g = gIdx.get(d), v = srPx(g, code, A[code].c[g]); return { tp: rt(v.tp, 1), sl: rt(v.sl, -1) }; } return { tp: par.tp ? rt(base * (1 + par.tp / 100), 1) : null, sl: par.sl ? rt(base * (1 - par.sl / 100), -1) : null }; };
  const ruleTxt = par => par.x === 2 ? "跌破月線賣" : par.x === 3 ? "掉出名單賣" : par.x === 4 ? `讓獲利奔跑・移動停損 ${par.tr}%` : "";
  const rowOf = t => { const close = A[t.c].c[last], px = t.x >= 0 ? t.px : close, ex = exitOf(t.par, t.c, t.d, t.p0); return { gr: t.gr, c: t.c, n: names.get(t.c) || "", d: t.d, b: dates[t.j], p0: r2(t.p0), amt: Math.round(PER * (t.f || 1)), x: t.x >= 0 ? dates[t.x] : "", px: r2(px), r: r2(netRet(t.p0, px) * 100), w: t.why || "", live: t.live, tp: ex.tp, sl: ex.sl, rule: ruleTxt(t.par), by: t.x < 0 ? addBiz(dates[t.j], t.par.H) : "", days: (t.x >= 0 ? t.x : last) - t.j }; };
  const pendRow = p => { const close = A[p.c].c[last], base = p.par.e === 1 ? rt(close * 0.985, -1) : close, ex = exitOf(p.par, p.c, p.d, base); return { gr: p.gr, c: p.c, n: names.get(p.c) || "", d: p.d, close, kind: p.par.e === 0 ? "開盤買" : p.par.e === 1 ? "掛單買" : "收盤確認買", buy: base, tp: ex.tp, sl: ex.sl, rule: ruleTxt(p.par), H: p.par.H }; };
  const paper = {
    from: liveFromD, per: PER, groups: GR, unfilled,
    stat: { all: { total: pst(trades), groups: grStats(trades) }, live: { total: pst(liveT), groups: grStats(liveT) } },
    curve: { all: curveOf(trades), live: curveOf(liveT) },
    open: trades.filter(t => t.x < 0).sort((a, b) => b.j - a.j).slice(0, 60).map(rowOf),
    recent: trades.filter(t => t.x >= 0).sort((a, b) => b.x - a.x).slice(0, 30).map(rowOf),
    pending: pend.map(pendRow),
    // 歷史建議追蹤：每一筆推薦（含回補）的結果，最新的在前面。st：open 持有中／sold 已賣出／pend 待買／miss 沒買到
    hist: [...trades.map(t => { const o = rowOf(t); return { ...o, st: t.x >= 0 ? "sold" : "open" }; }), ...pend.map(q => ({ gr: q.gr, c: q.c, n: names.get(q.c) || "", d: q.d, st: "pend", live: true })), ...miss.map(q => ({ gr: q.gr, c: q.c, n: names.get(q.c) || "", d: q.d, st: "miss", live: true }))]
      .sort((a, b) => a.d < b.d ? 1 : a.d > b.d ? -1 : 0).slice(0, 600)
  };
  // 8) 點股票看簡易資訊要畫的走勢：推薦股、持有中、待買的最近 80 個交易日收盤價（畫 60 天，多的 20 天用來算月線）
  const NPX = 80, pxCodes = new Set();
  for (const it of [...reco.items, ...(reco.alt ? reco.alt.items : []), ...reco.tiers.flatMap(T => T.items)]) pxCodes.add(it.c);
  for (const x of [...paper.open, ...paper.pending]) pxCodes.add(x.c);
  const px = {}; for (const c of pxCodes) if (A[c]) px[c] = A[c].c.slice(-NPX).map(v => v == null ? null : r2(v));
  // 9) 對照組：從「策略驗證」的起點開始，最佳策略實戰單子的累積報酬（總損益 ÷ 總投入，和策略驗證同一種算法），以及加權指數
  let cmp = null;
  if (opts.cmpFrom) {
    const gF = dates.findIndex(d => d >= opts.cmpFrom);
    if (gF >= 0) {
      const ls = wf[Lstar].lots.filter(l => l.g >= gF), oc = [];
      for (let g = gF; g <= last; g++) {
        let cost = 0, pnl = 0;
        for (const l of ls) { if (l.j > g) continue; const c0 = l.p0 * (1 + FEE), p = l.x >= 0 && l.x <= g ? l.px : A[l.c].c[g]; cost += c0; pnl += p * (1 - FEE - TAX) - c0; }
        if (cost) oc.push([dates[g], r2(pnl / cost * 100)]);
      }
      const mk = new Map(opts.mkt || []), mc = []; let b0 = null;
      for (let g = gF; g <= last; g++) { const v = mk.get(dates[g]); if (v == null) continue; if (b0 == null) b0 = v; mc.push([dates[g], r2((v / b0 - 1) * 100)]); }
      cmp = { from: dates[gF], oos: oc, oosStat: summ(ls), mkt: mc };
    }
  }
  // 6) 紀錄參數有沒有換（每天整份重算，但換了就留一筆）
  const log = prev && prev.log ? prev.log.slice() : [];
  const curLabel = now ? label(cfOf(now)) : "空手";
  if (!log.length || log[log.length - 1].cf !== curLabel) log.push({ d: asOf, cf: curLabel, L: Lstar });
  const out = {
    v: 1, updated: new Date().toISOString(), asOf, range: { from: dates[firstG], to: asOf, days: pickDays.length }, lookback: Lstar,
    config: reco.cfg, reco, top: topCfg, byL,
    oos: { ...byL[Lstar], curve, from: dates[tStart], mix, history: history.slice(-10) },
    log: log.slice(-40), grid: { combos: NS * NK * NP * NM * NR, strategies: SKEYS.map(s => STR[s]), rules: RULES.slice(1), mks: MKS.slice(0, NM), rots: ROTS.slice(0, NR), pool: Object.keys(A).length }, paper, cmp,
    sec: SECG[last] ? [...SECG[last].entries()].map(([k, v]) => ({ k, avg: r2(v.avg * 100), n: v.n, strong: v.strong })).sort((p, q) => q.avg - p.avg) : null,
    mkt: NM > 1 ? { d: dates[last], close: r2(MC[last]), ma20: r2(M20[last]), ma60: r2(M60[last]), up20: M20[last] >= M20[last - 5], ok: OK.map(a => a[last]) } : null, pxDates: dates.slice(-NPX), px
  };
  Object.defineProperty(out, "paperRecs", { value: recs, enumerable: false });   // 給下次夜間排程接著用，存成 paper.json
  return out;
}

if (typeof module !== "undefined") module.exports = { run, STR, ENTRY, RULES, MKS };
else if (typeof window !== "undefined") window.OPTIMIZER = { run, STR, ENTRY, RULES, MKS };
