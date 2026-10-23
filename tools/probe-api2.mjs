const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, 'Referer': 'https://space.bilibili.com/2', 'Origin': 'https://space.bilibili.com' };

async function call(url) {
  try {
    const res = await fetch(url, { headers: H });
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      return { http: res.status, code: j.code, message: j.message, hasData: !!j.data };
    } catch {
      return { http: res.status, code: 'html', message: text.slice(0, 60).replace(/\s+/g, ' ') };
    }
  } catch (e) {
    return { http: 0, code: 'NETWORK', message: String(e.message || e) };
  }
}

console.log('vc space_history ->', JSON.stringify(await call('https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/space_history?host_uid=2&offset_dynamic_id=0&need_top=0&visitor_uid=0')));
console.log('vc space_history2->', JSON.stringify(await call('https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/space_history?host_uid=208259&offset_dynamic_id=0&need_top=1')));
console.log('polymer feed     ->', JSON.stringify(await call('https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=2&offset=&timezone_offset=-480&features=itemOpusStyle')));
console.log('space arc        ->', JSON.stringify(await call('https://api.bilibili.com/x/space/wbi/arc/search?mid=2&ps=5&pn=1')));
