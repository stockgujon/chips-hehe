// 診斷用：從 GitHub Actions 測試櫃買中心「三大法人買賣明細」端點
// 只印出結果，不寫任何檔案。確認格式後可以刪掉這支程式與 probe-tpex.yml
const URL_ = 'https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// date 留空＝網頁預設（最新一天）；其餘測試三種日期寫法，看哪一種有效
const tries = [
  { label: '日期留空', date: '' },
  { label: '西元斜線 2026/10/02', date: '2026/10/02' },
  { label: '民國斜線 115/10/02', date: '115/10/02' },
  { label: '西元無分隔 20261002', date: '20261002' },
];

for (const [i, t] of tries.entries()) {
  if (i > 0) await sleep(4000);
  const body = new URLSearchParams({ type: 'Daily', sect: 'AL', date: t.date, id: '', response: 'json' });
  console.log(`\n========== ${t.label} ==========`);
  try {
    const res = await fetch(URL_, {
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
    const text = await res.text();
    console.log(`HTTP ${res.status}｜${res.headers.get('content-type')}｜${text.length} 字元`);
    let j;
    try { j = JSON.parse(text); } catch { console.log(`不是 JSON，開頭：${text.slice(0, 300).replace(/\s+/g, ' ')}`); continue; }
    console.log(`最上層欄位：${Object.keys(j).join('、')}`);
    for (const k of ['stat', 'date', 'reportDate', 'totalCount']) if (k in j) console.log(`${k} = ${JSON.stringify(j[k])}`);
    const tables = Array.isArray(j.tables) ? j.tables : (j.fields ? [j] : []);
    tables.forEach((tb, n) => {
      console.log(`--- 表格 ${n}：${tb.title ?? ''}｜${tb.date ?? ''}｜${(tb.data || []).length} 列`);
      if (tb.fields) console.log(`欄位：${tb.fields.join('、')}`);
      (tb.data || []).slice(0, 2).forEach((row) => console.log(`範例：${JSON.stringify(row)}`));
    });
    if (!tables.length) console.log(`內容開頭：${text.slice(0, 600)}`);
  } catch (e) {
    console.log(`失敗：${e.name === 'TimeoutError' ? '逾時' : (e.cause?.code || e.message)}`);
  }
}
