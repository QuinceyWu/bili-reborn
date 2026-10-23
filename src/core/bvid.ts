/** BV 号 ⇄ av 号换算（B站公开算法） */
const TAB = 'fZodR9XQDSUm21yCkr6zBqiveYah8bt4xsWpHnJE7jL5VG3guMTKNPAwcF';
const XOR = 177451812;
const ADD = 8728348608;
const POS = [11, 10, 3, 8, 4, 6];

export function bvToAv(bv: string): number {
  let s = 0;
  for (let i = 0; i < 6; i++) {
    const idx = TAB.indexOf(bv.charAt(POS[i]));
    if (idx < 0) return 0;
    s += idx * Math.pow(58, i);
  }
  return (s - ADD) ^ XOR;
}

export function avToBv(av: number): string {
  const n = (av ^ XOR) + ADD;
  // 固定位模板：B V 1 _ _ 4 _ 1 _ 7 _ _
  const out = ['B', 'V', '1', ' ', ' ', '4', ' ', '1', ' ', '7', ' ', ' '];
  for (let i = 0; i < 6; i++) {
    out[POS[i]] = TAB.charAt(Math.floor(n / Math.pow(58, i)) % 58);
  }
  return out.join('');
}
