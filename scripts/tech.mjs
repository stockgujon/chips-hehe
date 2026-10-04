// 技術訊號：每日收盤行情，上市＋上櫃普通股
// 上市：證交所 MI_INDEX；上櫃：櫃買中心上櫃股票每日收盤行情（afterTrading/otc）
// 上櫃讀取失敗不影響上市；缺上櫃的日子（欄位 o）下次執行會再補
// 每天的開高低收量存成 data/tech/days/YYYY-MM-DD.json，再算出 data/tech/latest.json
// 三組訊號：帶量突破、多頭回測、盤整突破。籌碼欄位由網頁讀每日籌碼資料合併，這裡不重複抓
// 與 daily.mjs / weekly.mjs 完全獨立，不讀寫它們的檔案

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const HOSTS = ['www.twse.com.tw', 'wwwc.twse.com.tw'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const REQUEST_GAP_MS = 3500;          // 比其他專案更慢，避免被擋
const BACKOFF_MS = [3000, 10000, 20000];
const MAX_CONSECUTIVE_FAILS = 3;      // 斷路器：連續失敗幾個日期就停止這次執行
const WINDOW = 80;                    // 保留最近 80 個交易日（60 日線需要 60 天）
const INITIAL_LOOKBACK_DAYS = 125;    // 資料不足時往回補的日曆天數（約 85 個交易日）
const ROUTINE_LOOKBACK_DAYS = 10;
const MAX_FETCH_DATES = 95;
const MIN_STOCKS = 500;
const MIN_TPEX_STOCKS = 300;
const TPEX_URL = 'https://www.tpex.org.tw/www/zh-tw/afterTrading/otc';
const MAX_TPEX_BACKFILL = 85;     // 單次最多補幾天上櫃（第一次需要約 80 天）

// 訊號參數（要調整門檻改這裡）
const P = {
  minAvgVol: 500,        // 20 日均量至少幾張
  maxBias: 10,           // 收盤離 20 日線最多幾 %
  volRatio: 1.5,         // 量比門檻（當日量 ÷ 前 20 日均量）
  pullbackBand: 0.02,    // 回測：最低價在 20 日線上方 2% 以內
  pullbackAbove: 0.03,   // 回測：前 5 日收盤曾高於 20 日線 3% 以上
  squeezeSpread: 0.02,   // 糾結：前一日 5/10/20 日線最大差距 2% 以內
  exDivDays: 20,         // 近幾天內除權息要標示
};

const DIR = process.env.DATA_DIR || 'data/tech';
const DAYS_DIR = `${DIR}/days`;
const CLOSED_PATH = `${DIR}/closed.json`;
const LATEST_PATH = `${DIR}/latest.json`;

const STOCK_CODE = /^[1-9]\d{3}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

export function taipeiToday(now = Date.now()) {
  return new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
}
export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekday = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay();
const compact = (iso) => iso.replaceAll('-', '');

export function num(s) {
  if (s == null) return null;
  const t = String(s).replace(/<[^>]*>/g, '').replace(/[,\s]/g, '');
  if (t === '' || /^-+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

async function fetchTwse(pathAndQuery) {
  const problems = [];
  for (let round = 0; round <= BACKOFF_MS.length; round += 1) {
    if (round > 0) await sleep(BACKOFF_MS[round - 1]);
    for (const host of HOSTS) {
      const url = `https://${host}${pathAndQuery}`;
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*' },
          redirect: 'manual',
          signal: AbortSignal.timeout(45000),
        });
        if (res.status !== 200) { problems.push(`${host} 回應 ${res.status}`); continue; }
        const text = await res.text();
        try { return JSON.parse(text); }
        catch { problems.push(`${host} 內容不是 JSON（開頭：${text.slice(0, 60).replace(/\s+/g, ' ')}）`); }
      } catch (e) {
        problems.push(`${host} ${e.name === 'TimeoutError' ? '逾時' : (e.cause?.code || e.message)}`);
      }
    }
  }
  throw new Error(`讀取失敗：${pathAndQuery}\n  原因：${problems.join('；')}`);
}

const findCol = (fields, ...keys) => fields.findIndex((f) => keys.every((k) => String(f).includes(k)));
const noData = (json) => String(json?.stat ?? '').includes('沒有符合');

// MI_INDEX 有很多張表，找有「證券代號」和「收盤價」的那張
export function findQuoteTable(json) {
  const tables = Array.isArray(json?.tables) ? json.tables : [];
  if (Array.isArray(json?.fields) && Array.isArray(json?.data)) tables.push({ fields: json.fields, data: json.data });
  for (const t of tables) {
    if (!Array.isArray(t?.fields) || !Array.isArray(t?.data) || !t.data.length) continue;
    if (findCol(t.fields, '證券代號') >= 0 && findCol(t.fields, '收盤價') >= 0) return t;
  }
  return null;
}

// 回傳 { s: {code: [開, 高, 低, 收, 量(張)]}, n: {code: 名稱} }
export function parseQuotes(json) {
  const t = findQuoteTable(json);
  if (!t) throw new Error('每日收盤行情：找不到含「證券代號、收盤價」的表格');
  const f = t.fields;
  const ci = findCol(f, '證券代號'), ni = findCol(f, '證券名稱');
  const oi = findCol(f, '開盤價'), hi = findCol(f, '最高價'), li = findCol(f, '最低價'), xi = findCol(f, '收盤價');
  const vi = findCol(f, '成交股數');
  if ([oi, hi, li, xi, vi].some((i) => i < 0)) throw new Error(`每日收盤行情：欄位對不上（${f.join('、')}）`);
  const s = {}, n = {};
  for (const row of t.data) {
    const code = String(row[ci]).trim();
    if (!STOCK_CODE.test(code)) continue;
    const o = num(row[oi]), h = num(row[hi]), l = num(row[li]), c = num(row[xi]), v = num(row[vi]);
    if (c == null || v == null) continue; // 當天沒成交
    s[code] = [o ?? c, h ?? c, l ?? c, c, Math.round(v / 1000)];
    if (ni >= 0) n[code] = String(row[ni]).trim();
  }
  return { s, n };
}

// 上櫃收盤行情 → { s: {code: [開, 高, 低, 收, 量(張)]}, n }；休市回 null
export function parseTpexQuotes(json, iso) {
  const tb = Array.isArray(json?.tables) ? json.tables[0] : null;
  if (!tb || !Array.isArray(tb.data)) throw new Error('上櫃收盤行情：找不到表格');
  if (tb.data.length === 0) return null;
  const f = (tb.fields || []).map((x) => String(x).replace(/\s+/g, ''));
  const ci = findCol(f, '代號'), ni = findCol(f, '名稱');
  const oi = findCol(f, '開盤'), hi = findCol(f, '最高'), li = findCol(f, '最低'), xi = findCol(f, '收盤');
  const vi = findCol(f, '成交股數');
  if ([ci, oi, hi, li, xi, vi].some((i) => i < 0)) throw new Error(`上櫃收盤行情：欄位對不上（${f.join('、')}）`);
  const s = {}, n = {};
  for (const row of tb.data) {
    const code = String(row[ci]).trim();
    if (!STOCK_CODE.test(code)) continue;
    const o = num(row[oi]), h = num(row[hi]), l = num(row[li]), c = num(row[xi]), v = num(row[vi]);
    if (c == null || v == null) continue;
    s[code] = [o ?? c, h ?? c, l ?? c, c, Math.round(v / 1000)];
    if (ni >= 0) n[code] = String(row[ni]).trim();
  }
  const count = Object.keys(s).length;
  if (count < MIN_TPEX_STOCKS) throw new Error(`上櫃收盤行情 ${iso} 只有 ${count} 檔，疑似不完整`);
  return { s, n };
}

async function fetchTpexQuotes(iso) {
  const body = new URLSearchParams({ date: iso.replaceAll('-', '/'), type: 'EW', id: '', response: 'json' });
  const problems = [];
  for (let round = 0; round <= BACKOFF_MS.length; round += 1) {
    if (round > 0) await sleep(BACKOFF_MS[round - 1]);
    try {
      const res = await fetch(TPEX_URL, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Origin: 'https://www.tpex.org.tw',
          Referer: 'https://www.tpex.org.tw/zh-tw/mainboard/trading/info/pricing.html',
        },
        body,
        signal: AbortSignal.timeout(45000),
      });
      if (res.status !== 200) { problems.push(`回應 ${res.status}`); continue; }
      const text = await res.text();
      let j;
      try { j = JSON.parse(text); } catch { problems.push(`內容不是 JSON（開頭：${text.slice(0, 60).replace(/\s+/g, ' ')}）`); continue; }
      if (String(j.stat).toLowerCase() !== 'ok') throw new Error(`上櫃收盤行情 ${iso} 狀態異常：${j.stat}`);
      if (j.date && String(j.date) !== compact(iso)) throw new Error(`上櫃收盤行情 ${iso} 回傳的是 ${j.date} 的資料（疑似快取）`);
      return parseTpexQuotes(j, iso);
    } catch (e) {
      if (e.message.startsWith('上櫃')) throw e;
      problems.push(e.name === 'TimeoutError' ? '逾時' : (e.cause?.code || e.message));
    }
  }
  throw new Error(`上櫃收盤行情 ${iso} 讀取失敗\n  原因：${problems.join('；')}`);
}

async function fetchDay(iso) {
  const d = compact(iso);
  const j = await fetchTwse(`/rwd/zh/afterTrading/MI_INDEX?date=${d}&type=ALLBUT0999&response=json`);
  if (j.stat !== 'OK') {
    if (noData(j)) return { status: 'closed' };
    throw new Error(`每日收盤行情 ${iso} 狀態異常：${j.stat}`);
  }
  const jd = j.date ?? j.params?.date;
  if (jd && String(jd) !== d) throw new Error(`每日收盤行情 ${iso} 回傳的是 ${jd} 的資料（疑似快取）`);
  const q = parseQuotes(j);
  const count = Object.keys(q.s).length;
  if (count < MIN_STOCKS) throw new Error(`每日收盤行情 ${iso} 只有 ${count} 檔，疑似不完整`);
  return { status: 'ok', day: { date: iso, s: q.s, n: q.n } };
}

// 民國或西元日期 → YYYY-MM-DD
export function parseAnyDate(s) {
  const t = String(s ?? '').trim();
  let m = t.match(/^(\d{2,3})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m && Number(m[1]) < 1000) return `${Number(m[1]) + 1911}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = t.match(/^(\d{4})\D?(\d{1,2})\D?(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return null;
}

// 近期除權息清單（參考用，失敗不影響訊號）→ {code: 最近一次除權息日}
async function fetchExDiv(fromIso, toIso) {
  const j = await fetchTwse(`/rwd/zh/exRight/TWT49U?startDate=${compact(fromIso)}&endDate=${compact(toIso)}&response=json`);
  if (j.stat !== 'OK') {
    if (noData(j)) return {};
    throw new Error(`狀態異常：${j.stat}`);
  }
  const tables = Array.isArray(j.tables) ? j.tables : [{ fields: j.fields, data: j.data }];
  const out = {};
  for (const t of tables) {
    if (!Array.isArray(t?.fields) || !Array.isArray(t?.data)) continue;
    const di = findCol(t.fields, '日期'), ci = findCol(t.fields, '代號');
    if (di < 0 || ci < 0) continue;
    for (const row of t.data) {
      const code = String(row[ci]).trim(), date = parseAnyDate(row[di]);
      if (STOCK_CODE.test(code) && date && (!out[code] || date > out[code])) out[code] = date;
    }
  }
  return out;
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}
async function listDays() {
  try {
    return (await readdir(DAYS_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort();
  } catch { return []; }
}

const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
// series 結尾 n 筆的平均；end 為不含的結尾索引（預設到最後）
function sma(series, n, end = series.length) {
  if (end < n) return null;
  const part = series.slice(end - n, end);
  if (part.some((v) => v == null)) return null;
  return avg(part);
}
// Wilder RSI
export function rsi(closes, n = 14) {
  if (closes.length < n + 1 || closes.some((v) => v == null)) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i += 1) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  for (let i = n + 1; i < closes.length; i += 1) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

// 單一股票：bars 為依日期排序的 [開, 高, 低, 收, 量]（缺資料為 null）
export function evaluate(bars) {
  const L = bars.length - 1;
  const today = bars[L];
  if (!today || bars.length < 22) return null;
  // 只用「連續有成交」的最後一段，避免中間停牌造成誤判
  let start = L;
  while (start > 0 && bars[start - 1]) start -= 1;
  const b = bars.slice(start);
  const N = b.length - 1;
  if (N < 21) return null;
  const O = b.map((x) => x[0]), H = b.map((x) => x[1]), Lo = b.map((x) => x[2]), C = b.map((x) => x[3]), V = b.map((x) => x[4]);
  const c = C[N], o = O[N], prev = C[N - 1];

  const ma5 = sma(C, 5), ma10 = sma(C, 10), ma20 = sma(C, 20), ma60 = sma(C, 60);
  const avgVol20 = sma(V, 20, N);            // 前 20 日均量（不含今天）
  const volRatio = avgVol20 ? V[N] / avgVol20 : null;
  const bias20 = ma20 ? (c / ma20 - 1) * 100 : null;
  const high20 = Math.max(...H.slice(N - 20, N)); // 前 20 日最高價（不含今天）
  const r = rsi(C.slice(-60));

  const liquid = avgVol20 != null && avgVol20 >= P.minAvgVol;
  const notStretched = bias20 != null && bias20 <= P.maxBias;
  const sig = [];
  if (liquid && notStretched) {
    // 帶量突破：收盤創 20 日新高 ＋ 量比達標 ＋ 站上月線
    if (c > high20 && volRatio >= P.volRatio && c > ma20) sig.push('brk');

    // 多頭回測：5 > 20 > 60 日線、月線上揚；前 5 日曾明顯站在月線上方（高出 3% 以上），
    // 今天最低價回到月線附近、收盤守住月線
    const ma20Prev5 = sma(C, 20, N - 4);
    const wasAbove = Math.max(...C.slice(N - 5, N)) >= ma20 * (1 + P.pullbackAbove);
    if (ma60 != null && ma5 > ma20 && ma20 > ma60 && ma20Prev5 != null && ma20 > ma20Prev5 && wasAbove
      && Lo[N] <= ma20 * (1 + P.pullbackBand) && c >= ma20) sig.push('pull');

    // 盤整突破：前一日 5/10/20 日線糾結，今天收紅、漲、站上三條線、帶量
    const p5 = sma(C, 5, N), p10 = sma(C, 10, N), p20 = sma(C, 20, N);
    if (p5 != null && p10 != null && p20 != null) {
      const spread = (Math.max(p5, p10, p20) - Math.min(p5, p10, p20)) / Math.min(p5, p10, p20);
      if (spread <= P.squeezeSpread && c > o && c > prev && c > Math.max(ma5, ma10, ma20) && volRatio >= P.volRatio) sig.push('sqz');
    }
  }
  return {
    p: round(c), chg: round((c / prev - 1) * 100), v: V[N], av20: avgVol20 != null ? Math.round(avgVol20) : null,
    vr: round(volRatio), b20: round(bias20), rsi: round(r, 1),
    ma5: round(ma5), ma20: round(ma20), ma60: round(ma60), sig,
  };
}

export function buildLatest(days, exDiv) {
  const last = days[days.length - 1];
  const exCut = days[Math.max(0, days.length - P.exDivDays)].date;
  const rows = [];
  for (const code of Object.keys(last.s)) {
    const e = evaluate(days.map((d) => d.s[code] ?? null));
    if (!e || !e.sig.length) continue;
    const ex = exDiv?.[code] && exDiv[code] >= exCut && exDiv[code] <= last.date ? exDiv[code] : null;
    rows.push({ c: code, n: last.n[code] || '', m: '上市', ...e, ex });
  }
  // 上櫃：缺上櫃資料的日子視為 null，evaluate 只會用最後一段連續有資料的期間；上櫃沒有除權息清單
  if (last.o) {
    for (const code of Object.keys(last.o.s)) {
      const e = evaluate(days.map((d) => (d.o ? d.o.s[code] ?? null : null)));
      if (!e || !e.sig.length) continue;
      rows.push({ c: code, n: last.o.n[code] || '', m: '上櫃', ...e, ex: null });
    }
  }
  rows.sort((a, b) => b.sig.length - a.sig.length || (b.vr ?? 0) - (a.vr ?? 0));
  return {
    asOf: last.date, days: days.length, firstDate: days[0].date, generatedAt: new Date().toISOString(),
    ma60Ready: days.length >= 60, tpexDays: days.filter((d) => d.o).length, exDivOk: exDiv != null, params: P, rows,
  };
}

export async function main() {
  await mkdir(DAYS_DIR, { recursive: true });
  const today = taipeiToday();
  const have = new Set(await listDays());
  const closed = new Set(await readJson(CLOSED_PATH, []));

  const lookback = have.size < 60 ? INITIAL_LOOKBACK_DAYS : ROUTINE_LOOKBACK_DAYS;
  const targets = [];
  for (let i = lookback; i >= 0; i -= 1) {
    const d = addDays(today, -i);
    const w = weekday(d);
    if (w === 0 || w === 6 || have.has(d) || closed.has(d)) continue;
    targets.push(d);
  }
  // 新的日期優先，確保最近的資料先到手
  const todo = targets.slice(-MAX_FETCH_DATES).reverse();
  console.log(`今天（台北）${today}；已存 ${have.size} 個交易日；這次要檢查 ${todo.length} 個日期`);

  let added = 0, failures = 0, streakFails = 0, newClosed = 0, requests = 0;
  for (const d of todo) {
    if (requests > 0) await sleep(REQUEST_GAP_MS);
    requests += 1;
    try {
      const r = await fetchDay(d);
      streakFails = 0;
      if (r.status === 'closed') {
        if (d < today) { closed.add(d); newClosed += 1; console.log(`${d}：休市`); }
        else console.log(`${d}：今天的資料尚未公布`);
        continue;
      }
      await writeFile(`${DAYS_DIR}/${d}.json`, JSON.stringify(r.day));
      have.add(d);
      added += 1;
      console.log(`${d}：${Object.keys(r.day.s).length} 檔`);
    } catch (e) {
      failures += 1; streakFails += 1;
      console.log(`::warning::${d} ${e.message}`);
      if (streakFails >= MAX_CONSECUTIVE_FAILS) {
        console.log(`::warning::連續 ${streakFails} 次失敗，停止這次抓取，已抓到的資料照常保存，下次排程會接著補`);
        break;
      }
    }
  }
  console.log(`本次請求 ${requests} 次`);

  // 上櫃：沒有上櫃資料的交易日都在這裡補，新的日期優先
  let tpexAdded = 0, tpexFails = 0;
  const needTpex = [];
  for (const d of [...have].sort().slice(-WINDOW).reverse()) {
    const day = JSON.parse(await readFile(`${DAYS_DIR}/${d}.json`, 'utf8'));
    if (!day.o) needTpex.push(d);
  }
  for (const d of needTpex.slice(0, MAX_TPEX_BACKFILL)) {
    await sleep(REQUEST_GAP_MS);
    try {
      const o = await fetchTpexQuotes(d);
      tpexFails = 0;
      if (!o) { console.log(`::warning::${d} 證交所有開盤但櫃買回無資料，略過`); continue; }
      const path = `${DAYS_DIR}/${d}.json`;
      const day = JSON.parse(await readFile(path, 'utf8'));
      day.o = o;
      await writeFile(path, JSON.stringify(day));
      tpexAdded += 1;
    } catch (e) {
      tpexFails += 1;
      console.log(`::warning::${d} ${e.message}`);
      if (tpexFails >= MAX_CONSECUTIVE_FAILS) { console.log('::warning::上櫃連續失敗 3 次，這次先停止，下次執行再補'); break; }
    }
  }
  if (tpexAdded) console.log(`上櫃：補上 ${tpexAdded} 個交易日`);
  added += tpexAdded;

  const all = [...have].sort();
  for (const d of all.slice(0, Math.max(0, all.length - WINDOW))) {
    await unlink(`${DAYS_DIR}/${d}.json`).catch(() => {});
  }
  const keep = all.slice(-WINDOW);
  if (newClosed > 0) {
    const cutoff = addDays(today, -200);
    await writeFile(CLOSED_PATH, JSON.stringify([...closed].filter((d) => d >= cutoff).sort()));
  }

  if (keep.length === 0) { console.log('::error::還沒有任何一天的資料'); process.exitCode = 1; return; }
  const latestExists = await readJson(LATEST_PATH, null);
  if (added > 0 || !latestExists) {
    const days = [];
    for (const d of keep) days.push(JSON.parse(await readFile(`${DAYS_DIR}/${d}.json`, 'utf8')));
    let exDiv = null;
    await sleep(REQUEST_GAP_MS);
    try {
      exDiv = await fetchExDiv(days[Math.max(0, days.length - P.exDivDays)].date, days[days.length - 1].date);
      console.log(`近期除權息：${Object.keys(exDiv).length} 檔`);
    } catch (e) {
      console.log(`::warning::除權息清單讀取失敗（不影響訊號）：${e.message}`);
    }
    const latest = buildLatest(days, exDiv);
    await writeFile(LATEST_PATH, JSON.stringify(latest));
    const cnt = (k) => latest.rows.filter((r) => r.sig.includes(k)).length;
    console.log(`完成：資料日 ${latest.asOf}，共 ${keep.length} 個交易日（上櫃 ${latest.tpexDays} 天）；帶量突破 ${cnt('brk')} 檔、多頭回測 ${cnt('pull')} 檔、盤整突破 ${cnt('sqz')} 檔`);
    if (!latest.ma60Ready) console.log('60 日線資料還不足，「多頭回測」暫時不會有結果，下次執行會繼續補');
  } else {
    console.log('沒有新的交易日資料，latest.json 不變');
  }
  if (failures > 0 && added === 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.log(`::error::${e.stack || e.message}`); process.exitCode = 1; });
}
