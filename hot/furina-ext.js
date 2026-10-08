/* ==========================================================================
 * 芙宁娜扩展补丁 v1
 *   1. 模型语音上传：可上传多个音频，点击模型时随机播放
 *   2. 自定义聊天文本：可自定义点击模型时显示的台词
 * 存储：IndexedDB (furina-ext / settings)
 * ========================================================================== */
(function () {
  'use strict';

  if (window.__FURINA_EXT_LOADED) return;
  window.__FURINA_EXT_LOADED = true;

  var DB_NAME = 'furina-ext';
  var DB_VER = 1;
  var STORE = 'settings';
  var KEY_VOICES = 'voiceList';
  var KEY_TEXTS = 'chatTexts';

  /* ---------- IndexedDB 简易封装 ---------- */
  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbGet(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var r = tx.objectStore(STORE).get(key);
        r.onsuccess = function () { resolve(r.result); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  function idbSet(key, val) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(val, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  /* ---------- 语音列表 ---------- */
  var voiceUrls = [];      // [{id, name, url}]
  var voiceBlobs = [];     // [{id, name, blob}]
  var chatTexts = null;    // 用户自定义台词数组

  function loadVoices() {
    return idbGet(KEY_VOICES).then(function (list) {
      voiceBlobs = Array.isArray(list) ? list : [];
      // 释放旧 URL
      voiceUrls.forEach(function (v) { try { URL.revokeObjectURL(v.url); } catch (e) {} });
      voiceUrls = voiceBlobs.map(function (v) {
        return { id: v.id, name: v.name, url: URL.createObjectURL(v.blob) };
      });
    }).catch(function () { voiceBlobs = []; voiceUrls = []; });
  }

  function saveVoices() {
    return idbSet(KEY_VOICES, voiceBlobs).catch(function () {});
  }

  function addVoice(name, blob) {
    var id = 'v_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
    voiceBlobs.push({ id: id, name: name, blob: blob });
    voiceUrls.push({ id: id, name: name, url: URL.createObjectURL(blob) });
    return saveVoices();
  }

  function removeVoice(id) {
    voiceBlobs = voiceBlobs.filter(function (v) { return v.id !== id; });
    var hit = voiceUrls.filter(function (v) { return v.id === id; })[0];
    if (hit) { try { URL.revokeObjectURL(hit.url); } catch (e) {} }
    voiceUrls = voiceUrls.filter(function (v) { return v.id !== id; });
    return saveVoices();
  }

  /* ---------- 台词 ---------- */
  function loadTexts() {
    return idbGet(KEY_TEXTS).then(function (list) {
      chatTexts = Array.isArray(list) && list.length ? list : null;
    }).catch(function () { chatTexts = null; });
  }

  function saveTexts(list) {
    chatTexts = list && list.length ? list : null;
    return idbSet(KEY_TEXTS, chatTexts || []).catch(function () {});
  }

  /* ---------- 对外：随机语音 ---------- */
  window.__furinaPlayVoice = function () {
    if (!voiceUrls.length) return false;
    var pick = voiceUrls[Math.floor(Math.random() * voiceUrls.length)];
    try {
      var a = new Audio(pick.url);
      a.play().catch(function () {});
      return true;
    } catch (e) { return false; }
  };

  /* ---------- 对外：随机台词 ---------- */
  window.__furinaRandomText = function () {
    if (!chatTexts || !chatTexts.length) return null;
    return chatTexts[Math.floor(Math.random() * chatTexts.length)];
  };

  /* ---------- UI 面板 ---------- */
  function ensureStyle() {
    if (document.getElementById('furina-ext-style')) return;
    var st = document.createElement('style');
    st.id = 'furina-ext-style';
    st.textContent = [
      '#furina-ext-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;display:flex;',
      'align-items:flex-end;justify-content:center}',
      '#furina-ext-panel{background:#fff;width:100%;max-width:520px;max-height:78vh;overflow-y:auto;',
      'border-radius:18px 18px 0 0;padding:18px 16px 26px;font-size:14px;color:#2c3e50}',
      '#furina-ext-panel h3{margin:0 0 12px;font-size:16px;color:#3f6db5}',
      '#furina-ext-panel .sec{margin-bottom:18px}',
      '#furina-ext-panel .row{display:flex;align-items:center;gap:8px;padding:7px 0;',
      'border-bottom:1px solid #eef2f7}',
      '#furina-ext-panel .row span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#furina-ext-panel textarea{width:100%;min-height:110px;box-sizing:border-box;',
      'border:1px solid #d5dfeb;border-radius:10px;padding:9px;font-size:13px;',
      'line-height:1.5;resize:vertical;font-family:inherit}',
      '#furina-ext-panel button{border:none;border-radius:9px;padding:8px 14px;font-size:13px;',
      'cursor:pointer;background:#5c8fd6;color:#fff}',
      '#furina-ext-panel button.ghost{background:#eef3fa;color:#3f6db5}',
      '#furina-ext-panel button.del{background:#fdeaea;color:#d9534f;padding:5px 10px}',
      '#furina-ext-panel .acts{display:flex;gap:9px;margin-top:12px}',
      '#furina-ext-panel .tip{color:#8a9bb0;font-size:12px;margin:6px 0 10px;line-height:1.5}'
    ].join('');
    document.head.appendChild(st);
  }

  function h(tag, props, kids) {
    var el = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'style') el.style.cssText = props[k];
      else if (k === 'text') el.textContent = props[k];
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2).toLowerCase(), props[k]);
      else el.setAttribute(k, props[k]);
    });
    (kids || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }

  function render() {
    var old = document.getElementById('furina-ext-mask');
    if (old) old.remove();

    var panel = h('div', { id: 'furina-ext-panel' });

    // ── 语音区
    panel.appendChild(h('h3', { text: '🎵 模型语音' }));
    panel.appendChild(h('div', {
      class: 'tip',
      text: '上传音频后，点击模型会从中随机播放一个。留空则使用内置语音。'
    }));
    var vlist = h('div', {});
    if (!voiceUrls.length) {
      vlist.appendChild(h('div', { class: 'tip', text: '（暂无自定义语音）' }));
    } else {
      voiceUrls.forEach(function (v) {
        vlist.appendChild(h('div', { class: 'row' }, [
          h('span', { text: '🔊 ' + v.name }),
          h('button', { class: 'del', text: '删除', onclick: function () {
            removeVoice(v.id).then(render);
          } })
        ]));
      });
    }
    panel.appendChild(vlist);

    var vInput = h('input', { type: 'file', accept: 'audio/*', multiple: 'true', style: 'display:none' });
    vInput.addEventListener('change', function () {
      var files = Array.prototype.slice.call(vInput.files || []);
      if (!files.length) return;
      Promise.all(files.map(function (f) { return addVoice(f.name, f); })).then(function () {
        vInput.value = '';
        render();
      });
    });
    panel.appendChild(vInput);
    panel.appendChild(h('div', { class: 'acts' }, [
      h('button', { text: '＋ 上传语音', onclick: function () { vInput.click(); } }),
      voiceUrls.length ? h('button', {
        class: 'ghost', text: '试听随机一个',
        onclick: function () { window.__furinaPlayVoice(); }
      }) : null
    ]));

    // ── 台词区
    panel.appendChild(h('div', { class: 'sec', style: 'margin-top:20px' }));
    panel.appendChild(h('h3', { text: '💬 自定义台词' }));
    panel.appendChild(h('div', {
      class: 'tip',
      text: '每行一句，点击模型时随机显示其中一句。留空则使用内置台词。'
    }));
    var ta = h('textarea', {
      placeholder: '伟大的芙宁娜女士在此！\n哼哼，想看我表演吗？\n别、别一直盯着人家看啦……'
    });
    ta.value = (chatTexts || []).join('\n');
    panel.appendChild(ta);
    panel.appendChild(h('div', { class: 'acts' }, [
      h('button', {
        text: '保存台词',
        onclick: function () {
          var list = ta.value.split('\n').map(function (s) { return s.trim(); })
            .filter(function (s) { return s.length > 0; });
          saveTexts(list).then(function () {
            h0('已保存 ' + list.length + ' 句台词');
          });
        }
      }),
      h('button', {
        class: 'ghost', text: '清空',
        onclick: function () { ta.value = ''; saveTexts([]).then(function () { h0('已清空'); }); }
      })
    ]));

    panel.appendChild(h('div', { class: 'acts', style: 'margin-top:20px' }, [
      h('button', { class: 'ghost', text: '关闭', onclick: closePanel })
    ]));

    var mask = h('div', {
      id: 'furina-ext-mask',
      onclick: function (e) { if (e.target === mask) closePanel(); }
    }, [panel]);
    document.body.appendChild(mask);
  }

  function h0(msg) {
    var t = h('div', {
      style: 'position:fixed;left:50%;bottom:130px;transform:translateX(-50%);' +
             'background:rgba(63,109,181,.94);color:#fff;padding:9px 18px;' +
             'border-radius:20px;font-size:13px;z-index:100000',
      text: msg
    });
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 1600);
  }

  function closePanel() {
    var m = document.getElementById('furina-ext-mask');
    if (m) m.remove();
  }

  function openPanel() {
    ensureStyle();
    render();
  }

  /* ---------- 对设置页暴露入口（无悬浮按钮） ---------- */
  window.__furinaOpenPanel = function () {
    try { openPanel(); } catch (e) { console.error('[FurinaExt]', e); }
  };

  /* ---------- 启动 ---------- */
  Promise.all([loadVoices(), loadTexts()]).catch(function () {});

})();
