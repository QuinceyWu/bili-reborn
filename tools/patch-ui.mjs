import { readFileSync, writeFileSync } from 'node:fs';

const logic = readFileSync('src/ui/panel-logic.js', 'utf8');
let src = readFileSync('tampermonkey/bili-wiper.user.js', 'utf8');

const startMark = '  function $(sel) { return ui.shadow.querySelector(sel); }';
const endMark = '  /* ==========================================================================' + String.fromCharCode(10) + '   * 14. 任务调度';

const start = src.indexOf(startMark);
const end = src.indexOf(endMark);
if (start < 0 || end < 0 || end <= start) throw new Error('markers not found: ' + start + ' ' + end);

src = src.slice(0, start) + logic + String.fromCharCode(10) + src.slice(end);
writeFileSync('tampermonkey/bili-wiper.user.js', src, 'utf8');
console.log('panel logic replaced, removed', end - start, 'chars, inserted', logic.length);
