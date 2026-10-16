/* 每日離峰預先篩選：由 GitHub Actions 在凌晨執行（見 .github/workflows/screener.yml）
   做的事：讀網站本身（index.html）裡的籌碼模型，替「內建大型股」逐檔算出支撐、壓力、位置評分，寫成 screener.json。
   會員打開篩選器時直接讀這份檔案，不用再各自消耗 FinMind 的免費查詢額度。
   模型的程式碼不是另外複製一份，而是直接從 index.html 擷取，所以網站和這支腳本永遠是同一套算法。
   用法：node scripts/screener_job.js   （環境變數 FINMIND_TOKEN 選填；LIMIT=3 只跑前 3 檔，測試用） */

const FM = "https://api.finmindtrade.com/api/v4/data";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 從 index.html 的原始碼裡，依名稱抓出一個 function（用大括號配對找結尾）
function grabFn(html, name) {
  const at = html.indexOf("\nfunction " + name + "(");
  if (at < 0) throw new Error("index.html 裡找不到 function " + name);
  let i = html.indexOf("{", html.indexOf(")", at)), depth = 0, j = i;
  for (; j < html.length; j++) {
    const ch = html[j];
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) break;
  }
  return html.slice(at + 1, j + 1);
}
function grabLine(html, re, what) {
  const m = html.match(re);
  if (!m) throw new Error("index.html 裡找不到 " + what);
  return m[0];
}
function loadModel(html) {
  const src = [
    grabLine(html, /^const BIN = [^\n]*$/m, "BIN"),
    grabLine(html, /^const fmt = [^\n]*$/m, "fmt"),
    grabLine(html, /^const pct = [^\n]*$/m, "pct"),
    grabLine(html, /^const spct = [^\n]*$/m, "spct"),
    grabLine(html, /^const state = [^\n]*$/m, "state"),
    ...["makeBins", "triCdf", "dayWeights", "runModel", "analyze", "superTrend", "stSummary", "verdictOf"].map(n => grabFn(html, n))
  ].join("\n");
  const api = new Function(src + "\nreturn { makeBins, runModel, analyze, superTrend, stSummary, verdictOf, state, BIN };")();
  const pool = JSON.parse(grabLine(html, /(?<=^const BIG_POOL = )\[[^\]]*\]/m, "BIG_POOL"));
  return { api, pool };
}

const dateBack = years => { const d = new Date(); d.setFullYear(d.getFullYear() - years); return d.toISOString().slice(0, 10); };

// 和網站的 fetchStock 一樣：抓價量、除權息還原、股本
async function fetchStock(getJson, code, years = 6) {
  const [px, dv, sh] = await Promise.all([
    getJson("TaiwanStockPrice", { data_id: code, start_date: dateBack(years) }),
    getJson("TaiwanStockDividendResult", { data_id: code, start_date: dateBack(years + 1) }).catch(() => []),
    getJson("TaiwanStockShareholding", { data_id: code, start_date: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10) }).catch(() => [])
  ]);
  const rows = px.filter(r => r.Trading_Volume > 0 && r.max > 0 && r.min > 0 && r.close > 0).sort((a, b) => a.date < b.date ? -1 : 1);
  if (rows.length < 60) throw new Error(`${code} 只有 ${rows.length} 天資料`);
  const ev = dv.filter(e => e.before_price > 0 && e.reference_price > 0)
    .map(e => ({ d: e.date, f: e.reference_price / e.before_price })).filter(e => e.f > 0 && e.f <= 2);
  const st = { code, shares: null, d: [], o: [], h: [], l: [], c: [], v: [] };
  for (const r of rows) {
    let f = 1;
    for (const e of ev) if (e.d > r.date) f *= e.f;
    st.d.push(r.date); st.o.push(r.open * f); st.h.push(r.max * f); st.l.push(r.min * f); st.c.push(r.close * f); st.v.push(r.Trading_Volume / 1000);
  }
  if (sh.length) { const n = +sh[sh.length - 1].NumberOfSharesIssued; if (n > 0) st.shares = n; }
  return st;
}

// 取 st 從某天（含）以後的部分（篩選用 6 年，策略實驗室用 12 年，兩邊共用同一次查詢）
function sliceFrom(st, from) {
  const k = st.d.findIndex(d => d >= from);
  if (k <= 0) return st;
  const o = { code: st.code, shares: st.shares };
  for (const f of ["d", "o", "h", "l", "c", "v"]) o[f] = st[f].slice(k);
  return o;
}
// 和網站的 scrMetrics 一樣
function metricsOf(M, st, name) {
  if (!st.shares) return null;
  const { api } = M, rows = st.d.map((d, i) => ({ d, o: st.o[i], h: st.h[i], l: st.l[i], c: st.c[i], v: st.v[i] * 1000 })), price = rows[rows.length - 1].c;
  let lo = price, hi = price;
  for (const r of rows) { if (r.l < lo) lo = r.l; if (r.h > hi) hi = r.h; }
  const { edges, centers } = api.makeBins(lo, hi, api.BIN), m = api.runModel(rows, edges, st.shares, api.state.decay), a = api.analyze(centers, m.p, price, api.state.gap, m.vol);
  const sf = api.superTrend(rows, api.state.stN, api.state.stM), S = api.stSummary(rows, sf, price);
  return { code: st.code, name, price, date: st.d[st.d.length - 1], cov: m.coverage, s1: a.sup[0] || null, r1: a.res[0] || null, bull: !!S && S.dir > 0, stDays: S ? S.days : 0, v: api.verdictOf({ a, price, m }) };
}

// 歷史價量壓縮格式（給網站的「策略實驗室」共用，省得每個人各自查詢）：日期存成「離第一天幾天」，價格取 3 位小數，成交量存張數
function packHistory(st, name) {
  const t0 = Date.parse(st.d[0]), rd = (a, k) => a.map(x => Math.round(x * k) / k);
  return { n: name, sh: st.shares, b: st.d[0], d: st.d.map(x => Math.round((Date.parse(x) - t0) / 864e5)), o: rd(st.o, 1000), h: rd(st.h, 1000), l: rd(st.l, 1000), c: rd(st.c, 1000), v: st.v.map(Math.round) };
}

// 主流程。old = 上一次的 screener.json 內容（抓不到的股票沿用舊資料）
async function buildData({ html, getJson, log = () => {}, old = null, limit = 0, gap = 700 }) {
  const M = loadModel(html);
  const pool = limit ? M.pool.slice(0, limit) : M.pool;
  let names = new Map();
  try { names = new Map((await getJson("TaiwanStockInfo", {})).map(r => [r.stock_id, r.stock_name])); } catch (e) { log("股票名稱清單讀取失敗：" + e.message); }
  const metrics = {}, failed = [], hist = { v: 1, updated: new Date().toISOString(), stocks: {} };
  for (const code of pool) {
    try {
      const st12 = await fetchStock(getJson, code, 12), st = sliceFrom(st12, dateBack(6));
      if (st.d.length < 60) throw new Error(`${code} 只有 ${st.d.length} 天資料`);
      const m = metricsOf(M, st, names.get(code) || (old && old.metrics[code] && old.metrics[code].name) || "");
      if (m) { metrics[code] = m; hist.stocks[code] = packHistory(st12, m.name); log(`${code} ${m.name} 位置評分 ${m.v.score}`); } else throw new Error("沒有股本資料");
    } catch (e) {
      failed.push(code); log(`${code} 失敗：${e.message}`);
      if (old && old.metrics && old.metrics[code]) metrics[code] = old.metrics[code];     // 這次抓不到就沿用上次的
      if (/limit|上限/i.test(e.message)) { log("查詢額度用完，停止；剩下的沿用上次資料。"); for (const c of pool) if (!(c in metrics) && old && old.metrics && old.metrics[c]) metrics[c] = old.metrics[c]; break; }
    }
    if (gap) await sleep(gap);
  }
  try {                                                                           // 加權指數：給策略實驗室的「相對強弱」「大盤多空」用
    const tx = (await getJson("TaiwanStockPrice", { data_id: "TAIEX", start_date: dateBack(12) })).filter(x => x.close > 0).sort((a, b) => a.date < b.date ? -1 : 1);
    if (tx.length > 300) { const t0 = Date.parse(tx[0].date); hist.index = { b: tx[0].date, d: tx.map(x => Math.round((Date.parse(x.date) - t0) / 864e5)), c: tx.map(x => Math.round(x.close * 100) / 100) }; }
  } catch (e) { log("加權指數讀取失敗：" + e.message); }
  const asOf = Object.values(metrics).reduce((mx, m) => m.date > mx ? m.date : mx, "");
  return { data: { v: 1, updated: new Date().toISOString(), asOf, pool: M.pool, failed, metrics }, hist };
}

async function main() {
  const fs = require("fs"), path = require("path");
  const root = path.join(__dirname, ".."), out = path.join(root, "screener.json");
  const token = process.env.FINMIND_TOKEN || "";
  const getJson = async (dataset, params, tries = 0) => {
    const q = new URLSearchParams({ dataset, ...params }); if (token) q.set("token", token);
    const res = await fetch(`${FM}?${q}`), j = await res.json().catch(() => ({}));
    if (j.status === 402 || res.status === 402 || /upper limit|limit/i.test(String(j.msg || ""))) {
      if (tries < 1) { console.log("FinMind 查詢額度已滿，等 15 分鐘後重試…"); await sleep(15 * 60e3); return getJson(dataset, params, tries + 1); }
      throw new Error("FinMind 查詢額度已用完 (limit)");
    }
    if (!res.ok || (j.status && j.status !== 200)) throw new Error(`FinMind ${dataset} 失敗：${j.msg || res.status}`);
    return j.data || [];
  };
  let old = null;
  try { old = JSON.parse(fs.readFileSync(out, "utf8")); } catch (e) {}
  const { data, hist } = await buildData({ html: fs.readFileSync(path.join(root, "index.html"), "utf8"), getJson, log: s => console.log(s), old, limit: +process.env.LIMIT || 0 });
  if (!Object.keys(data.metrics).length) { console.error("沒有任何股票算成功，不更新。"); process.exit(1); }
  fs.writeFileSync(path.join(root, "history.json"), JSON.stringify(hist));      // 不放進 main，由工作流程發佈到 data 分支
  console.log(`已寫入 history.json：${Object.keys(hist.stocks).length} 檔`);
  const round = (k, v) => typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v;
  const same = old && JSON.stringify(old.metrics) === JSON.stringify(JSON.parse(JSON.stringify(data.metrics, round)));
  if (same) { console.log("資料和上次相同（可能是休市日），不更新。"); return; }
  fs.writeFileSync(out, JSON.stringify(data, round));
  console.log(`已寫入 screener.json：${Object.keys(data.metrics).length} 檔，資料到 ${data.asOf}，失敗 ${data.failed.length} 檔。`);
}

if (typeof module !== "undefined") {
  module.exports = { buildData };
  if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
}
