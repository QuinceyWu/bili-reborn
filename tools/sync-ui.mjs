import { readFileSync, writeFileSync } from 'node:fs';

const css = readFileSync('src/ui/panel.css', 'utf8').trimEnd();
const html = readFileSync('src/ui/panel.html', 'utf8').trimEnd();
const NL = String.fromCharCode(10);

function toLiteral(text, varName, indent) {
  const lines = text.split(NL);
  const body = lines.map((l) => indent + JSON.stringify(l)).join(',\n');
  return 'var ' + varName + ' = [' + NL + body + NL + indent + '].join(String.fromCharCode(10));';
}

let src = readFileSync('tampermonkey/bili-wiper.user.js', 'utf8');

// 两种历史格式都要兼容：.join('') 与 .join(String.fromCharCode(10))
const reCss = /var CSS = \[[\s\S]*?\]\.join\([^)]*(?:\([^)]*\))?[^)]*\);/;
const reHtml = /var HTML = \[[\s\S]*?\]\.join\([^)]*(?:\([^)]*\))?[^)]*\);/;

if (!reCss.test(src)) throw new Error('CSS block not found');
if (!reHtml.test(src)) throw new Error('HTML block not found');

src = src.replace(reCss, toLiteral(css, 'CSS', '    '));
src = src.replace(reHtml, toLiteral(html, 'HTML', '    '));
writeFileSync('tampermonkey/bili-wiper.user.js', src, 'utf8');

const ts = '/** 面板样式（由 src/ui/panel.css 生成，请勿手改） */' + NL +
  'export const CSS = [' + NL +
  css.split(NL).map((l) => '  ' + JSON.stringify(l)).join(',\n') +
  NL + '].join(String.fromCharCode(10));' + NL;
writeFileSync('src/ui/styles.ts', ts, 'utf8');

const tpl = '/** 面板结构（由 src/ui/panel.html 生成，请勿手改） */' + NL +
  'export const HTML = [' + NL +
  html.split(NL).map((l) => '  ' + JSON.stringify(l)).join(',\n') +
  NL + '].join(String.fromCharCode(10));' + NL;
writeFileSync('src/ui/panel-template.ts', tpl, 'utf8');

console.log('synced: css chars=' + css.length + ', html chars=' + html.length);
