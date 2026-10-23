import { signQuery } from '../src/core/wbi.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/', 'Origin': 'https://www.bilibili.com' };

async function call(url) {
  try {
    const res = await fetch(url, { headers: H });
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      return { http: res.status, code: j.code, message: j.message };
    } catch {
      return { http: res.status, code: 'non-json', message: text.slice(0, 80) };
    }
  } catch (e) {
    return { http: 0, code: 'NETWORK', message: String(e.message || e) };
  }
}

const nav = await call('https://api.bilibili.com/x/web-interface/nav');
console.log('nav            ->', JSON.stringify(nav));
if (nav.code === 'NETWORK') process.exit(0);

const res = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: H });
const navJson = await res.json();
const img = (navJson.data.wbi_img.img_url || '').split('/').pop().split('.')[0];
const sub = (navJson.data.wbi_img.sub_url || '').split('/').pop().split('.')[0];
console.log('wbi keys       -> img=' + img.slice(0, 12) + '... sub=' + sub.slice(0, 12) + '...');

const keys = { img, sub };

const feedQ = signQuery({ host_mid: 2, offset: '', timezone_offset: -480, features: 'itemOpusStyle' }, keys);
console.log('feed           ->', JSON.stringify(await call('https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?' + feedQ)));

const flwQ = signQuery({ vmid: 2, pn: 1, ps: 50, order: 'desc', order_type: 'attention', jsonp: 'jsonp' }, keys);
console.log('followings     ->', JSON.stringify(await call('https://api.bilibili.com/x/relation/followings?' + flwQ)));

const repQ = signQuery({ oid: 170001, type: 1, mode: 3, plat: 1, web_location: 1315875, pagination_str: JSON.stringify({ offset: '' }) }, keys);
console.log('reply/main     ->', JSON.stringify(await call('https://api.bilibili.com/x/v2/reply/wbi/main?' + repQ)));

const msgQ = signQuery({ platform: 'web', build: 0, mobi_app: 'web', pn: 1, ps: 20 }, keys);
console.log('msgfeed/reply  ->', JSON.stringify(await call('https://api.bilibili.com/x/msgfeed/reply?' + msgQ)));

console.log('dynamic del    ->', JSON.stringify(await call('https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/rm_dynamic')));
console.log('relation mod   ->', JSON.stringify(await call('https://api.bilibili.com/x/relation/modify')));
