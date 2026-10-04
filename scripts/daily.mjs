// 每日：外資買賣超、投信買賣超 ＋ 外資持股比率（參考用），上市＋上櫃普通股
// 上市：證交所 T86、MI_QFIIS；上櫃：櫃買中心三大法人買賣明細（dailyTrade，上櫃無持股比率）
// 每天的原始資料存成 data/daily/days/YYYY-MM-DD.json，再算出 data/daily/latest.json
// 漏跑的日子會在下一次執行時自動補回（往回檢查 10 天；初次執行往回補 50 天）
// 舊版存檔沒有外資買賣超（欄位 x）或上櫃資料（欄位 o），執行時會自動補抓
// 上櫃讀取失敗不影響上市；缺上櫃的日子下次執行會再補

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const HOSTS = ['www.twse.com.tw', 'wwwc.twse.com.tw'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const REQUEST_GAP_MS = 3000;          // 證交所會擋密集請求，每次間隔 3 秒
const BACKOFF_MS = [2000, 6000, 15000];
const WINDOW = 30;                    // 保留最近 30 個交易日
const INITIAL_LOOKBACK_DAYS = 50;     // 資料不足 30 天時往回補的日曆天數
const ROUTINE_LOOKBACK_DAYS = 10;     // 平常往回檢查漏跑的日曆天數
const MAX_FETCH_DATES = 40;           // 單次最多抓幾個日期
const MIN_STOCKS = 500;               // 少於這個檔數視為異常，不寫入
const MIN_TPEX_STOCKS = 300;          // 上櫃普通股少於這個檔數視為異常
const TPEX_URL = 'https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade';
const MAX_TPEX_BACKFILL = 35;         // 單次最多補幾天上櫃

const DIR = process.env.DATA_DIR || 'data/daily';
const DAYS_DIR = `${DIR}/days`;
const CLOSED_PATH = `${DIR}/closed.json`;
const LATEST_PATH = `${DIR}/latest.json`;

const STOCK_CODE = /^[1-9]\d{3}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const t = String(s).replace(/[,\s]/g, '');
  if (t === '' || t === '--' || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
const round2 = (x) => Math.round(x * 100) / 100;

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
          signal: AbortSignal.timeout(30000),
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

export function extractTable(json) {
  if (Array.isArray(json?.fields) && Array.isArray(json?.data)) return { fields: json.fields, rows: json.data };
  if (Array.isArray(json?.tables)) {
    for (const t of json.tables) {
      if (Array.isArray(t.fields) && Array.isArray(t.data) && t.data.length) return { fields: t.fields, rows: t.data };
    }
  }
  return null;
}
const findCol = (fields, ...keys) => fields.findIndex((f) => keys.every((k) => String(f).includes(k)));
const noData = (json) => String(json?.stat ?? '').includes('沒有符合');

// 解析外資持股表：回傳 { ratio: {code: 比率}, names: {code: 名稱} }
export function parseForeign(json) {
  const t = extractTable(json);
  if (!t) throw new Error('外資持股：找不到表格');
  const ci = findCol(t.fields, '證券代號');
  const ni = findCol(t.fields, '證券名稱');
  const ri = findCol(t.fields, '全體外資', '持股比率');
  if (ci < 0 || ri < 0) throw new Error(`外資持股：欄位對不上（${t.fields.join('、')}）`);
  const ratio = {}, names = {};
  for (const row of t.rows) {
    const code = String(row[ci]).trim();
    if (!STOCK_CODE.test(code)) continue;
    const r = num(row[ri]);
    if (r == null) continue;
    ratio[code] = r;
    if (ni >= 0) names[code] = String(row[ni]).trim();
  }
  return { ratio, names };
}

// 解析三大法人表：回傳 { x: {code: 外資買賣超張數}, t: {code: 投信買賣超張數}, names }
// 外資採「外陸資買賣超股數（不含外資自營商）」
export function parseInst(json) {
  const t = extractTable(json);
  if (!t) throw new Error('三大法人：找不到表格');
  const ci = findCol(t.fields, '證券代號');
  const ni = findCol(t.fields, '證券名稱');
  let xi = findCol(t.fields, '外陸資買賣超', '不含');
  if (xi < 0) xi = findCol(t.fields, '外陸資買賣超');
  const ti = findCol(t.fields, '投信買賣超');
  if (ci < 0 || ti < 0 || xi < 0) throw new Error(`三大法人：欄位對不上（${t.fields.join('、')}）`);
  const x = {}, net = {}, names = {};
  for (const row of t.rows) {
    const code = String(row[ci]).trim();
    if (!STOCK_CODE.test(code)) continue;
    const xv = num(row[xi]), tv = num(row[ti]);
    if (xv != null) x[code] = Math.round(xv / 1000); // 股 → 張
    if (tv != null) net[code] = Math.round(tv / 1000);
    if (ni >= 0) names[code] = String(row[ni]).trim();
  }
  return { x, t: net, names };
}

// 三大法人表（主要資料）。休市日證交所回「沒有符合條件的資料」
async function fetchInst(iso) {
  const d = compact(iso);
  const j = await fetchTwse(`/rwd/zh/fund/T86?date=${d}&selectType=ALLBUT0999&response=json`);
  if (j.stat !== 'OK') {
    if (noData(j)) return null;
    throw new Error(`三大法人 ${iso} 狀態異常：${j.stat}`);
  }
  if (j.date && String(j.date) !== d) throw new Error(`三大法人 ${iso} 回傳的是 ${j.date} 的資料（疑似快取）`);
  const inst = parseInst(j);
  const n = Object.keys(inst.x).length;
  if (n < MIN_STOCKS) throw new Error(`三大法人 ${iso} 只有 ${n} 檔，疑似不完整`);
  return inst;
}

// 櫃買三大法人表的欄位位置（2026-10 以 GitHub Actions 實測）：
// 0 代號、1 名稱、2～4 外資及陸資（不含外資自營商）買／賣／超、5～7 外資自營商、8～10 外資合計、
// 11～13 投信、14～16 自營商自行買賣、17～19 自營商避險、20～22 自營商合計、23 三大法人合計
const TPEX_COL = { code: 0, name: 1, foreign: 4, trust: 13, dealer: 22, total: 23 };

export function parseTpex(json, iso) {
  const tb = Array.isArray(json?.tables) ? json.tables[0] : null;
  if (!tb || !Array.isArray(tb.data)) throw new Error('上櫃三大法人：找不到表格');
  if (tb.data.length === 0) return null; // 休市
  const f = tb.fields || [];
  if (f.length < 24 || !String(f[TPEX_COL.foreign]).includes('買賣超') || !String(f[TPEX_COL.trust]).includes('買賣超')) {
    throw new Error(`上櫃三大法人：欄位對不上（${f.join('、')}）`);
  }
  const x = {}, t = {}, n = {};
  let checked = 0, bad = 0;
  for (const row of tb.data) {
    const code = String(row[TPEX_COL.code]).trim();
    if (!STOCK_CODE.test(code)) continue;
    const xv = num(row[TPEX_COL.foreign]), tv = num(row[TPEX_COL.trust]);
    const dv = num(row[TPEX_COL.dealer]), tot = num(row[TPEX_COL.total]);
    // 驗算：外資＋投信＋自營商＝三大法人合計，用來確認欄位位置沒有跑掉
    if ([xv, tv, dv, tot].every((v) => v != null)) { checked += 1; if (xv + tv + dv !== tot) bad += 1; }
    if (xv != null) x[code] = Math.round(xv / 1000);
    if (tv != null) t[code] = Math.round(tv / 1000);
    n[code] = String(row[TPEX_COL.name]).trim();
  }
  if (checked > 0 && bad / checked > 0.05) throw new Error(`上櫃三大法人 ${iso}：${bad}/${checked} 列驗算不合，欄位位置可能變了`);
  const count = Object.keys(x).length;
  if (count < MIN_TPEX_STOCKS) throw new Error(`上櫃三大法人 ${iso} 只有 ${count} 檔，疑似不完整`);
  return { x, t, n };
}

async function fetchTpex(iso) {
  const body = new URLSearchParams({ type: 'Daily', sect: 'AL', date: iso.replaceAll('-', '/'), id: '', response: 'json' });
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
          Referer: 'https://www.tpex.org.tw/zh-tw/mainboard/trading/major-institutional/detail/day.html',
        },
        body,
        signal: AbortSignal.timeout(45000),
      });
      if (res.status !== 200) { problems.push(`回應 ${res.status}`); continue; }
      const text = await res.text();
      let j;
      try { j = JSON.parse(text); } catch { problems.push(`內容不是 JSON（開頭：${text.slice(0, 60).replace(/\s+/g, ' ')}）`); continue; }
      if (String(j.stat).toLowerCase() !== 'ok') throw new Error(`上櫃三大法人 ${iso} 狀態異常：${j.stat}`);
      if (j.date && String(j.date) !== compact(iso)) throw new Error(`上櫃三大法人 ${iso} 回傳的是 ${j.date} 的資料（疑似快取）`);
      return parseTpex(j, iso);
    } catch (e) {
      if (e.message.startsWith('上櫃')) throw e; // 內容問題，重試沒有用
      problems.push(e.name === 'TimeoutError' ? '逾時' : (e.cause?.code || e.message));
    }
  }
  throw new Error(`上櫃三大法人 ${iso} 讀取失敗\n  原因：${problems.join('；')}`);
}

async function fetchDay(iso) {
  const inst = await fetchInst(iso);
  if (!inst) return { status: 'closed' };

  // 外資持股比率只是參考欄位：讀不到不影響當天存檔
  let foreign = { ratio: {}, names: {} };
  await sleep(REQUEST_GAP_MS);
  try {
    const d = compact(iso);
    const q = await fetchTwse(`/rwd/zh/fund/MI_QFIIS?date=${d}&selectType=ALLBUT0999&response=json`);
    if (q.stat !== 'OK') throw new Error(`狀態異常：${q.stat}`);
    if (q.date && String(q.date) !== d) throw new Error(`回傳的是 ${q.date} 的資料（疑似快取）`);
    foreign = parseForeign(q);
  } catch (e) {
    console.log(`::warning::${iso} 外資持股比率讀取失敗（不影響連買計算）：${e.message}`);
  }
  return { status: 'ok', day: { date: iso, x: inst.x, t: inst.t, f: foreign.ratio, n: { ...foreign.names, ...inst.names } } };
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}
async function listDays() {
  try {
    return (await readdir(DAYS_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort();
  } catch { return []; }
}

// 連續為正的次數
export function positiveStreak(series) {
  let k = 0;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (!(series[i] > 0)) break;
    k += 1;
  }
  return k;
}

export function buildLatest(days) {
  const last = days[days.length - 1];
  const L = days.length - 1;
  const rows = [];
  const sumLast = (arr, k) => arr.slice(arr.length - k).reduce((a, b) => a + b, 0);

  // 上市：某天缺外資資料（x 不存在）時視為 null，連買在那天中斷
  const twse = {
    m: '上市',
    codes: new Set([...Object.keys(last.x || {}), ...Object.keys(last.t)]),
    x: (d, c) => (d.x ? (d.x[c] ?? 0) : null),
    t: (d, c) => d.t[c] ?? 0,
    f: (d, c) => (d.f ? d.f[c] ?? null : null),
    n: (d, c) => d.n?.[c],
  };
  // 上櫃：某天缺上櫃資料（o 不存在）時視為 null；上櫃沒有持股比率
  const tpex = {
    m: '上櫃',
    codes: new Set(last.o ? Object.keys(last.o.x) : []),
    x: (d, c) => (d.o ? (d.o.x[c] ?? 0) : null),
    t: (d, c) => (d.o ? (d.o.t[c] ?? 0) : null),
    f: () => null,
    n: (d, c) => d.o?.n?.[c],
  };
  for (const mk of [twse, tpex]) {
    for (const c of mk.codes) {
      const xs = days.map((d) => mk.x(d, c));
      const ts = days.map((d) => mk.t(d, c));
      const fs = days.map((d) => mk.f(d, c));
      const xS = positiveStreak(xs);
      const itS = positiveStreak(ts);
      if (xS < 1 && itS < 1) continue;
      const fr = fs[L];
      rows.push({
        c,
        n: mk.n(last, c) || days.map((d) => mk.n(d, c)).findLast(Boolean) || '',
        m: mk.m,
        x: xs[L],
        xS,
        xSum: sumLast(xs, xS),
        it: ts[L],
        itS,
        itSum: sumLast(ts, itS),
        fr,
        frD1: fr != null && fs[L - 1] != null ? round2(fr - fs[L - 1]) : null,
      });
    }
  }
  rows.sort((a, b) => b.xS - a.xS || b.itS - a.itS || a.c.localeCompare(b.c));
  return {
    asOf: last.date,
    days: days.length,
    firstDate: days[0].date,
    generatedAt: new Date().toISOString(),
    maxStreak: days.length,
    tpexDays: days.filter((d) => d.o).length,
    rows,
  };
}

export async function main() {
  await mkdir(DAYS_DIR, { recursive: true });
  const today = taipeiToday();
  const have = new Set(await listDays());
  const closed = new Set(await readJson(CLOSED_PATH, []));

  const lookback = have.size < WINDOW ? INITIAL_LOOKBACK_DAYS : ROUTINE_LOOKBACK_DAYS;
  const targets = [];
  for (let i = lookback; i >= 0; i -= 1) {
    const d = addDays(today, -i);
    const w = weekday(d);
    if (w === 0 || w === 6 || have.has(d) || closed.has(d)) continue;
    targets.push(d);
  }
  const todo = targets.slice(-MAX_FETCH_DATES);
  console.log(`今天（台北）${today}；已存 ${have.size} 個交易日；這次要檢查 ${todo.length} 個日期`);

  let added = 0, failures = 0, newClosed = 0;
  for (const [i, d] of todo.entries()) {
    if (i > 0) await sleep(REQUEST_GAP_MS);
    try {
      const r = await fetchDay(d);
      if (r.status === 'closed') {
        if (d < today) { closed.add(d); newClosed += 1; console.log(`${d}：休市`); }
        else console.log(`${d}：今天的資料尚未公布`);
        continue;
      }
      await writeFile(`${DAYS_DIR}/${d}.json`, JSON.stringify(r.day));
      have.add(d);
      added += 1;
      console.log(`${d}：外資 ${Object.keys(r.day.f).length} 檔、投信 ${Object.keys(r.day.t).length} 檔`);
    } catch (e) {
      failures += 1;
      console.log(`::warning::${d} ${e.message}`);
    }
  }

  // 舊版存檔沒有外資買賣超：重抓三大法人表補上（只會發生一次）
  let migrated = 0;
  for (const d of [...have].sort().slice(-WINDOW)) {
    const path = `${DAYS_DIR}/${d}.json`;
    const day = JSON.parse(await readFile(path, 'utf8'));
    if (day.x) continue;
    await sleep(REQUEST_GAP_MS);
    try {
      const inst = await fetchInst(d);
      if (!inst) { console.log(`::warning::${d} 補外資資料時證交所回無資料，略過`); continue; }
      day.x = inst.x;
      day.t = inst.t;
      await writeFile(path, JSON.stringify(day));
      migrated += 1;
    } catch (e) {
      console.log(`::warning::${d} 補外資資料失敗，下次再試：${e.message}`);
    }
  }
  if (migrated) console.log(`已為 ${migrated} 個舊交易日補上外資買賣超`);

  // 上櫃：沒有上櫃資料的交易日（新的一天、舊版存檔、上次失敗）都在這裡補，新的日期優先
  let tpexAdded = 0, tpexFails = 0;
  const needTpex = [];
  for (const d of [...have].sort().slice(-WINDOW).reverse()) {
    const day = JSON.parse(await readFile(`${DAYS_DIR}/${d}.json`, 'utf8'));
    if (!day.o) needTpex.push(d);
  }
  for (const d of needTpex.slice(0, MAX_TPEX_BACKFILL)) {
    await sleep(REQUEST_GAP_MS);
    try {
      const o = await fetchTpex(d);
      if (!o) { console.log(`::warning::${d} 證交所有開盤但櫃買回無資料，略過`); continue; }
      const path = `${DAYS_DIR}/${d}.json`;
      const day = JSON.parse(await readFile(path, 'utf8'));
      day.o = o;
      await writeFile(path, JSON.stringify(day));
      tpexAdded += 1;
    } catch (e) {
      tpexFails += 1;
      console.log(`::warning::${d} ${e.message}`);
      if (tpexFails >= 3) { console.log('::warning::上櫃連續失敗 3 次，這次先停止，下次執行再補'); break; }
    }
  }
  if (tpexAdded) console.log(`上櫃：補上 ${tpexAdded} 個交易日`);
  migrated += tpexAdded;

  // 只保留最近 WINDOW 個交易日
  const all = [...have].sort();
  for (const d of all.slice(0, Math.max(0, all.length - WINDOW))) {
    await unlink(`${DAYS_DIR}/${d}.json`).catch(() => {});
  }
  const keep = all.slice(-WINDOW);

  if (newClosed > 0) {
    const cutoff = addDays(today, -120);
    await writeFile(CLOSED_PATH, JSON.stringify([...closed].filter((d) => d >= cutoff).sort()));
  }

  const latestExists = await readJson(LATEST_PATH, null);
  if (keep.length === 0) {
    console.log('::error::還沒有任何一天的資料');
    process.exitCode = 1;
    return;
  }
  if (added > 0 || migrated > 0 || !latestExists) {
    const days = [];
    for (const d of keep) days.push(JSON.parse(await readFile(`${DAYS_DIR}/${d}.json`, 'utf8')));
    const latest = buildLatest(days);
    await writeFile(LATEST_PATH, JSON.stringify(latest));
    const xn = latest.rows.filter((r) => r.xS >= 1).length;
    const it = latest.rows.filter((r) => r.itS >= 1).length;
    const otc = latest.rows.filter((r) => r.m === '上櫃').length;
    console.log(`完成：資料日 ${latest.asOf}，共 ${keep.length} 個交易日（上櫃 ${latest.tpexDays} 天）；外資連買 ${xn} 檔、投信連買 ${it} 檔，其中上櫃 ${otc} 檔`);
  } else {
    console.log('沒有新的交易日資料，latest.json 不變');
  }
  if (failures > 0 && added === 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.log(`::error::${e.stack || e.message}`); process.exitCode = 1; });
}
