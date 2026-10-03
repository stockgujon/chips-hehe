// 每週：集保戶股權分散表（集保結算所開放資料），上市＋上櫃普通股
// 開放資料只給「最新一週」，所以每週存一份快照 data/weekly/snaps/YYYY-MM-DD.json 累積歷史
// 400 張以上 = 持股分級 12～15；1000 張以上 = 分級 15（1,000,001 股以上）

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const TDCC_URLS = [
  'https://opendata.tdcc.com.tw/getOD.ashx?id=1-5',
  'https://smart.tdcc.com.tw/opendata/getOD.ashx?id=1-5',
];
const TWSE_NAMES = 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';
const TPEX_NAMES = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const BACKOFF_MS = [3000, 10000, 30000];
const KEEP_WEEKS = 60;
const MIN_STOCKS = 1000;
const MAX_GAP_DAYS = 10; // 兩份快照相隔超過 10 天，視為中間缺了一週，連升中斷

const DIR = process.env.DATA_DIR || 'data/weekly';
const SNAP_DIR = `${DIR}/snaps`;
const LATEST_PATH = `${DIR}/latest.json`;

const STOCK_CODE = /^[1-9]\d{3}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (x) => Math.round(x * 100) / 100;
const daysBetween = (a, b) => (new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400e3;

async function fetchText(urls, label) {
  const problems = [];
  for (let round = 0; round <= BACKOFF_MS.length; round += 1) {
    if (round > 0) await sleep(BACKOFF_MS[round - 1]);
    for (const url of urls) {
      const host = new URL(url).host;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
        if (res.status !== 200) { problems.push(`${host} 回應 ${res.status}`); continue; }
        return await res.text();
      } catch (e) {
        problems.push(`${host} ${e.name === 'TimeoutError' ? '逾時' : (e.cause?.code || e.message)}`);
      }
    }
  }
  throw new Error(`${label}讀取失敗\n  原因：${problems.join('；')}`);
}

const splitCsv = (line) => line.split(',').map((s) => s.trim().replace(/^"|"$/g, '').trim());

// 解析股權分散表 CSV → { date, stocks: {code: [n400, p400, n1000, p1000, total]} }
export function parseTdcc(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error('股權分散表：內容是空的');
  const head = splitCsv(lines[0]);
  const col = (k, fb) => { const i = head.findIndex((h) => h.includes(k)); return i >= 0 ? i : fb; };
  const di = col('資料日期', 0), ci = col('證券代號', 1), li = col('持股分級', 2), pi = col('人數', 3), ri = col('比例', 5);

  const dates = new Set();
  const acc = {};
  for (const line of lines.slice(1)) {
    const f = splitCsv(line);
    const code = f[ci];
    if (!STOCK_CODE.test(code)) continue;
    const level = Number(f[li]);
    const people = Number(String(f[pi]).replace(/,/g, ''));
    const ratio = Number(String(f[ri]).replace(/,/g, ''));
    if (!Number.isFinite(level) || !Number.isFinite(people)) continue;
    dates.add(f[di]);
    const a = (acc[code] ||= [0, 0, 0, 0, 0]);
    if (level >= 12 && level <= 15) { a[0] += people; a[1] += Number.isFinite(ratio) ? ratio : 0; }
    if (level === 15) { a[2] = people; a[3] = Number.isFinite(ratio) ? ratio : 0; }
    if (level === 17) a[4] = people;
  }
  if (dates.size !== 1) throw new Error(`股權分散表：資料日期不一致（${[...dates].slice(0, 5).join('、')}）`);
  const raw = [...dates][0];
  if (!/^\d{8}$/.test(raw)) throw new Error(`股權分散表：看不懂的日期 ${raw}`);
  const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  for (const a of Object.values(acc)) { a[1] = round2(a[1]); a[3] = round2(a[3]); }
  return { date, stocks: acc };
}

async function fetchNames() {
  const names = {};
  try {
    const list = JSON.parse(await fetchText([TWSE_NAMES], '上市名稱'));
    for (const r of list) if (STOCK_CODE.test(r.Code)) names[r.Code] = { n: r.Name, m: '上市' };
  } catch (e) { console.log(`::warning::上市名稱讀取失敗（不影響計算）：${e.message}`); }
  try {
    const list = JSON.parse(await fetchText([TPEX_NAMES], '上櫃名稱'));
    for (const r of list) {
      const c = r.SecuritiesCompanyCode;
      if (STOCK_CODE.test(c) && !names[c]) names[c] = { n: r.CompanyName, m: '上櫃' };
    }
  } catch (e) { console.log(`::warning::上櫃名稱讀取失敗（不影響計算）：${e.message}`); }
  return names;
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}
async function listSnaps() {
  try {
    return (await readdir(SNAP_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort();
  } catch { return []; }
}

// 連續上升週數；兩週相隔太久就中斷
export function weeklyStreak(dates, series) {
  let k = 0;
  for (let i = series.length - 1; i > 0; i -= 1) {
    const a = series[i], b = series[i - 1];
    if (a == null || b == null || !(a > b)) break;
    if (daysBetween(dates[i - 1], dates[i]) > MAX_GAP_DAYS) break;
    k += 1;
  }
  return k;
}

export function buildLatest(snaps, names) {
  const dates = snaps.map((s) => s.date);
  const last = snaps[snaps.length - 1];
  const L = snaps.length - 1;
  const haveNames = Object.keys(names).length > 0;
  const rows = [];
  for (const [c, cur] of Object.entries(last.stocks)) {
    if (haveNames && !names[c]) continue; // 有名單時排除興櫃等不在上市櫃清單的代號
    const get = (k) => snaps.map((s) => s.stocks[c]?.[k] ?? null);
    const n400 = get(0), p400 = get(1), n1000 = get(2), p1000 = get(3);
    const s400 = weeklyStreak(dates, n400);
    const s1000 = weeklyStreak(dates, n1000);
    if (s400 < 1 && s1000 < 1) continue;
    rows.push({
      c,
      n: names[c]?.n || '',
      m: names[c]?.m || '',
      n400: cur[0],
      d400: n400[L - 1] != null ? cur[0] - n400[L - 1] : null,
      s400,
      p400: cur[1],
      sp400: s400 > 0 ? round2(cur[1] - p400[L - s400]) : 0,
      n1000: cur[2],
      d1000: n1000[L - 1] != null ? cur[2] - n1000[L - 1] : null,
      s1000,
      p1000: cur[3],
      sp1000: s1000 > 0 ? round2(cur[3] - p1000[L - s1000]) : 0,
      tot: cur[4],
    });
  }
  rows.sort((a, b) => b.s400 - a.s400 || b.s1000 - a.s1000 || a.c.localeCompare(b.c));
  return {
    asOf: last.date,
    weeks: snaps.length,
    firstDate: dates[0],
    generatedAt: new Date().toISOString(),
    maxStreak: snaps.length - 1,
    rows,
  };
}

export async function main() {
  await mkdir(SNAP_DIR, { recursive: true });
  const have = await listSnaps();

  const text = await fetchText(TDCC_URLS, '股權分散表');
  const snap = parseTdcc(text);
  const count = Object.keys(snap.stocks).length;
  console.log(`股權分散表：資料日期 ${snap.date}，普通股 ${count} 檔`);
  if (count < MIN_STOCKS) throw new Error(`只有 ${count} 檔，疑似不完整，不寫入`);

  const latestExists = await readJson(LATEST_PATH, null);
  if (have.includes(snap.date) && latestExists) {
    console.log(`${snap.date} 這一週已經存過了（集保可能還沒更新），不需處理`);
    return;
  }
  if (have.length && snap.date < have[have.length - 1]) {
    throw new Error(`拿到的資料日 ${snap.date} 比已存的 ${have[have.length - 1]} 還舊，疑似快取，不寫入`);
  }

  await writeFile(`${SNAP_DIR}/${snap.date}.json`, JSON.stringify(snap));
  const all = [...new Set([...have, snap.date])].sort();
  for (const d of all.slice(0, Math.max(0, all.length - KEEP_WEEKS))) {
    await unlink(`${SNAP_DIR}/${d}.json`).catch(() => {});
  }
  const keep = all.slice(-KEEP_WEEKS);
  const snaps = [];
  for (const d of keep) snaps.push(JSON.parse(await readFile(`${SNAP_DIR}/${d}.json`, 'utf8')));

  const names = await fetchNames();
  const latest = buildLatest(snaps, names);
  await writeFile(LATEST_PATH, JSON.stringify(latest));
  const c = (k, n) => latest.rows.filter((r) => r[k] >= n).length;
  console.log(`完成：已累積 ${snaps.length} 週`);
  console.log(`400 張以上大戶人數連升：2 週+ ${c('s400', 2)} 檔、3 週+ ${c('s400', 3)} 檔、5 週+ ${c('s400', 5)} 檔`);
  console.log(`1000 張以上大戶人數連升：2 週+ ${c('s1000', 2)} 檔、3 週+ ${c('s1000', 3)} 檔、5 週+ ${c('s1000', 5)} 檔`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.log(`::error::${e.message}`); process.exitCode = 1; });
}
