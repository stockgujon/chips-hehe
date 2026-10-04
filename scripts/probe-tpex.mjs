// 診斷用：從 GitHub Actions 測試櫃買中心「上櫃股票每日收盤行情」可能的網址
// 只印出結果，不寫任何檔案。確認後可以刪掉這支程式與 probe-tpex.yml
const BASE = 'https://www.tpex.org.tw/www/zh-tw/afterTrading/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 用 9/30 查詢：回來的日期是 9/30 才代表日期參數有效
const candidates = ['dailyQ', 'otc', 'dailyQuotes', 'stkQuote', 'dailyClose'];

for (const [i, name] of candidates.entries()) {
  if (i > 0) await sleep(4000);
  const body = new URLSearchParams({ date: '2026/09/30', type: 'EW', id: '', response: 'json' });
  console.log(`\n========== ${name} ==========`);
  try {
    const res = await fetch(BASE + name, {
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
    const text = await res.text();
    console.log(`HTTP ${res.status}｜${res.headers.get('content-type')}｜${text.length} 字元`);
    let j;
    try { j = JSON.parse(text); } catch { console.log(`不是 JSON，開頭：${text.slice(0, 200).replace(/\s+/g, ' ')}`); continue; }
    console.log(`最上層欄位：${Object.keys(j).join('、')}`);
    for (const k of ['stat', 'date', 'reportDate']) if (k in j) console.log(`${k} = ${JSON.stringify(j[k])}`);
    const tables = Array.isArray(j.tables) ? j.tables : (j.fields ? [j] : []);
    tables.forEach((tb, n) => {
      console.log(`--- 表格 ${n}：${tb.title ?? ''}｜${tb.date ?? ''}｜${(tb.data || []).length} 列`);
      if (tb.fields) console.log(`欄位：${tb.fields.join('、')}`);
      (tb.data || []).slice(0, 2).forEach((row) => console.log(`範例：${JSON.stringify(row)}`));
    });
  } catch (e) {
    console.log(`失敗：${e.name === 'TimeoutError' ? '逾時' : (e.cause?.code || e.message)}`);
  }
}
