/* ══════════════════════════════════════════════════════════
   芙宁娜创作台 · 自动导入
   助手写完角色卡/世界书/正则，App 自动入库，无需用户操作
   ══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var DB_NAME = 'PiuPiuRoleDB';
  var MARK = '【可导入】';
  var LOG_KEY = 'furina_studio_imported';   // 已导入指纹，避免重复

  // ── IndexedDB ──
  function openDb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DB_NAME);
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function getAll(db, store) {
    return new Promise(function (res) {
      if (!db.objectStoreNames.contains(store)) { res([]); return; }
      try {
        var rq = db.transaction([store], 'readonly').objectStore(store).getAll();
        rq.onsuccess = function () { res(rq.result || []); };
        rq.onerror = function () { res([]); };
      } catch (e) { res([]); }
    });
  }
  function put(db, store, obj) {
    return new Promise(function (res) {
      if (!db.objectStoreNames.contains(store)) { res(false); return; }
      try {
        var tx = db.transaction([store], 'readwrite');
        tx.objectStore(store).put(obj);
        tx.oncomplete = function () { res(true); };
        tx.onerror = function () { res(false); };
      } catch (e) { res(false); }
    });
  }

  // ── 提取 JSON 块 ──
  function extractBlocks(text) {
    var src = String(text || '');
    // 性能优化：一段回复里可能有多个代码块，但只需从最后一个标记开始找
    // 同时限制扫描长度，避免超长回复拖慢
    if (src.length > 60000) src = src.slice(-60000);
    var out = [];
    var re = /```(?:json)?\s*\n([\s\S]*?)```/g;
    var m;
    while ((m = re.exec(src)) !== null) {
      var raw = m[1].trim();
      if (!raw || raw.charAt(0) !== '{') continue;
      try { out.push({ raw: raw, obj: JSON.parse(raw) }); } catch (e) {}
    }
    if (!out.length) {
      var s = src.indexOf('{');
      var e2 = src.lastIndexOf('}');
      if (s >= 0 && e2 > s) {
        try { out.push({ raw: src.slice(s, e2 + 1), obj: JSON.parse(src.slice(s, e2 + 1)) }); } catch (e3) {}
      }
    }
    return out;
  }

  function classify(obj) {
    if (!obj || typeof obj !== 'object') return null;
    var isArr = Array.isArray(obj);

    // ── 先判正则（最容易误判，必须排最前）──
    // 正则脚本的强特征：findRegex / scriptName / regex + replaceString，或 scripts/replaceScripts/regex_scripts 数组
    if (!isArr && (obj.findRegex !== undefined || obj.scriptName !== undefined ||
        obj.regex !== undefined || obj.find_regex !== undefined || obj.replace_regex !== undefined)) {
      return 'regex';
    }
    if (!isArr && (Array.isArray(obj.scripts) || Array.isArray(obj.replaceScripts) || Array.isArray(obj.regex_scripts))) {
      return 'regex';
    }
    // 纯数组，每个元素都是正则脚本
    if (isArr && obj.length > 0 && obj.every(function (e) {
      return e && typeof e === 'object' && (e.findRegex !== undefined || e.scriptName !== undefined || e.regex !== undefined);
    })) {
      return 'regex';
    }

    // ── 世界书 ──
    if (!isArr && (Array.isArray(obj.entries) || obj.character_book !== undefined)) return 'worldbook';

    // ── 角色卡（明确的 spec 标记）──
    if (!isArr && (obj.spec === 'chara_card_v2' || obj.spec === 'character')) return 'character';
    if (!isArr && obj.data && (obj.data.first_mes !== undefined || obj.data.description !== undefined)) return 'character';
    // 局部修改卡（partial_edit + edit_fields）也归为 character，即使字段不全
    if (!isArr && (obj.partial_edit === true || (obj.data && obj.data.partial_edit === true))) return 'character';

    // ── 兜底角色卡：有 name + description/first_mes，且不是正则/世界书 ──
    if (!isArr && obj.name && (obj.description !== undefined || obj.first_mes !== undefined)) return 'character';

    return null;
  }

  function titleOf(obj, kind) {
    if (kind === 'character') { var d = obj.data || obj; return d.name || '未命名角色'; }
    if (kind === 'worldbook') {
      var n = Array.isArray(obj.entries) ? obj.entries.length
            : (obj.character_book && Array.isArray(obj.character_book.entries) ? obj.character_book.entries.length : 0);
      return (obj.name || '世界书') + '（' + n + '条）';
    }
    if (kind === 'regex') {
      var l = obj.scripts || obj.replaceScripts || obj.regex_scripts || [obj];
      return '正则脚本（' + l.length + '条）';
    }
    return '未知';
  }

  // ── 导入实现 ──
  function importCharacter(card) {
    return openDb().then(function (db) {
      return getAll(db, 'roles').then(function (rows) {
        var data = card.data ? card.data : card;
        var nm = data.name || '导入的角色';
        // 同名角色已存在 → 更新，不重复创建
        var exist = null;
        rows.forEach(function (x) {
          if (x && x.name === nm) exist = x;
        });
        var norm = JSON.parse(JSON.stringify(card));
        if (!norm.spec) norm = { spec: 'chara_card_v2', spec_version: '2.0', data: JSON.parse(JSON.stringify(data)) };

        // ── 内嵌正则归一化：角色卡里带了正则（extensions.regex_scripts / regex_scripts / replaceScripts）时，
        //    统一规整成 extensions.regex_scripts，让「添加正则」能直接读到 ──
        try {
          var _d = (norm && norm.data) ? norm.data : norm;
          if (_d && typeof _d === 'object') {
            var _ext = (_d.extensions && typeof _d.extensions === 'object') ? _d.extensions : null;
            var _rawScripts = null;
            if (_ext && Array.isArray(_ext.regex_scripts)) _rawScripts = _ext.regex_scripts;
            else if (_ext && Array.isArray(_ext.replaceScripts)) _rawScripts = _ext.replaceScripts;
            else if (Array.isArray(_d.regex_scripts)) _rawScripts = _d.regex_scripts;
            else if (Array.isArray(_d.replaceScripts)) _rawScripts = _d.replaceScripts;
            else if (Array.isArray(_d.scripts)) _rawScripts = _d.scripts;
            if (Array.isArray(_rawScripts) && _rawScripts.length) {
              var _normScripts = [];
              _rawScripts.forEach(function (r, idx) {
                var e2 = normalizeRegexEntry(r, idx);
                if (e2) _normScripts.push(e2);
              });
              if (_normScripts.length) {
                if (!_ext) { _ext = {}; _d.extensions = _ext; }
                _ext.regex_scripts = _normScripts;
                // 同步写入酒馆兼容字段
                _ext.piupiu_regex = { enabled: true, ignoreEmptyReplace: false, scripts: _normScripts };
              }
            }
          }
        } catch (e) {}

        // ── 局部修改（diff 式）──
        // 卡片带 partial_edit + edit_fields 时，只合并这些字段，其余保留原卡
        var partialFields = null;
        var partialSrc = data;
        if (data && data.partial_edit === true && Array.isArray(data.edit_fields)) {
          partialFields = data.edit_fields;
          partialSrc = data;
        } else if (card.partial_edit === true && Array.isArray(card.edit_fields)) {
          partialFields = card.edit_fields;
          partialSrc = card;
        }

        if (exist && partialFields && partialFields.length) {
          var oldData = (exist.roleData && exist.roleData.data) ? exist.roleData.data
                       : ((exist.roleData && !exist.roleData.spec) ? exist.roleData : null);
          if (!oldData) oldData = exist.roleData || {};
          var mergedData = JSON.parse(JSON.stringify(oldData));
          partialFields.forEach(function (f) {
            if (partialSrc[f] !== undefined) mergedData[f] = JSON.parse(JSON.stringify(partialSrc[f]));
          });
          // 还原成规范结构
          var mergedNorm = { spec: 'chara_card_v2', spec_version: '2.0', data: mergedData };
          exist.roleData = mergedNorm;
          exist.lastInteractTime = Date.now();
          return put(db, 'roles', exist).then(function (ok) {
            return { ok: ok, name: nm, updated: true, partial: true, roleId: exist.id };
          });
        }

        if (exist) {
          exist.roleData = norm;
          exist.lastInteractTime = Date.now();
          return put(db, 'roles', exist).then(function (ok) {
            return { ok: ok, name: nm, updated: true, roleId: exist.id };
          });
        }
        var mx = 0;
        rows.forEach(function (x) { if (x && typeof x.id === 'number' && x.id > mx) mx = x.id; });
        var now = Date.now();
        var newId = mx + 1;
        return put(db, 'roles', {
          id: newId, name: nm, avatar: '', roleData: norm,
          createTime: now, lastInteractTime: now
        }).then(function (ok) { return { ok: ok, name: nm, updated: false, roleId: newId }; });
      });
    });
  }

  // 世界书条目字段归一化：把各种酒馆/驼峰/别名写法统一成 App 的下划线标准字段
  function normalizeWbEntry(e) {
    if (!e || typeof e !== 'object') return e;
    var out = JSON.parse(JSON.stringify(e));
    // 名称别名
    if (out.name === undefined) out.name = out.comment || out.title || '';
    // 关键词别名
    if (out.keys === undefined && Array.isArray(out.key)) out.keys = out.key;
    if (out.keys === undefined && out.secondaryKeys) out.keys = out.secondaryKeys;
    if (!Array.isArray(out.keys)) out.keys = out.keys ? [out.keys] : [];
    out.keys = out.keys.map(function (k) { return String(k); }).filter(Boolean);
    // 大小写
    if (out.case_sensitive === undefined && out.caseSensitive !== undefined) out.case_sensitive = !!out.caseSensitive;
    // 常驻
    if (out.constant === undefined && out.useConstant !== undefined) out.constant = !!out.useConstant;
    // 插入位置（before/after/atDepth）
    if (out.position === undefined) {
      var pos = out.position_override || '';
      if (out.insertionPosition) pos = out.insertionPosition;
      if (pos) out.position = String(pos).toLowerCase();
    }
    if (out.position && String(out.position).toLowerCase().indexOf('depth') >= 0) out.position = 'atDepth';
    // 插入顺序
    if (out.insertion_order === undefined && out.order !== undefined) out.insertion_order = Number(out.order);
    // 扫描深度（条目级，可选）
    if (out.scan_depth === undefined && out.scanDepth !== undefined) out.scan_depth = Number(out.scanDepth);
    // 深度（atDepth 用）
    if (out.depth === undefined && out.atDepth !== undefined) out.depth = Number(out.atDepth);
    return out;
  }

  function importWorldbook(wb) {
    var entries = wb.entries || (wb.character_book && wb.character_book.entries) || [];
    if (!entries.length) return Promise.resolve({ ok: false, reason: '世界书没有条目' });
    return openDb().then(function (db) {
      return getAll(db, 'roles').then(function (rows) {
        if (!rows.length) return { ok: false, reason: '还没有角色卡' };
        rows.sort(function (a, b) { return (b.lastInteractTime || 0) - (a.lastInteractTime || 0); });
        var t = rows[0];
        var rd = JSON.parse(JSON.stringify(t.roleData || {}));
        var d = rd.data || rd;
        var old = d.character_book;
        var oldEntries = (old && Array.isArray(old.entries)) ? old.entries : [];
        // 按条目名去重：同名的用新内容替换，新条目追加
        // 这样改卡时重复导入世界书不会越堆越多
        var byName = {};
        var order = [];
        oldEntries.forEach(function (e) {
          var k = String(e && e.name || '').trim();
          if (!k) k = '__anon_' + order.length;
          if (!(k in byName)) order.push(k);
          byName[k] = e;
        });
        entries.forEach(function (e) {
          var k = String(e && e.name || '').trim();
          if (!k) k = '__anon_' + order.length;
          if (!(k in byName)) order.push(k);
          byName[k] = e;
        });
        var merged = order.map(function (k) { return normalizeWbEntry(byName[k]); });
        var book = {
          name: wb.name || (old && old.name) || '世界书',
          description: wb.description || (old && old.description) || '',
          scan_depth: wb.scan_depth || (old && old.scan_depth) || 10,
          token_budget: wb.token_budget || (old && old.token_budget) || 1536,
          token_budget_enabled: false,
          enabled: true,
          entries: merged
        };
        d.character_book = book;
        if (!rd.data) rd = { spec: 'chara_card_v2', spec_version: '2.0', data: d };
        t.roleData = rd;
        t.lastInteractTime = Date.now();
        return put(db, 'roles', t).then(function (ok) {
          return { ok: ok, name: t.name, count: entries.length, total: merged.length };
        });
      });
    });
  }

  function normalizeRegexEntry(raw, i) {
    if (!raw || typeof raw !== 'object') return null;
    var find = raw.findRegex || raw.find_regex || raw.regex || '';
    if (!String(find).trim()) return null;
    var flags = raw.flags || raw.regexFlags || '';
    if (flags && !/^\//.test(String(find))) {
      find = '/' + find + '/' + String(flags).replace(/[^gimsuy]/g, '');
    }
    var placement = raw.placement;
    if (typeof placement === 'number') placement = [placement];
    if (!Array.isArray(placement) || !placement.length) placement = [2];
    return {
      id: 'st-' + Date.now() + '-' + i + '-' + Math.random().toString(36).slice(2, 7),
      scriptName: String(raw.scriptName || raw.script_name || raw.name || ('导入规则 ' + (i + 1))),
      findRegex: String(find),
      replaceString: String(raw.replaceString != null ? raw.replaceString
        : (raw.replace_string != null ? raw.replace_string : (raw.replacement != null ? raw.replacement : ''))),
      trimStrings: Array.isArray(raw.trimStrings) ? raw.trimStrings : [],
      placement: placement,
      disabled: raw.disabled !== undefined ? !!raw.disabled : (raw.enabled === false),
      markdownOnly: !!raw.markdownOnly, promptOnly: !!raw.promptOnly,
      runOnEdit: !!raw.runOnEdit, substituteRegex: raw.substituteRegex || 0,
      minDepth: raw.minDepth === undefined ? null : raw.minDepth,
      maxDepth: raw.maxDepth === undefined ? null : raw.maxDepth
    };
  }

  // 把正则规则挂到「最近导入/更新的角色」的 extensions.regex_scripts，
  // 这样角色自己的「添加正则」里就能看到，而不是只进全局库
  function attachRegexToLatestRole(scripts) {
    if (!Array.isArray(scripts) || !scripts.length) return Promise.resolve(false);
    return openDb().then(function (db) {
      return getAll(db, 'roles').then(function (rows) {
        if (!rows || !rows.length) return false;
        rows.sort(function (a, b) { return (b.lastInteractTime || 0) - (a.lastInteractTime || 0); });
        var t = rows[0];
        if (!t || !t.roleData) return false;
        var rd = JSON.parse(JSON.stringify(t.roleData));
        var d = (rd && rd.data) ? rd.data : rd;
        var ext = (d && d.extensions && typeof d.extensions === 'object') ? d.extensions : {};
        var old = Array.isArray(ext.regex_scripts) ? ext.regex_scripts : [];
        // 按 findRegex 去重，避免重复导入越堆越多
        var byFind = {};
        old.forEach(function (e) { if (e && e.findRegex) byFind[String(e.findRegex)] = e; });
        scripts.forEach(function (e) { if (e && e.findRegex) byFind[String(e.findRegex)] = e; });
        ext.regex_scripts = Object.keys(byFind).map(function (k) { return byFind[k]; });
        d.extensions = ext;
        if (rd.data) rd.data = d; else rd = d;
        t.roleData = rd;
        t.lastInteractTime = Date.now();
        return put(db, 'roles', t).then(function (ok) { return !!ok; });
      });
    });
  }

  function importRegex(obj) {
    var list = obj.scripts || obj.replaceScripts || obj.regex_scripts || (Array.isArray(obj) ? obj : [obj]);
    var cur = [];
    try { cur = JSON.parse(localStorage.getItem('piupiu_global_regex_scripts') || '[]') || []; } catch (e) { cur = []; }
    if (!Array.isArray(cur)) cur = [];
    var added = 0;
    list.forEach(function (raw, i) {
      var entry = normalizeRegexEntry(raw, i);
      if (!entry) return;
      cur.push(entry);
      added++;
    });
    if (!added) return Promise.resolve({ ok: false, reason: '没有有效的正则规则' });
    localStorage.setItem('piupiu_global_regex_scripts', JSON.stringify(cur));
    localStorage.setItem('piupiu_global_regex_enabled', 'true');
    localStorage.setItem('piupiu_global_regex_migration_version', '3');
    // ── 关键：必须同步刷新 App 的内存态，否则正则「导入成功但不生效」 ──
    //  聊天链路读的是 Pinia 的 globalRegexConfig（内存态），不是 localStorage。
    //  只写 localStorage 的话，要【重启 App】才会重新读 → 用户看到「已启用 N 条」
    //  却毫无效果。App 已暴露 __furinaUpdateGlobalRegex 钩子，直接调它。
    //  （bridge 的 savePresetScripts 有同样处理；此处曾漏掉，两处必须一致）
    try {
      if (typeof window.__furinaUpdateGlobalRegex === 'function') {
        window.__furinaUpdateGlobalRegex(cur, true, true);
      } else {
        window.dispatchEvent(new CustomEvent('piupiu-regex-config-updated'));
      }
    } catch (e) {}
    // 同时挂到最近导入的角色身上（角色正则 → 不是只进全局）
    return attachRegexToLatestRole(cur.slice(-added)).then(function () {
      return { ok: true, count: added };
    });
  }

  function scan(text) {
    var items = [];
    extractBlocks(text).forEach(function (b) {
      var kind = classify(b.obj);
      if (!kind) return;
      items.push({ kind: kind, obj: b.obj, title: titleOf(b.obj, kind) });
    });
    return items;
  }

  // ── 指纹去重 ──
  function fingerprint(items) {
    try {
      return items.map(function (i) {
        var body = '';
        try { body = JSON.stringify(i.obj); } catch (e) { body = ''; }
        // 用标题 + 内容长度 + 内容哈希，确保「重写一遍但内容没变」不会重复弹卡
        var h = 0;
        for (var k = 0; k < body.length; k++) {
          h = ((h << 5) - h + body.charCodeAt(k)) | 0;
        }
        return i.kind + ':' + i.title + ':' + body.length + ':' + (h >>> 0).toString(36);
      }).join('|');
    } catch (e) { return ''; }
  }
  var _doneSet = null;
  function alreadyDone(fp) {
    if (!fp) return true;
    try {
      if (!_doneSet) {
        var list = JSON.parse(localStorage.getItem(LOG_KEY) || '[]') || [];
        _doneSet = {};
        for (var i = 0; i < list.length; i++) _doneSet[list[i]] = 1;
      }
      return !!_doneSet[fp];
    } catch (e) { return false; }
  }
  function markDone(fp) {
    try {
      var list = JSON.parse(localStorage.getItem(LOG_KEY) || '[]') || [];
      list.push(fp);
      if (list.length > 60) list = list.slice(-60);
      localStorage.setItem(LOG_KEY, JSON.stringify(list));
      if (_doneSet) _doneSet[fp] = 1;
    } catch (e) {}
  }

  // ── 自动导入主流程 ──
  var running = false;
  var _scanCache = { key: '', items: null };

  function scanCached(text) {
    // 简单缓存：同一段文本只解析一次
    var key = String(text || '').length + ':' + String(text || '').slice(-80);
    if (_scanCache.key === key) return _scanCache.items;
    var items = scan(text);
    _scanCache = { key: key, items: items };
    return items;
  }

  // 检测到【可导入】内容后：只弹确认卡，等用户点「确认导入」才写入
  function autoImport(text, opts) {
    opts = opts || {};
    if (running) return Promise.resolve(null);
    var items = scanCached(text);
    if (!items.length) return Promise.resolve(null);
    var fp = fingerprint(items);
    if (!opts.force && alreadyDone(fp)) return Promise.resolve(null);
    if (!opts.force && _pendingFp === fp) {
      // 同一份内容已经弹过卡了，别再弹第二次
      return Promise.resolve(null);
    }
    _pendingFp = fp;
    _pendingItems = items;
    _pendingOpts = opts;
    showConfirm(items, fp, opts);
    return Promise.resolve(null);
  }

  // 用户确认后真正执行导入
  var running2 = false;
  function doImportNow(items, fp, opts) {
    opts = opts || {};
    if (running2) return Promise.resolve(null);
    running2 = true;
    running = true;

    var chain = Promise.resolve([]);
    items.forEach(function (it) {
      chain = chain.then(function (acc) {
        var p;
        if (it.kind === 'character') p = importCharacter(it.obj);
        else if (it.kind === 'worldbook') p = importWorldbook(it.obj);
        else if (it.kind === 'regex') p = importRegex(it.obj);
        else p = Promise.resolve({ ok: false });
        return p.then(function (r) { acc.push({ item: it, result: r }); return acc; })
                .catch(function (e) { acc.push({ item: it, result: { ok: false, reason: String(e.message || e) } }); return acc; });
      });
    });

    return chain.then(function (results) {
      running = false;
      running2 = false;
      markDone(fp);
      var okList = results.filter(function (r) { return r.result && r.result.ok; });
      var lines = okList.map(function (r) {
        var r2 = r.result;
        if (r.item.kind === 'character') return '🎭 角色卡「' + r2.name + '」' + (r2.updated ? '（已更新）' : '（已创建）');
        if (r.item.kind === 'worldbook') return '📖 世界书 ' + r2.count + ' 条 → 已挂到「' + r2.name + '」';
        if (r.item.kind === 'regex') return '🔧 正则 ' + r2.count + ' 条已启用';
        return '';
      }).filter(Boolean);

      if (lines.length) {
        // 找到导入的角色，用于跳转
        var charRes = okList.filter(function (r) {
          return r.item.kind === 'character' && r.result && r.result.roleId;
        })[0];
        var targetId = charRes ? charRes.result.roleId : null;

        notify(lines, targetId, opts);
        try { window.dispatchEvent(new CustomEvent('furina-roles-changed', { detail: { results: results } })); } catch (e) {}

        // 通知角色大厅等页面刷新列表（App 内的响应式更新）
        refreshRoleStoreThrottled();

        // 不再刷新页面（会造成白屏），改为直接跳进角色聊天页
        if (targetId && opts.jump !== false) {
          setTimeout(function () { gotoChat(targetId); }, 700);
        }
      }
      return results;
    }).catch(function (e) {
      running = false;
      running2 = false;
      return null;
    });
  }

  // ══════════════════════════════════════════════════════════
  //  导入确认卡 —— 让用户先看再决定，不满意可以继续改
  // ══════════════════════════════════════════════════════════
  var confirmEl = null;
  var _pendingFp = null;
  var _pendingItems = null;
  var _pendingOpts = null;

  var KIND_META = {
    character: { icon: '🎭', label: '角色卡' },
    worldbook: { icon: '📖', label: '世界书' },
    regex:     { icon: '🔧', label: '正则脚本' }
  };

  // ── 用户在聊天里说「导入吧」── 直接导入待确认的那份 ──
  // 匹配很克制：必须整句就是个导入指令，避免误伤正常聊天
  // 「导入」类指令识别
  // 结构：可有前缀（帮我/确认/现在…）+ 动词 + 可有后缀（吧/一下/它…），顺序不限
  var IMPORT_VERB = '(?:导入|装进去|入库|保存|安装|装|创建|建立)';
  var IMPORT_WORD = '(?:确认|确定|可以|帮我|给我|那就|现在就|现在|全部|都|这个|这些|它|一下|吧|呗|呀|啊|了|进去|上|好|行|！|。|~|～|\\s)*';
  // 整句 = 前缀？+ 动词 + 后缀？  或  前缀？(含"全部/现在") + 动词
  var IMPORT_CMD = new RegExp(
    '^(?=' + IMPORT_WORD + IMPORT_VERB + ')' + IMPORT_WORD + IMPORT_VERB + IMPORT_WORD + '$'
  );
  // 结尾是请求：...导入吧 / ...装进去吧
  var IMPORT_CMD2 = new RegExp(IMPORT_VERB + IMPORT_WORD + '(?:吧|呗|呀|！|。|~|～|了好)$');
  var _lastUserCmd = null;

  function checkUserImportCommand(msgs) {
    try {
      if (!_pendingItems || !_pendingItems.length) return;
      var start = Math.max(0, msgs.length - 3);
      for (var i = msgs.length - 1; i >= start; i--) {
        var m = msgs[i];
        if (!m || m.role !== 'user') continue;
        var c = String(m.content || '').trim();
        if (!c || c.length > 24) continue;         // 导入指令都很短
        var mid = m.id || (m.timestamp + ':' + c.length);
        if (_lastUserCmd === mid) return;           // 同一条只处理一次
        if (!IMPORT_CMD.test(c) && !IMPORT_CMD2.test(c)) return;
        _lastUserCmd = mid;
        var items = _pendingItems, fp = _pendingFp, opts = _pendingOpts || {};
        // 稍等一下，让助手的回复先渲染出来
        setTimeout(function () {
          if (!items || !items.length) return;
          hideConfirm();
          doImportNow(items, fp, opts);
        }, 420);
        return;
      }
    } catch (e) {}
  }

  function hideConfirm() {
    // 只关 UI，不清 _pendingItems —— 用户可能接着在聊天里说「导入吧」
    if (confirmEl) {
      confirmEl.classList.remove('show');
      var el = confirmEl;
      confirmEl = null;
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 260);
    }
  }

  function showConfirm(items, fp, opts) {
    hideConfirm();

    var el = document.createElement('div');
    el.className = 'furina-sc-mask';

    var rows = items.map(function (it, i) {
      var m = KIND_META[it.kind] || { icon: '📄', label: '内容' };
      return '<label class="furina-sc-row">' +
               '<input type="checkbox" class="furina-sc-ck" data-i="' + i + '" checked>' +
               '<span class="furina-sc-ico">' + m.icon + '</span>' +
               '<span class="furina-sc-txt">' +
                 '<b>' + escHtml(it.title) + '</b>' +
                 '<i>' + m.label + '</i>' +
               '</span>' +
             '</label>';
    }).join('');

    el.innerHTML =
      '<div class="furina-sc-box" role="dialog" aria-modal="true">' +
      '  <div class="furina-sc-head">' +
      '    <span class="furina-sc-title">📦 写好啦，要导入吗？</span>' +
      '  </div>' +
      '  <div class="furina-sc-body">' +
      '    <div class="furina-sc-tip">不满意就直接说哪里要改，我改完再给你新的。满意了再点导入～</div>' +
      '    <div class="furina-sc-list">' + rows + '</div>' +
      '  </div>' +
      '  <div class="furina-sc-actions">' +
      '    <button type="button" class="furina-sc-btn ghost" data-sc="later">先不导入</button>' +
      '    <button type="button" class="furina-sc-btn primary" data-sc="ok">确认导入</button>' +
      '  </div>' +
      '</div>';

    // 兜底：即使外部样式表没注入成功，也保证卡片能看见
    el.style.position = 'fixed';
    el.style.left = '0'; el.style.right = '0';
    el.style.top = '0'; el.style.bottom = '0';
    el.style.zIndex = '99998';
    el.style.display = 'flex';
    el.style.alignItems = 'flex-end';
    el.style.justifyContent = 'center';
    el.style.background = 'rgba(20,30,50,.45)';

    document.body.appendChild(el);
    confirmEl = el;
    // 内层盒子也补关键样式
    var boxEl = el.firstElementChild;
    if (boxEl && boxEl.style) {
      boxEl.style.width = '100%';
      boxEl.style.maxWidth = '520px';
      boxEl.style.background = '#fff';
      boxEl.style.borderRadius = '22px 22px 0 0';
      boxEl.style.padding = '20px';
      boxEl.style.boxSizing = 'border-box';
      boxEl.style.maxHeight = '86vh';
      boxEl.style.overflowY = 'auto';
    }

    // 关闭（先不导入）
    var later = el.querySelector('[data-sc="later"]');
    if (later) later.onclick = function () {
      hideConfirm();
      // 「先不导入」→ 清掉待确认数据，同一份内容也不再重复弹卡
      _pendingItems = null;
      _pendingOpts = null;
      _pendingFp = fp;        // 但记住指纹，防止助手原样重发又弹一次
      toast('好的，你说要改哪里，我改完再确认～');
    };

    // 确认导入
    var ok = el.querySelector('[data-sc="ok"]');
    if (ok) ok.onclick = function () {
      var picked = [];
      var cks = el.querySelectorAll('.furina-sc-ck');
      for (var i = 0; i < cks.length; i++) {
        if (cks[i].checked) picked.push(items[parseInt(cks[i].getAttribute('data-i'), 10)]);
      }
      if (!picked.length) { toast('一个都没选哦～'); return; }
      hideConfirm();
      _pendingItems = null;
      _pendingOpts = null;
      _lastUserCmd = null;
      doImportNow(picked, fp, opts);
    };

    // 点遮罩不关闭（避免误触丢失），但支持返回键
    reveal(el);
  }

  function toast(msg) {
    try {
      var t = document.createElement('div');
      t.className = 'furina-sc-toast';
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(function () { t.classList.add('show'); }, 10);
      setTimeout(function () {
        t.classList.remove('show');
        setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 260);
      }, 2200);
    } catch (e) {}
  }

  function reveal(el) {
    try { void el.offsetHeight; } catch (e) {}
    el.classList.add('show');
  }

  function escHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── 跳转到角色聊天页（不刷新页面）──
  // 刷新角色库缓存，让新导入的角色立即可见
  function refreshRoleStore() {
    try {
      var store = window.__furinaRoleStore && window.__furinaRoleStore();
      if (!store) return Promise.resolve();
      // refreshRoles 会重载 rawRoles 并刷新当前分页，导入后立刻可见
      if (typeof store.refreshRoles === 'function') {
        return Promise.resolve(store.refreshRoles());
      }
      if (typeof store.ensureAllRolesLoaded === 'function') {
        return Promise.resolve(store.ensureAllRolesLoaded());
      }
      if (typeof store.loadRoles === 'function') {
        return Promise.resolve(store.loadRoles());
      }
    } catch (e) {}
    return Promise.resolve();
  }

  var _lastRefreshAt = 0;
  function refreshRoleStoreThrottled() {
    var now = Date.now();
    if (now - _lastRefreshAt < 900) return Promise.resolve();
    _lastRefreshAt = now;
    return refreshRoleStore();
  }

  function gotoChat(roleId) {
    if (!roleId) return;
    var url = '/chat?roleId=' + encodeURIComponent(roleId);

    // 先确保角色库里有这张卡，再跳转
    refreshRoleStoreThrottled().then(function () {
      return new Promise(function (r) { setTimeout(r, 60); });
    }).then(function () {
      // 已经在聊天页时，push 同一路由不会重新挂载组件 —— 先离开再进
      var onChat = /^\/chat/.test(String(location.pathname || '')) ||
                   /roleId=/.test(String(location.search || ''));
      var nav = window.__furinaNavigate;
      if (typeof nav === 'function') {
        try {
          if (onChat) {
            // 借道角色大厅，强制 ChatView 重新挂载
            nav('/role-hall');
            setTimeout(function () { nav(url); }, 90);
          } else {
            nav(url);
          }
          return;
        } catch (e) {}
      }
      // 兜底：用 history API
      try {
        if (window.history && window.history.pushState) {
          window.history.pushState({}, '', url);
          window.dispatchEvent(new PopStateEvent('popstate'));
          return;
        }
      } catch (e2) {}
      try { location.hash = url; } catch (e3) {}
    });
  }

  // ── 通知条 ──
  var noticeEl = null;
  function notify(lines, targetId, opts) {
    try {
      if (!noticeEl) {
        noticeEl = document.createElement('div');
        noticeEl.className = 'furina-st-notice';
        document.body.appendChild(noticeEl);
      }
      var foot = targetId ? '正在进入角色聊天…' : '已完成';
      noticeEl.innerHTML =
        '<div class="furina-st-notice-head">✨ 创作台已自动完成</div>' +
        lines.map(function (l) { return '<div class="furina-st-notice-line">' + l + '</div>'; }).join('') +
        '<div class="furina-st-notice-foot">' + foot + '</div>';
      noticeEl.classList.add('show');
      setTimeout(function () { if (noticeEl) noticeEl.classList.remove('show'); }, 2400);
    } catch (e) {}
  }

  // ══════════════════════════════════════════════════════════
  //  拦截 IndexedDB 写入 —— 助手回复落库时自动触发
  // ══════════════════════════════════════════════════════════
  var _lastHookId = null;

  function installIdbHook() {
    if (typeof IDBObjectStore === 'undefined' || IDBObjectStore.prototype.__furinaHooked) return false;
    var rawPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value) {
      try {
        if (this && this.name === 'chat_histories' && value && Array.isArray(value.messages)) {
          // 只检查最后几条，避免每次写入都遍历整个历史（长对话会明显拖慢）
          var msgs = value.messages;
          var start = Math.max(0, msgs.length - 3);
          for (var i = msgs.length - 1; i >= start; i--) {
            var m = msgs[i];
            if (!m || m.role !== 'assistant') continue;
            var c = m.content;
            if (typeof c !== 'string' || c.indexOf(MARK) === -1) continue;
            // 用消息 id 做一次快速去重，避免同一条被反复提交
            var mid = m.id || (m.timestamp + ':' + c.length);
            if (_lastHookId === mid) break;
            _lastHookId = mid;
            var txt = c;
            setTimeout(function () { autoImport(txt); }, 350);
            break;
          }
          // 用户说「导入吧」这类话 —— 直接把待确认的那份导进去，
          // 不用非得再去点确认卡上的按钮
          checkUserImportCommand(msgs);
        }
      } catch (e) { /* 绝不影响主流程 */ }
      return rawPut.apply(this, arguments);
    };
    IDBObjectStore.prototype.__furinaHooked = true;
    console.log('[创作台] 已挂载自动导入');
    return true;
  }


  // ── 样式 ──
  (function injectCss() {
    if (document.getElementById('furina-studio-style')) return;
    var st = document.createElement('style');
    st.id = 'furina-studio-style';
    st.textContent =
      '.furina-st-notice{position:fixed;left:50%;top:88px;transform:translate(-50%,-14px);z-index:100000;' +
      'max-width:min(460px,calc(100vw - 32px));padding:14px 18px;border-radius:16px;' +
      'background:linear-gradient(140deg,#3b6fd4,#5a8fe0);color:#fff;' +
      'box-shadow:0 12px 32px rgba(59,111,212,.34);opacity:0;pointer-events:none;' +
      'transition:opacity .26s ease,transform .26s cubic-bezier(.22,.61,.36,1);' +
      'font-family:-apple-system,PingFang SC,Microsoft YaHei,sans-serif}' +
      '.furina-st-notice.show{opacity:1;transform:translate(-50%,0)}' +
      '.furina-st-notice-head{font-size:14.5px;font-weight:800;margin-bottom:8px;letter-spacing:.5px}' +
      '.furina-st-notice-line{font-size:13px;line-height:1.75;opacity:.96}' +
      '.furina-st-notice-foot{font-size:11.5px;opacity:.72;margin-top:8px}' +
      '.furina-sc-mask{position:fixed;top:0;right:0;bottom:0;left:0;z-index:99998;display:flex;' +
      'align-items:flex-end;justify-content:center;background:rgba(20,30,50,0);' +
      'opacity:0;pointer-events:none;transition:background .22s ease,opacity .22s ease;' +
      'font-family:-apple-system,PingFang SC,Microsoft YaHei,sans-serif}' +
      '.furina-sc-mask.show{opacity:1;pointer-events:auto;background:rgba(20,30,50,.45)}' +
      '.furina-sc-box{width:100%;max-width:520px;max-height:86vh;display:flex;flex-direction:column;' +
      'background:#fff;border-radius:22px 22px 0 0;padding:20px 20px calc(18px + env(safe-area-inset-bottom,0px));' +
      'box-sizing:border-box;transform:translateY(100%);transition:transform .28s cubic-bezier(.22,.61,.36,1)}' +
      '.furina-sc-mask.show .furina-sc-box{transform:translateY(0)}' +
      '.furina-sc-head{margin-bottom:12px;flex:none}' +
      '.furina-sc-title{font-size:17px;font-weight:800;color:#2f4463;letter-spacing:.3px}' +
      '.furina-sc-body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;min-height:0}' +
      '.furina-sc-tip{font-size:12.5px;line-height:1.65;color:#8c9cb3;background:#f4f8fd;' +
      'border-radius:12px;padding:11px 13px;margin-bottom:12px}' +
      '.furina-sc-list{display:flex;flex-direction:column;gap:9px}' +
      '.furina-sc-row{display:flex;align-items:center;gap:11px;padding:13px 14px;border-radius:14px;' +
      'background:#fafcff;border:1.5px solid #e6eefa;cursor:pointer;' +
      'transition:all .16s ease;-webkit-tap-highlight-color:transparent}' +
      '.furina-sc-row:active{background:#eef5ff}' +
      '.furina-sc-ck{width:19px;height:19px;accent-color:#3b6fd4;flex:none;margin:0}' +
      '.furina-sc-ico{font-size:19px;line-height:1;flex:none}' +
      '.furina-sc-txt{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}' +
      '.furina-sc-txt b{font-size:14px;font-weight:700;color:#33475f;line-height:1.3;' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.furina-sc-txt i{font-size:11px;font-style:normal;color:#9aabc2}' +
      '.furina-sc-actions{display:grid;grid-template-columns:1fr 1.35fr;gap:10px;margin-top:16px;flex:none}' +
      '.furina-sc-btn{border:none;border-radius:14px;padding:14px 0;font-size:15px;font-weight:700;' +
      'cursor:pointer;font-family:inherit;transition:transform .12s ease;' +
      '-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none}' +
      '.furina-sc-btn:active{transform:scale(.97)}' +
      '.furina-sc-btn.primary{background:linear-gradient(135deg,#4b83e3,#3b6fd4);color:#fff;' +
      'box-shadow:0 5px 16px rgba(59,111,212,.3)}' +
      '.furina-sc-btn.ghost{background:#eef3fa;color:#5b7ba8}' +
      '.furina-sc-toast{position:fixed;left:50%;bottom:16%;transform:translateX(-50%);z-index:100001;' +
      'max-width:calc(100vw - 48px);padding:11px 18px;border-radius:22px;background:rgba(45,60,80,.92);' +
      'color:#fff;font-size:13px;line-height:1.5;text-align:center;' +
      'font-family:-apple-system,PingFang SC,Microsoft YaHei,sans-serif;' +
      'opacity:0;pointer-events:none;transition:opacity .24s ease}' +
      '.furina-sc-toast.show{opacity:1}';
    document.head.appendChild(st);
  })();

  // 暴露给外部（助手人设里也可让模型主动调用）
  window.__furinaStudio = {
    scan: scan,
    doImportNow: doImportNow,
    showConfirm: showConfirm,
    checkUserImportCommand: checkUserImportCommand,
    hideConfirm: hideConfirm,
    gotoChat: gotoChat,
    refreshRoleStore: refreshRoleStore,
    refreshRoleStoreThrottled: refreshRoleStoreThrottled,
    autoImport: autoImport,
    importCharacter: importCharacter,
    importWorldbook: importWorldbook,
    importRegex: importRegex,
    hook: installIdbHook
  };

  installIdbHook();
  // IndexedDB 可能在别处被重新包装，延迟再挂一次
  setTimeout(installIdbHook, 1500);
  setTimeout(installIdbHook, 5000);
})();
