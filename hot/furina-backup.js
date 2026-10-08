/* ══════════════════════════════════════════════════════════
   芙宁娜 · 全量备份系统
   导出：IndexedDB（角色卡/聊天记录/设置）+ localStorage + 语音台词
   导入：完整还原，可直接继续聊天
   ══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var DB_NAME = 'PiuPiuRoleDB';
  var DB_VERSION = 9;
  var STORES = ['settings', 'roles', 'chat_histories'];
  var FORMAT = 'furina-backup';
  var FORMAT_VER = 1;

  // ── IndexedDB 底层 ──
  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME);
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('数据库被占用，请关闭其他页面后重试')); };
    });
  }

  function readStore(db, name) {
    return new Promise(function (resolve) {
      if (!db.objectStoreNames.contains(name)) { resolve([]); return; }
      try {
        var tx = db.transaction([name], 'readonly');
        var st = tx.objectStore(name);
        var req = st.getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { resolve([]); };
      } catch (e) { resolve([]); }
    });
  }

  function writeStore(db, name, rows) {
    return new Promise(function (resolve, reject) {
      if (!db.objectStoreNames.contains(name)) { resolve(0); return; }
      try {
        var tx = db.transaction([name], 'readwrite');
        var st = tx.objectStore(name);
        // 先清空再写入，保证是完整还原
        st.clear();
        var n = 0;
        for (var i = 0; i < rows.length; i++) {
          try { st.put(rows[i]); n++; } catch (e) {}
        }
        tx.oncomplete = function () { resolve(n); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('写入被中断')); };
      } catch (e) { reject(e); }
    });
  }

  // ── 合并写入：不清空，逐条 put（同主键覆盖，其余保留）──
  //  历史隐患：importAll 的 merge 分支原先直接调 writeStore()，
  //  而 writeStore 第一件事就是 st.clear() —— 两个分支代码逐字相同，
  //  「合并导入」实际会【静默清空】用户现有数据。这里补上真正的合并实现。
  function mergeStore(db, name, rows) {
    return new Promise(function (resolve, reject) {
      if (!db.objectStoreNames.contains(name)) { resolve(0); return; }
      try {
        var tx = db.transaction([name], 'readwrite');
        var st = tx.objectStore(name);
        var n = 0;
        for (var i = 0; i < rows.length; i++) {
          try { st.put(rows[i]); n++; } catch (e) {}
        }
        tx.oncomplete = function () { resolve(n); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('写入被中断')); };
      } catch (e) { reject(e); }
    });
  }

  // ── localStorage 快照 ──
  function dumpLocalStorage() {
    var out = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k === null) continue;
        // 跳过体积巨大的缓存项
        if (/^(furina_builtin_models)$/.test(k)) continue;
        out[k] = localStorage.getItem(k);
      }
    } catch (e) {}
    return out;
  }

  function restoreLocalStorage(obj, mode) {
    if (!obj) return 0;
    var n = 0;
    try {
      for (var k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        if (mode === 'merge' && localStorage.getItem(k) !== null) continue;
        localStorage.setItem(k, obj[k]);
        n++;
      }
    } catch (e) {}
    return n;
  }

  // ── 统计信息（给界面展示用）──
  function summarize(data) {
    var s = { roles: 0, chats: 0, messages: 0, settings: 0, storage: 0 };
    try {
      s.roles = (data.stores.roles || []).length;
      var ch = data.stores.chat_histories || [];
      s.chats = ch.length;
      for (var i = 0; i < ch.length; i++) {
        var m = ch[i] && ch[i].messages;
        if (Array.isArray(m)) s.messages += m.length;
        else if (m && typeof m === 'object') s.messages += Object.keys(m).length;
      }
      s.settings = (data.stores.settings || []).length;
      s.storage = Object.keys(data.storage || {}).length;
    } catch (e) {}
    return s;
  }

  // ── 导出 ──
  function exportAll(opts) {
    opts = opts || {};
    return openDb().then(function (db) {
      var tasks = STORES.map(function (name) { return readStore(db, name); });
      return Promise.all(tasks).then(function (results) {
        var stores = {};
        for (var i = 0; i < STORES.length; i++) stores[STORES[i]] = results[i];
        db.close();

        var payload = {
          format: FORMAT,
          formatVersion: FORMAT_VER,
          appVersion: (opts.appVersion || ''),
          exportedAt: new Date().toISOString(),
          device: (opts.device || ''),
          stores: stores,
          storage: dumpLocalStorage()
        };
        return payload;
      });
    });
  }

  // ── 导入 ──
  function importAll(payload, mode) {
    mode = mode || 'replace';
    if (!payload || payload.format !== FORMAT) {
      return Promise.reject(new Error('不是有效的备份文件（格式标识不符）'));
    }
    if (!payload.stores) {
      return Promise.reject(new Error('备份文件缺少数据段'));
    }

    return openDb().then(function (db) {
      var names = STORES.filter(function (n) { return db.objectStoreNames.contains(n); });
      var chain = Promise.resolve({ written: {} });

      names.forEach(function (name) {
        chain = chain.then(function (acc) {
          var rows = payload.stores[name] || [];
          //  合并模式：逐条 put，不动用户已有数据（同 id 覆盖，其余保留）
          //  替换模式：先清空再写入（完整还原）
          var writer = mode === 'merge' ? mergeStore : writeStore;
          return writer(db, name, rows).then(function (n) {
            acc.written[name] = n; return acc;
          });
        });
      });

      return chain.then(function (acc) {
        db.close();
        var lsCount = restoreLocalStorage(payload.storage, mode);
        return { written: acc.written, storage: lsCount };
      });
    });
  }

  // ── 文件下载 / 读取 ──
  function download(obj, filename) {
    var blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 800);
  }

  function pickFile() {
    return new Promise(function (resolve, reject) {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json,application/json';
      inp.style.display = 'none';
      document.body.appendChild(inp);
      inp.onchange = function () {
        var f = inp.files && inp.files[0];
        setTimeout(function () { if (inp.parentNode) inp.parentNode.removeChild(inp); }, 100);
        if (!f) { reject(new Error('未选择文件')); return; }
        var rd = new FileReader();
        rd.onload = function () {
          try { resolve(JSON.parse(String(rd.result || ''))); }
          catch (e) { reject(new Error('文件不是有效的 JSON')); }
        };
        rd.onerror = function () { reject(new Error('读取文件失败')); };
        rd.readAsText(f);
      };
      inp.click();
    });
  }

  function fileStamp() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' +
           p(d.getHours()) + p(d.getMinutes());
  }

  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  // 选文件 → 校验 → 导入，一步到位（给面板用）
  //  注意：pickFile() 内部已经做过 JSON.parse，resolve 出来的是【对象】，
  //  这里绝不能再 parse 一次（对非字符串入参 JSON.parse 会先 ToString 成
  //  "[object Object]" 然后抛 SyntaxError → 导入 100% 失败，历史上一直如此）。
  function pickAndImport() {
    return pickFile().then(function (obj) {
      if (!obj || typeof obj !== 'object') {
        throw new Error('文件格式不对，不是有效的备份');
      }
      return importAll(obj).then(function (r) {
        var w = (r && r.written) || {};
        return { roles: w.roles || 0, chats: w.chat_histories || 0, raw: r };
      });
    });
  }

  window.__furinaBackup = {
    exportAll: exportAll,
    importAll: importAll,
    download: download,
    pickFile: pickFile,
    pickAndImport: pickAndImport,
    summarize: summarize,
    fileStamp: fileStamp,
    fmtSize: fmtSize,
    FORMAT: FORMAT
  };
})();


/* ══════════════════════════════════════════════════════════
   芙宁娜 · 备份恢复面板
   ══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var _panel = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function toast(msg, type) {
    if (window.__furinaToast) { window.__furinaToast(msg, type); return; }
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;left:50%;bottom:12%;transform:translateX(-50%);z-index:2147483647;' +
      'background:rgba(30,40,60,.92);color:#fff;padding:11px 20px;border-radius:11px;font-size:14px;' +
      'max-width:80%;text-align:center;line-height:1.5';
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 2400);
  }


  // ══════════════════════════════════════════════════════════
  //  导出路径设置
  // ══════════════════════════════════════════════════════════
  // 原生的保存位置固定是「手机存储/Download/」，改不了。
  // 所以这里让用户自定义的是文件名前缀，方便在 Download 里一眼认出来。
  var DIR_KEY = 'furina_backup_prefix';
  var DEFAULT_DIR = '芙宁娜备份';

  var DIR_PRESETS = [
    { id: '芙宁娜备份', name: '芙宁娜备份_日期.json', desc: '推荐' },
    { id: 'PiuPiu备份', name: 'PiuPiu备份_日期.json', desc: '英文名，更通用' },
    { id: 'backup',     name: 'backup_日期.json',     desc: '纯英文' },
    { id: '',           name: '只写日期.json',         desc: '最短' }
  ];

  function getDir() {
    try {
      var v = localStorage.getItem(DIR_KEY);
      return v === null ? DEFAULT_DIR : v;
    } catch (e) { return DEFAULT_DIR; }
  }
  function setDir(d) {
    try { localStorage.setItem(DIR_KEY, String(d == null ? '' : d)); } catch (e) {}
  }
  function dirLabel() {
    var d = getDir();
    return d ? (d + '_日期.json') : '日期.json';
  }
  function fileName() {
    var st = window.__furinaBackup && window.__furinaBackup.fileStamp
      ? window.__furinaBackup.fileStamp() : String(Date.now());
    var p = getDir();
    return (p ? p + '_' : '') + st + '.json';
  }

  // 优先走原生保存（能落到指定目录），失败再退回浏览器下载
  // 原生 saveTextFile 内部是 new File(getExternalStoragePublicDirectory(DOWNLOADS), filename)
  // 它不会创建中间目录，所以 filename 里绝对不能带 '/'，否则写入失败。
  function safeName(filename) {
    return String(filename || 'backup.json')
      .replace(/[\\/:*?"<>|]/g, '_')   // 去掉路径分隔符与非法字符
      .replace(/^[.\s]+/, '')            // 去掉开头的点和空格
      .slice(0, 120) || 'backup.json';
  }

  function saveFile(filename, content, mime) {
    var plain = safeName(filename);
    try {
      var dl = window.AndroidDownloader;
      if (dl && typeof dl.saveTextFile === 'function') {
        try {
          dl.saveTextFile(plain, content);
          return { ok: true, mode: 'native', path: 'Download/' + plain };
        } catch (e1) {
          console.warn('[Furina] 原生保存失败:', e1);
        }
      }
    } catch (e) {}

    // 浏览器下载兜底
    try {
      var blob = new Blob([content], { type: mime || 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = plain;
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 800);
      return { ok: true, mode: 'browser', path: '下载/' + plain };
    } catch (e3) {
      return { ok: false, mode: 'none', path: '' };
    }
  }

  function open() {
    if (_panel) return;
    var mask = document.createElement('div');
    mask.className = 'furina-preset-mask';
    mask.innerHTML =
      '<div class="furina-preset-box furina-bk-box" role="dialog" aria-modal="true">' +
      '  <div class="furina-preset-head">' +
      '    <span class="furina-preset-title">备份与恢复</span>' +
      '    <button type="button" class="furina-preset-close" aria-label="关闭">✕</button>' +
      '  </div>' +

      // ── 数据概览 ──
      '  <div class="furina-bk-hero">' +
      '    <div class="furina-bk-hero-t">备份文件里有什么</div>' +
      '    <div class="furina-bk-stat" data-bk-stat>正在统计…</div>' +
      '  </div>' +

      // ── 导出路径 ──
      '  <div class="furina-bk-sec">' +
      '    <div class="furina-bk-sec-t">📁 保存位置</div>' +
      '    <div class="furina-bk-loc">' +
      '      <span class="furina-bk-loc-ico">📂</span>' +
      '      <span class="furina-bk-loc-txt">' +
      '        <b>手机存储 / Download</b>' +
      '        <i data-bk-dir-path>/storage/emulated/0/Download/</i>' +
      '      </span>' +
      '    </div>' +
      '    <div class="furina-bk-sec-t" style="margin-top:14px">🏷 文件名叫什么</div>' +
      '    <button type="button" class="furina-bk-dir" data-bk-dir>' +
      '      <span class="furina-bk-dir-ico">📄</span>' +
      '      <span class="furina-bk-dir-txt">' +
      '        <b data-bk-dir-name>芙宁娜备份_日期.json</b>' +
      '        <i data-bk-dir-path2>方便在文件管理器里找到</i>' +
      '      </span>' +
      '      <span class="furina-bk-dir-edit">更改</span>' +
      '    </button>' +
      '    <div class="furina-bk-dir-list" data-bk-dir-list style="display:none"></div>' +
      '  </div>' +

      // ── 操作 ──
      '  <div class="furina-bk-grid">' +
      '    <button type="button" class="furina-bk-btn export" data-bk="export">' +
      '      <span class="furina-bk-ico">📤</span>' +
      '      <span class="furina-bk-btn-t">导出备份</span>' +
      '      <span class="furina-bk-btn-s">角色卡 · 聊天 · 设置</span>' +
      '    </button>' +
      '    <button type="button" class="furina-bk-btn import" data-bk="import">' +
      '      <span class="furina-bk-ico">📥</span>' +
      '      <span class="furina-bk-btn-t">导入备份</span>' +
      '      <span class="furina-bk-btn-s">从文件恢复数据</span>' +
      '    </button>' +
      '  </div>' +

      '  <div class="furina-bk-note">' +
      '    ⚠️ 导入会<strong>覆盖</strong>当前的角色卡与聊天记录。<br>建议先导出一次留底，再导入。' +
      '  </div>' +
      '</div>';
    document.body.appendChild(mask);
    _panel = mask;

    var statEl = mask.querySelector('[data-bk-stat]');
    var dirNameEl = mask.querySelector('[data-bk-dir-name]');
    var dirListEl = mask.querySelector('[data-bk-dir-list]');

    // ── 路径显示与切换 ──
    function renderDir() {
      var d = getDir();
      dirNameEl.textContent = dirLabel();
      var html = '';
      for (var i = 0; i < DIR_PRESETS.length; i++) {
        var it = DIR_PRESETS[i];
        var on = it.id === d ? ' active' : '';
        html += '<button type="button" class="furina-bk-diropt' + on + '" data-dir="' + esc(it.id) + '">' +
                  '<span class="furina-bk-diropt-t">' + esc(it.name) + '</span>' +
                  '<span class="furina-bk-diropt-s">' + esc(it.desc) + '</span>' +
                '</button>';
      }
      dirListEl.innerHTML = html;
      var opts = dirListEl.querySelectorAll('[data-dir]');
      for (var k = 0; k < opts.length; k++) {
        opts[k].onclick = function () {
          setDir(this.getAttribute('data-dir'));
          dirListEl.style.display = 'none';
          renderDir();
          toast('文件名已更新', 'success');
        };
      }
    }
    renderDir();

    var dirToggle = mask.querySelector('[data-bk-dir]');
    if (dirToggle) dirToggle.onclick = function () {
      dirListEl.style.display = dirListEl.style.display === 'none' ? 'block' : 'none';
    };

    // ── 统计当前数据量 ──
    if (window.__furinaBackup) {
      window.__furinaBackup.exportAll({}).then(function (d) {
        var st = window.__furinaBackup.summarize(d);
        var bytes = JSON.stringify(d).length;
        statEl.innerHTML =
          '<span class="furina-bk-chip">🎭 角色卡 <b>' + st.roles + '</b></span>' +
          '<span class="furina-bk-chip">💬 会话 <b>' + st.chats + '</b></span>' +
          '<span class="furina-bk-chip">✉️ 消息 <b>' + st.messages + '</b></span>' +
          '<span class="furina-bk-chip dim">📦 约 ' + fmtSize(bytes) + '</span>';
      }).catch(function (e) {
        statEl.textContent = '读取数据失败：' + (e && e.message ? e.message : e);
      });
    } else {
      statEl.textContent = '备份模块未加载';
    }

    function close() {
      if (!_panel) return;
      var el = _panel; _panel = null;
      el.classList.remove('show');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    }

    // ── 导出 ──
    var expBtn = mask.querySelector('[data-bk="export"]');
    if (expBtn) expBtn.onclick = function () {
      var btn = this;
      btn.disabled = true;
      statEl.textContent = '正在打包…';
      window.__furinaBackup.exportAll({ device: navigator.userAgent.slice(0, 60) })
        .then(function (data) {
          var st = window.__furinaBackup.summarize(data);
          var fname = fileName();
          var res = saveFile(fname, JSON.stringify(data), 'application/json');
          if (res && res.ok) {
            var size = window.__furinaBackup.fmtSize ? window.__furinaBackup.fmtSize(JSON.stringify(data).length) : '';
            statEl.innerHTML =
              '<div class="furina-bk-ok">✓ 导出成功</div>' +
              '<div class="furina-bk-ok-sub">' + st.roles + ' 个角色卡 · ' + st.chats + ' 个会话' +
                (size ? ' · ' + size : '') + '</div>' +
              '<div class="furina-bk-ok-path">📂 ' + esc(res.path) + '</div>';
            toast('已保存到 Download 文件夹', 'success');
          } else {
            statEl.textContent = '导出失败：无法写入文件';
            toast('导出失败', 'error');
          }
        })
        .catch(function (e) {
          statEl.textContent = '导出失败：' + (e && e.message ? e.message : e);
          toast('导出失败', 'error');
        })
        .then(function () { btn.disabled = false; });
    };

    // ── 导入 ──
    var impBtn = mask.querySelector('[data-bk="import"]');
    if (impBtn) impBtn.onclick = function () {
      if (!confirm('导入会覆盖当前的角色卡与聊天记录，确定继续吗？')) return;
      statEl.textContent = '请选择备份文件…';
      window.__furinaBackup.pickAndImport()
        .then(function (r) {
          if (!r) return;
          statEl.innerHTML =
            '<div class="furina-bk-ok">✓ 导入完成</div>' +
            '<div class="furina-bk-ok-sub">' + r.roles + ' 个角色卡 · ' + r.chats + ' 个会话</div>' +
            '<div class="furina-bk-ok-path">重启应用后完全生效</div>';
          toast('导入成功', 'success');
        })
        .catch(function (e) {
          var msg = e && e.message ? e.message : String(e);
          if (msg === '未选择文件') { statEl.textContent = '已取消'; return; }
          statEl.textContent = '导入失败：' + msg;
          toast('导入失败', 'error');
        });
    };

    // 关闭按钮（安全绑定）
    var closeBtn = mask.querySelector('.furina-preset-close');
    if (closeBtn) closeBtn.onclick = close;
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });

    // 稳定显示（不用 rAF，避免 WebView 节流）
    try { void mask.offsetHeight; } catch (e) {}
    mask.classList.add('show');
  }

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ══════════════════════════════════════════════════════════
  //  样式
  // ══════════════════════════════════════════════════════════
  (function injectStyle() {
    try {
      if (document.getElementById('furina-backup-style')) return;
      var st = document.createElement('style');
      st.id = 'furina-backup-style';
      st.textContent =
        '.furina-bk-box{max-height:88vh;overflow-y:auto;-webkit-overflow-scrolling:touch}' +

        // 数据概览卡
        '.furina-bk-hero{background:linear-gradient(135deg,#eef4ff,#f7faff);border-radius:16px;' +
        'padding:14px 15px;margin-bottom:16px;border:1px solid #e3ecfa}' +
        '.furina-bk-hero-t{font-size:12px;font-weight:700;color:#7b8ea8;letter-spacing:.4px;margin-bottom:10px}' +
        '.furina-bk-stat{display:flex;flex-wrap:wrap;gap:8px}' +
        '.furina-bk-chip{display:inline-flex;align-items:center;gap:5px;background:#fff;border-radius:10px;' +
        'padding:7px 11px;font-size:12.5px;color:#5b7ba8;font-weight:600;' +
        'box-shadow:0 1px 4px rgba(90,130,190,.09);white-space:nowrap}' +
        '.furina-bk-chip b{color:#3b6fd4;font-size:14px;font-weight:800}' +
        '.furina-bk-chip.dim{background:#eaf1fb;color:#8fa4c0}' +

        // 区块
        '.furina-bk-sec{margin-bottom:16px}' +
        '.furina-bk-sec-t{font-size:13px;font-weight:700;color:#5b7ba8;margin-bottom:9px;padding-left:2px}' +

        // 目录选择行
        '.furina-bk-dir{width:100%;display:flex;align-items:center;gap:11px;background:#fff;' +
        'border:1.5px solid #dde8f8;border-radius:14px;padding:13px 14px;cursor:pointer;' +
        'font-family:inherit;text-align:left;transition:all .16s ease;-webkit-tap-highlight-color:transparent}' +
        '.furina-bk-dir:active{background:#f4f9ff;border-color:#b9d2f5}' +
        '.furina-bk-dir-ico{font-size:20px;line-height:1;flex:none}' +
        '.furina-bk-dir-txt{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}' +
        '.furina-bk-dir-txt b{font-size:14px;font-weight:700;color:#33475f}' +
        '.furina-bk-dir-txt i{font-size:10.5px;font-style:normal;color:#9aabc2;' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,monospace}' +
        '.furina-bk-loc{display:flex;align-items:center;gap:11px;background:#f2f7fd;' +
        'border-radius:13px;padding:12px 14px;border:1.5px dashed #cfe0f5}' +
        '.furina-bk-loc-ico{font-size:19px;line-height:1;flex:none}' +
        '.furina-bk-loc-txt{display:flex;flex-direction:column;gap:4px;min-width:0}' +
        '.furina-bk-loc-txt b{font-size:13.5px;font-weight:700;color:#3a5578}' +
        '.furina-bk-loc-txt i{font-size:10.5px;font-style:normal;color:#9aabc2;' +
        'font-family:ui-monospace,Menlo,monospace;word-break:break-all}' +
        '.furina-bk-dir-edit{font-size:12px;font-weight:700;color:#4b83e3;background:#eef5ff;' +
        'padding:5px 11px;border-radius:9px;flex:none}' +

        // 目录候选列表
        '.furina-bk-dir-list{margin-top:9px;display:flex;flex-direction:column;gap:7px;' +
        'animation:furinaBkIn .2s ease}' +
        '@keyframes furinaBkIn{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:none}}' +
        '.furina-bk-diropt{display:flex;flex-direction:column;gap:4px;background:#fafcff;' +
        'border:1.5px solid #e6eefa;border-radius:12px;padding:11px 13px;cursor:pointer;' +
        'font-family:inherit;text-align:left;transition:all .15s ease;' +
        '-webkit-tap-highlight-color:transparent;position:relative}' +
        '.furina-bk-diropt:active{background:#f0f7ff}' +
        '.furina-bk-diropt.active{background:#eef5ff;border-color:#8fb8ee;padding-left:22px}' +
        '.furina-bk-diropt.active::before{content:"";position:absolute;left:9px;top:50%;' +
        'transform:translateY(-50%);width:3px;height:20px;border-radius:2px;background:#4b83e3}' +
        '.furina-bk-diropt-t{font-size:13.5px;font-weight:700;color:#3a5578}' +
        '.furina-bk-diropt-s{font-size:10.5px;color:#9aabc2;font-family:ui-monospace,Menlo,monospace}' +

        // 操作按钮
        '.furina-bk-grid{display:grid;grid-template-columns:1fr 1fr;gap:11px;margin-bottom:14px}' +
        '.furina-bk-btn{display:flex;flex-direction:column;align-items:center;gap:5px;' +
        'border:none;border-radius:16px;padding:18px 10px;cursor:pointer;font-family:inherit;' +
        'transition:transform .13s ease;-webkit-tap-highlight-color:transparent;user-select:none}' +
        '.furina-bk-btn:active{transform:scale(.97)}' +
        '.furina-bk-btn:disabled{opacity:.55}' +
        '.furina-bk-btn.export{background:linear-gradient(135deg,#4b83e3,#3b6fd4);color:#fff;' +
        'box-shadow:0 6px 18px rgba(59,111,212,.28)}' +
        '.furina-bk-btn.import{background:#eef3fa;color:#4a6a95}' +
        '.furina-bk-ico{font-size:23px;line-height:1}' +
        '.furina-bk-btn-t{font-size:15px;font-weight:800;letter-spacing:.3px}' +
        '.furina-bk-btn-s{font-size:10.5px;opacity:.8;font-weight:500}' +

        // 结果
        '.furina-bk-ok{font-size:14.5px;font-weight:800;color:#2e9e5b;margin-bottom:5px}' +
        '.furina-bk-ok-sub{font-size:12.5px;color:#6d829e;margin-bottom:6px}' +
        '.furina-bk-ok-path{font-size:11px;color:#8fa4c0;background:#f2f7fd;border-radius:9px;' +
        'padding:8px 11px;font-family:ui-monospace,Menlo,monospace;word-break:break-all;line-height:1.55}' +

        // 提示
        '.furina-bk-note{font-size:12px;line-height:1.7;color:#b07a3a;background:#fff8ec;' +
        'border-radius:12px;padding:11px 13px;border-left:3px solid #f0b95e}';
      document.head.appendChild(st);
    } catch (e) {}
  })();

  window.__furinaOpenBackup = open;
})();
