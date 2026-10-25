import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

const BANNER = [
  '// ==UserScript==',
  '// @name         BiliReborn · 哔哩次元转生',
  '// @namespace    https://github.com/bili-reborn',
  '// @version      1.1.2',
  '// @description  二次元清理计划：批量删除动态 / 取关 / 清理评论',
  '// @author       BiliReborn Contributors',
  '// @license      MIT',
  '// @match        https://www.bilibili.com/*',
  '// @match        https://space.bilibili.com/*',
  '// @match        https://t.bilibili.com/*',
  '// @grant        GM_xmlhttpRequest',
  '// @grant        GM_getValue',
  '// @grant        GM_setValue',
  '// @connect      api.bilibili.com',
  '// @connect      api.vc.bilibili.com',
  '// @run-at       document-idle',
  '// @noframes',
  '// ==/UserScript==',
  ''
].join('\n');

mkdirSync('dist', { recursive: true });
mkdirSync('extension', { recursive: true });

const common = {
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  charset: 'utf8',
  legalComments: 'none',
  logLevel: 'info'
};

// 1. Tampermonkey 版本（带 UserScript 头）
await build({
  ...common,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/bili-wiper.user.js',
  banner: { js: BANNER }
});

// 2. Chrome MV3 扩展版本（无 UserScript 头，由 manifest 注入）
await build({
  ...common,
  entryPoints: ['src/index.ts'],
  outfile: 'extension/wiper.bundle.js'
});

console.log('build done: dist/bili-wiper.user.js + extension/wiper.bundle.js');
