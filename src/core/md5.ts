/**
 * 纯 JS MD5，仅用于 WBI 的 w_rid 计算。
 * 不依赖 Web Crypto（其不支持 MD5）。
 */

export function md5(str: string): string {
  const words = toWords(str);
  let a0 = 0x67452301 | 0;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476 | 0;

  for (let off = 0; off < words.length; off += 16) {
    let A = a0, B = b0, C = c0, D = d0;
    for (let j = 0; j < 64; j++) {
      let F: number;
      let g: number;
      if (j < 16) { F = (B & C) | (~B & D); g = j; }
      else if (j < 32) { F = (D & B) | (~D & C); g = (5 * j + 1) % 16; }
      else if (j < 48) { F = B ^ C ^ D; g = (3 * j + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * j) % 16; }
      F = (F + A + K[j] + words[off + g]) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + rol(F, S[j])) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }
  return toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0);
}

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];

const K = new Int32Array(64);
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
}

function rol(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) | 0;
}

function toWords(str: string): Int32Array {
  const utf8 = unescape(encodeURIComponent(str));
  const len = utf8.length;
  const nWords = (((len + 8) >> 6) + 1) * 16;
  const words = new Int32Array(nWords);
  for (let i = 0; i < len; i++) {
    words[i >> 2] |= utf8.charCodeAt(i) << ((i % 4) * 8);
  }
  words[len >> 2] |= 0x80 << ((len % 4) * 8);
  words[nWords - 2] = len * 8;
  return words;
}

function toHex(n: number): string {
  let s = '';
  for (let i = 0; i < 4; i++) {
    const b = (n >>> (i * 8)) & 0xff;
    s += (b < 16 ? '0' : '') + b.toString(16);
  }
  return s;
}
