/* ==========================================================================
   云同步模块  sync.js
   用法：
     1. 页面里先放 <script src="sync.js"></script>（或内联）
     2. 调用 CloudSync.init({ key: 'guokao', onRemote: function(data){...} })
     3. 本地每次保存后调用 CloudSync.push(数据对象)
   ========================================================================== */
var CloudSync = (function () {
  var OWNER = 'Sky-lll27';
  var REPO = 'beikao-data';
  var PATH = 'data.json';
  var BRANCH = 'main';
  var TOKEN_KEY = 'cs.token';

  var slot = null;       // 本页负责的字段名，如 'guokao'
  var onRemote = null;   // 拉到云端数据后的回调
  var sha = null;        // 当前文件 sha，写入时必须带
  var timer = null;      // 防抖定时器
  var pending = null;    // 待推送的数据
  var busy = false;
  var lastStatus = { ok: null, msg: '未开启同步' };

  /* ---------- token ---------- */
  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function setToken(v) {
    try {
      if (v) localStorage.setItem(TOKEN_KEY, v);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
  }
  function hasToken() { return !!getToken(); }

  /* ---------- base64（中文安全） ---------- */
  function enc(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function dec(b64) {
    var bin = atob(b64.replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* ---------- 状态栏 ---------- */
  function ui(msg, kind) {
    lastStatus = { ok: kind === 'ok' ? true : (kind === 'err' ? false : null), msg: msg };
    var el = document.getElementById('cs-bar');
    if (!el) return;
    var color = kind === 'ok' ? '#2e7d32' : (kind === 'err' ? '#c62828' : '#616161');
    var dot = kind === 'ok' ? '●' : (kind === 'err' ? '●' : '○');
    el.innerHTML = '<span style="color:' + color + '">' + dot + '</span> ' + msg +
      ' <a href="javascript:void(0)" id="cs-cfg" style="color:#1565c0;text-decoration:none;margin-left:8px">设置</a>';
    var cfg = document.getElementById('cs-cfg');
    if (cfg) cfg.onclick = openPanel;
  }

  /* ---------- 设置面板 ---------- */
  function openPanel() {
    var old = document.getElementById('cs-panel');
    if (old) { old.parentNode.removeChild(old); return; }
    var d = document.createElement('div');
    d.id = 'cs-panel';
    d.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px';
    d.innerHTML =
      '<div style="background:#fff;border-radius:10px;max-width:520px;width:100%;padding:20px;font-size:14px;line-height:1.7;color:#222">' +
      '<div style="font-weight:700;font-size:16px;margin-bottom:10px">云端同步设置</div>' +
      '<div style="color:#555;margin-bottom:12px">把 GitHub 令牌粘到下面。令牌只存在这台设备的浏览器里，不会上传到任何地方。</div>' +
      '<textarea id="cs-token" placeholder="github_pat_..." style="width:100%;height:76px;box-sizing:border-box;font-family:monospace;font-size:12px;padding:8px;border:1px solid #ccc;border-radius:6px"></textarea>' +
      '<div id="cs-msg" style="margin-top:10px;font-size:13px;min-height:20px"></div>' +
      '<div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">' +
      '<button id="cs-save" style="flex:1;min-width:110px;padding:10px;background:#1565c0;color:#fff;border:0;border-radius:6px;cursor:pointer">保存并测试</button>' +
      '<button id="cs-clear" style="padding:10px 14px;background:#eee;color:#333;border:0;border-radius:6px;cursor:pointer">清除令牌</button>' +
      '<button id="cs-close" style="padding:10px 14px;background:#eee;color:#333;border:0;border-radius:6px;cursor:pointer">关闭</button>' +
      '</div></div>';
    document.body.appendChild(d);
    var ta = document.getElementById('cs-token');
    ta.value = getToken();
    document.getElementById('cs-close').onclick = function () { d.parentNode.removeChild(d); };
    document.getElementById('cs-clear').onclick = function () {
      setToken('');
      document.getElementById('cs-msg').innerHTML = '<span style="color:#c62828">已清除。刷新页面后不再同步。</span>';
      ui('未开启同步', '');
    };
    document.getElementById('cs-save').onclick = function () {
      var v = ta.value.trim();
      if (!v) { document.getElementById('cs-msg').innerHTML = '<span style="color:#c62828">令牌是空的</span>'; return; }
      if (v.indexOf('github_pat_') !== 0 && v.indexOf('ghp_') !== 0) {
        document.getElementById('cs-msg').innerHTML = '<span style="color:#c62828">格式不像 GitHub 令牌，应以 github_pat_ 或 ghp_ 开头</span>';
        return;
      }
      setToken(v);
      document.getElementById('cs-msg').innerHTML = '<span style="color:#1565c0">正在测试…</span>';
      pull(true).then(function (ok) {
        document.getElementById('cs-msg').innerHTML = ok
          ? '<span style="color:#2e7d32">连接成功，可以关掉了</span>'
          : '<span style="color:#c62828">连接失败：' + (lastStatus.msg || '未知错误') + '</span>';
      });
    };
  }

  /* ---------- 读 ---------- */
  function pull(isTest) {
    var tk = getToken();
    if (!tk) { ui('未开启同步', ''); return Promise.resolve(false); }
    ui('正在读取…', '');
    return fetch('https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/' + PATH +
      '?ref=' + BRANCH + '&t=' + Date.now(), {
      headers: { 'Authorization': 'token ' + tk, 'Accept': 'application/vnd.github+json' },
      cache: 'no-store'
    }).then(function (r) {
      if (r.status === 404) { sha = null; return null; }
      if (r.status === 401 || r.status === 403) {
        throw new Error(r.status === 401 ? '令牌无效或已过期' : '令牌没有该仓库权限');
      }
      if (!r.ok) throw new Error('读取失败 HTTP ' + r.status);
      return r.json();
    }).then(function (json) {
      if (!json) {
        ui('云端暂无数据，首次保存会自动创建', 'ok');
        return true;
      }
      sha = json.sha;
      var text = dec(json.content || '');
      var all = {};
      try { all = JSON.parse(text) || {}; } catch (e) { all = {}; }
      var mine = all[slot];
      if (mine && typeof onRemote === 'function') {
        onRemote(mine);
        ui('已从云端读取', 'ok');
      } else {
        ui('已连接（云端暂无本页数据）', 'ok');
      }
      return true;
    }).catch(function (e) {
      ui('同步失败：' + e.message, 'err');
      return false;
    });
  }

  /* ---------- 写 ---------- */
  function doPush(data, retry) {
    var tk = getToken();
    if (!tk) { ui('未开启同步', ''); return Promise.resolve(false); }
    busy = true;

    // 先读一次，拿到最新 sha 和另一端的数据，避免覆盖
    return fetch('https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/' + PATH +
      '?ref=' + BRANCH + '&t=' + Date.now(), {
      headers: { 'Authorization': 'token ' + tk, 'Accept': 'application/vnd.github+json' },
      cache: 'no-store'
    }).then(function (r) {
      if (r.status === 404) return { sha: null, all: {} };
      if (!r.ok) throw new Error('读取失败 HTTP ' + r.status);
      return r.json().then(function (j) {
        sha = j.sha;
        var all = {};
        try { all = JSON.parse(dec(j.content || '')) || {}; } catch (e) { all = {}; }
        return { sha: j.sha, all: all };
      });
    }).then(function (cur) {
      var all = cur.all || {};
      all[slot] = data;                       // 只改本页字段，不碰别的
      all.updatedAt = new Date().toISOString();
      var body = {
        message: 'sync: ' + slot + ' ' + new Date().toLocaleString('zh-CN'),
        content: enc(JSON.stringify(all, null, 2)),
        branch: BRANCH
      };
      if (cur.sha) body.sha = cur.sha;
      return fetch('https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/' + PATH, {
        method: 'PUT',
        headers: {
          'Authorization': 'token ' + tk,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
    }).then(function (r) {
      if (r.status === 409 && !retry) {          // 冲突：别人刚写过，重试一次
        return doPush(data, true);
      }
      if (r.status === 401 || r.status === 403) throw new Error('令牌无效或无写入权限');
      if (!r.ok) return r.text().then(function (t) { throw new Error('写入失败 HTTP ' + r.status); });
      return r.json();
    }).then(function (j) {
      if (j && j.content) sha = j.content.sha;
      var tm = new Date();
      ui('已同步 ' + String(tm.getHours()).padStart(2, '0') + ':' + String(tm.getMinutes()).padStart(2, '0'), 'ok');
      busy = false;
      return true;
    }).catch(function (e) {
      busy = false;
      ui('未同步：' + e.message + '（数据已存在本机）', 'err');
      return false;
    });
  }

  /* ---------- 对外的 push：防抖 2 秒 ---------- */
  function push(data) {
    if (!hasToken()) return;
    pending = data;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      if (busy) { push(pending); return; }
      doPush(pending, false);
    }, 2000);
  }

  /* ---------- 初始化 ---------- */
  function init(opts) {
    slot = opts.key;
    onRemote = opts.onRemote;
    // 建状态栏
    var bar = document.createElement('div');
    bar.id = 'cs-bar';
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;' +
      'background:#f5f5f5;border-top:1px solid #ddd;padding:6px 12px;font-size:12px;' +
      'color:#616161;text-align:center;font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif';
    document.body.appendChild(bar);
    // 给底部留空间，避免挡住内容
    document.body.style.paddingBottom = '36px';
    ui(hasToken() ? '正在读取云端…' : '未开启同步', '');
    if (hasToken()) pull(false);
  }

  return { init: init, push: push, pull: function () { return pull(false); },
           openPanel: openPanel, hasToken: hasToken, status: function () { return lastStatus; } };
})();
