import { ctx } from '../core/context.ts';
import { log } from '../core/logger.ts';
import { client } from '../core/client.ts';
import { CSS } from './styles.ts';
import { HTML } from './panel-template.ts';
import type { LogLevel } from '../core/logger.ts';
import type { TaskKind } from '../core/types.ts';

export interface PanelCallbacks {
  start(kind: TaskKind, oidText: string): void;
  selfCheck(): void;
}

let shadow: ShadowRoot | null = null;

function q<T extends Element>(sel: string): T | null {
  if (!shadow) return null;
  return shadow.querySelector(sel) as T | null;
}

function qa(sel: string): Element[] {
  if (!shadow) return [];
  return Array.prototype.slice.call(shadow.querySelectorAll(sel)) as Element[];
}

function setStat(name: string, val: number): void {
  for (const el of qa('[data-stat=' + name + ']')) {
    el.textContent = String(val);
    el.classList.toggle('zero', !val);
  }
}

export function syncConfigToUI(): void {
  if (!shadow) return;
  const set = (name: string, val: unknown) => {
    const el = q<HTMLInputElement>('[data-cfg=' + name + ']');
    if (el) el.value = String(val);
  };
  set('delayMin', ctx.config.delayMin);
  set('delayMax', ctx.config.delayMax);
  set('batchSize', ctx.config.batchSize);
  set('restSec', Math.round(ctx.config.restMin / 1000));
  set('dailyLimit', ctx.config.dailyLimit);
  set('keepFollowing', ctx.config.keepFollowing);
  const sw = q<HTMLElement>('[data-role=dryRun]');
  if (sw) sw.classList.toggle('on', !!ctx.config.dryRun);
}

function readNumCfg(name: string, def: number): number {
  const el = q<HTMLInputElement>('[data-cfg=' + name + ']');
  const v = el ? parseInt(el.value, 10) : NaN;
  return isNaN(v) ? def : v;
}

export function refreshPanel(): void {
  if (!shadow) return;

  const nameEl = q<HTMLElement>('.baw-uname');
  if (nameEl) nameEl.textContent = client.uid ? client.uname : '未登录';
  const uidEl = q<HTMLElement>('.baw-uid');
  if (uidEl) uidEl.textContent = client.uid ? 'UID ' + client.uid : 'UID --';
  const avatar = q<HTMLImageElement>('.baw-avatar');
  if (avatar && client.face) avatar.src = client.face;

  const quota = q<HTMLElement>('.baw-quota');
  if (quota) {
    quota.textContent = ctx.quota.unlimited()
      ? '已操作 ' + ctx.quota.used() + ' · 不限'
      : '配额 ' + ctx.quota.left() + '/' + ctx.config.dailyLimit;
  }

  setStat('ok', ctx.runner.stats.ok);
  setStat('fail', ctx.runner.stats.fail);
  setStat('skip', ctx.runner.stats.skip);

  const pauseBtn = q<HTMLElement>('[data-act=pause]');
  if (pauseBtn) pauseBtn.textContent = ctx.runner.state === 'paused' ? '继续' : '暂停';

  const busy = ctx.runner.state === 'running' || ctx.runner.state === 'paused';
  const runningNow = ctx.runner.state === 'running';
  const panel = q<HTMLElement>('.baw-panel');
  if (panel) panel.classList.toggle('running', runningNow);
  const fab = q<HTMLElement>('.baw-fab');
  if (fab) fab.classList.toggle('running', runningNow);

  for (const kind of ['dyn', 'flw', 'cmt']) {
    const btn = q<HTMLButtonElement>('[data-act=' + kind + ']');
    if (btn) btn.disabled = busy;
  }
}

export function mountPanel(cb: PanelCallbacks): void {
  if (document.getElementById('baw-root')) return;

  const host = document.createElement('div');
  host.id = 'baw-root';
  document.body.appendChild(host);

  const root = host.attachShadow({ mode: 'open' });
  shadow = root;

  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  const wrap = document.createElement('div');
  wrap.innerHTML = HTML;
  while (wrap.firstChild) root.appendChild(wrap.firstChild);

  const logEl = q<HTMLElement>('.baw-log');
  log.sink = function (level: LogLevel, text: string) {
    if (!logEl) return;
    const row = document.createElement('div');
    row.className = 'baw-log-row baw-log-' + level;
    row.textContent = text;
    logEl.appendChild(row);
    while (logEl.childNodes.length > 400 && logEl.firstChild) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  };

  q<HTMLElement>('.baw-fab')?.addEventListener('click', function () {
    q<HTMLElement>('.baw-panel')?.classList.toggle('baw-hidden');
    refreshPanel();
  });
  q<HTMLElement>('.baw-close')?.addEventListener('click', function () {
    q<HTMLElement>('.baw-panel')?.classList.add('baw-hidden');
  });

  const tabs = qa('.baw-tab');
  const indicator = q<HTMLElement>('.baw-tab-ind');
  tabs.forEach(function (tab, idx) {
    tab.addEventListener('click', function () {
      tabs.forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      if (indicator) indicator.style.transform = 'translateX(' + idx * 100 + '%)';
      const key = tab.getAttribute('data-tab');
      for (const s of qa('.baw-sec')) {
        s.classList.toggle('active', s.getAttribute('data-sec') === key);
      }
      const panelEl = q<HTMLElement>('.baw-panel');
      if (panelEl) panelEl.classList.toggle('cfg-mode', key === 'cfg');
    });
  });

  q<HTMLElement>('[data-role=dryRun]')?.addEventListener('click', function (this: HTMLElement) {
    this.classList.toggle('on');
  });

  q<HTMLElement>('[data-act=save]')?.addEventListener('click', function () {
    ctx.config.delayMin = readNumCfg('delayMin', 1500);
    ctx.config.delayMax = Math.max(readNumCfg('delayMax', 3500), ctx.config.delayMin + 500);
    ctx.config.batchSize = Math.max(1, readNumCfg('batchSize', 15));
    ctx.config.restMin = Math.max(5, readNumCfg('restSec', 60)) * 1000;
    ctx.config.restMax = Math.round(ctx.config.restMin * 2.5);
    const dl = readNumCfg('dailyLimit', 100);
    ctx.config.dailyLimit = dl < 0 ? -1 : Math.min(Math.max(1, dl === 0 ? 100 : dl), 100000);
    const keep = q<HTMLInputElement>('[data-cfg=keepFollowing]');
    ctx.config.keepFollowing = keep ? keep.value.trim() : '';
    const sw = q<HTMLElement>('[data-role=dryRun]');
    ctx.config.dryRun = !!(sw && sw.classList.contains('on'));
    ctx.persist();
    log.ok('设置已保存');
    refreshPanel();
  });

  q<HTMLElement>('[data-act=pause]')?.addEventListener('click', function () {
    if (ctx.runner.state === 'running') ctx.runner.pause();
    else if (ctx.runner.state === 'paused') ctx.runner.resume();
    refreshPanel();
  });

  q<HTMLElement>('[data-act=stop]')?.addEventListener('click', function () {
    ctx.runner.stop();
  });

  q<HTMLElement>('[data-act=selftest]')?.addEventListener('click', function () {
    cb.selfCheck();
  });

  for (const kind of ['dyn', 'flw', 'cmt'] as TaskKind[]) {
    q<HTMLElement>('[data-act=' + kind + ']')?.addEventListener('click', function () {
      const ta = q<HTMLTextAreaElement>('[data-role=oids]');
      cb.start(kind, ta ? ta.value : '');
    });
  }

  ctx.runner.onChange(refreshPanel);
  syncConfigToUI();
  refreshPanel();
}
