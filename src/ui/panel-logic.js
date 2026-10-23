  function $(sel) { return ui.shadow.querySelector(sel); }
  function $$(sel) { return ui.shadow.querySelectorAll(sel); }

  function setStat(name, val) {
    $$('[data-stat=' + name + ']').forEach(function (el) {
      el.textContent = String(val);
      // 0 值不点亮，避免满屏红绿
      el.classList.toggle('zero', !val);
    });
  }

  // 把 Config 写回设置表单
  function syncConfigToUI() {
    if (!ui.shadow) return;
    function set(name, val) {
      var el = $('[data-cfg=' + name + ']');
      if (el) el.value = val;
    }
    set('delayMin', Config.delayMin);
    set('delayMax', Config.delayMax);
    set('batchSize', Config.batchSize);
    set('restSec', Math.round(Config.restMin / 1000));
    set('dailyLimit', Config.dailyLimit);
    set('keepFollowing', Config.keepFollowing);
    var sw = $('[data-role=dryRun]');
    if (sw) sw.classList.toggle('on', !!Config.dryRun);
  }

  function readNumCfg(name, def) {
    var el = $('[data-cfg=' + name + ']');
    var v = el ? parseInt(el.value, 10) : NaN;
    return isNaN(v) ? def : v;
  }

  function refreshUI() {
    if (!ui.shadow) return;

    var nameEl = $('.baw-uname');
    if (nameEl) nameEl.textContent = (client && client.uid) ? client.uname : '未登录';
    var uidEl = $('.baw-uid');
    if (uidEl) uidEl.textContent = (client && client.uid) ? ('UID ' + client.uid) : 'UID --';
    var avatar = $('.baw-avatar');
    if (avatar && client && client.face) avatar.src = client.face;

    var quotaEl = $('.baw-quota');
    if (quotaEl) {
      quotaEl.textContent = Quota.unlimited()
        ? ('已操作 ' + Quota.used() + ' · 不限')
        : ('配额 ' + Quota.left() + '/' + Config.dailyLimit);
    }

    setStat('ok', Runner.stats.ok);
    setStat('fail', Runner.stats.fail);
    setStat('skip', Runner.stats.skip);

    var pauseBtn = $('[data-act=pause]');
    if (pauseBtn) pauseBtn.textContent = Runner.state === 'paused' ? '继续' : '暂停';

    var busy = Runner.state === 'running' || Runner.state === 'paused';
    var runningNow = Runner.state === 'running';
    var panel = $('.baw-panel');
    if (panel) panel.classList.toggle('running', runningNow);
    var fab = $('.baw-fab');
    if (fab) fab.classList.toggle('running', runningNow);

    ['dyn', 'flw', 'cmt'].forEach(function (k) {
      var b = $('[data-act=' + k + ']');
      if (b) b.disabled = busy;
    });
  }

  function mountUI() {
    var host = document.createElement('div');
    host.id = 'baw-root';
    document.body.appendChild(host);
    var shadow = host.attachShadow({ mode: 'open' });
    ui.shadow = shadow;

    var style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    var wrap = document.createElement('div');
    wrap.innerHTML = HTML;
    while (wrap.firstChild) shadow.appendChild(wrap.firstChild);

    Log.el = shadow.querySelector('.baw-log');

    shadow.querySelector('.baw-fab').addEventListener('click', function () {
      shadow.querySelector('.baw-panel').classList.toggle('baw-hidden');
      refreshUI();
    });
    shadow.querySelector('.baw-close').addEventListener('click', function () {
      shadow.querySelector('.baw-panel').classList.add('baw-hidden');
    });

    // Tab 切换 + 滑动指示器
    var tabs = Array.prototype.slice.call(shadow.querySelectorAll('.baw-tab'));
    var indicator = shadow.querySelector('.baw-tab-ind');
    tabs.forEach(function (tab, idx) {
      tab.addEventListener('click', function () {
        tabs.forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        if (indicator) indicator.style.transform = 'translateX(' + (idx * 100) + '%)';
        var key = tab.getAttribute('data-tab');
        shadow.querySelectorAll('.baw-sec').forEach(function (s) {
          s.classList.toggle('active', s.getAttribute('data-sec') === key);
        });
        var panelEl = shadow.querySelector('.baw-panel');
        if (panelEl) panelEl.classList.toggle('cfg-mode', key === 'cfg');
      });
    });

    var drySwitch = shadow.querySelector('[data-role=dryRun]');
    if (drySwitch) {
      drySwitch.addEventListener('click', function () {
        this.classList.toggle('on');
      });
    }

    shadow.querySelector('[data-act=save]').addEventListener('click', function () {
      Config.delayMin = readNumCfg('delayMin', 1500);
      Config.delayMax = readNumCfg('delayMax', 3500);
      if (Config.delayMax < Config.delayMin) Config.delayMax = Config.delayMin + 500;
      Config.batchSize = Math.max(1, readNumCfg('batchSize', 15));
      Config.restMin = Math.max(5, readNumCfg('restSec', 60)) * 1000;
      Config.restMax = Math.round(Config.restMin * 2.5);
      var dl = readNumCfg('dailyLimit', 100);
      if (dl === 0) dl = 100;
      Config.dailyLimit = dl < 0 ? -1 : Math.min(dl, 100000);
      var keepEl = shadow.querySelector('[data-cfg=keepFollowing]');
      Config.keepFollowing = keepEl ? keepEl.value.trim() : '';
      var sw = shadow.querySelector('[data-role=dryRun]');
      Config.dryRun = !!(sw && sw.classList.contains('on'));
      saveConfig();
      Log.ok('设置已保存');
      refreshUI();
    });

    shadow.querySelector('[data-act=pause]').addEventListener('click', function () {
      if (Runner.state === 'running') { Runner.state = 'paused'; Log.warn('已暂停，点击「继续」恢复'); }
      else if (Runner.state === 'paused') { Runner.state = 'running'; Log.ok('已恢复'); }
      refreshUI();
    });

    shadow.querySelector('[data-act=stop]').addEventListener('click', function () {
      if (Runner.state === 'running' || Runner.state === 'paused') {
        Runner.state = 'stopping';
        Log.warn('正在停止…');
      }
    });

    shadow.querySelector('[data-act=selftest]').addEventListener('click', function () {
      runSelfCheck().catch(function (err) {
        Log.error('自检异常：' + (err && err.message ? err.message : err));
      });
    });

    shadow.querySelectorAll('[data-act=dyn],[data-act=flw],[data-act=cmt]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        startTask(btn.getAttribute('data-act'));
      });
    });

    syncConfigToUI();
    refreshUI();
  }
