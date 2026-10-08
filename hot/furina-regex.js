/* ══════════════════════════════════════════════════════════
   芙宁娜 · 正则脚本增强层
   1. 更健壮的 findRegex 解析（正确处理转义斜杠、flags）
   2. 多格式兼容（酒馆 / ST 扩展 / 裸正则 / 纯文本）
   3. 修复替换串中的 {{match}} / $0 等占位
   ══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VALID_FLAGS = 'dgimsuvy';

  /**
   * 解析 findRegex 字符串 → { source, flags, ok }
   * 支持：
   *   /pattern/flags      标准字面量
   *   pattern             裸正则
   *   （空）               无效
   * 正确处理 \/ 转义斜杠
   */
  function parseRegex(input) {
    var raw = String(input == null ? '' : input);
    if (!raw.trim()) return { ok: false, reason: '空正则' };

    // 不是 / 开头 → 当裸正则处理
    if (raw.charAt(0) !== '/') {
      return finish(raw, '');
    }

    // 从后往前找最后一个未转义的 /
    var end = -1;
    for (var i = raw.length - 1; i > 0; i--) {
      if (raw.charAt(i) !== '/') continue;
      // 数前面连续反斜杠的个数，偶数个代表这个 / 未被转义
      var bs = 0, j = i - 1;
      while (j >= 0 && raw.charAt(j) === '\\') { bs++; j--; }
      if (bs % 2 === 0) { end = i; break; }
    }

    if (end <= 0) {
      // 只有开头一个 /，当裸正则处理
      return finish(raw.slice(1), '');
    }

    var body = raw.slice(1, end);
    var flagStr = raw.slice(end + 1);

    // flags 必须全是我们认识的字符，否则说明这个 / 不是分隔符
    if (flagStr && !/^[a-z]*$/i.test(flagStr)) {
      return finish(raw, '');
    }
    // 过滤掉不支持的 flag（比如 Python 风格的）
    var flags = '';
    for (var k = 0; k < flagStr.length; k++) {
      var ch = flagStr.charAt(k).toLowerCase();
      if (VALID_FLAGS.indexOf(ch) !== -1 && flags.indexOf(ch) === -1) flags += ch;
    }
    // 有些环境不支持 d/v 标志，去掉以免构造失败
    flags = flags.replace(/[dv]/g, '');

    // 内联修饰符 (?s)(?i)(?m) → flag
    var nm = normalizeModifiers(body, flags);
    return finish(nm.pattern, nm.flags);
  }

  function finish(source, flags) {
    try {
      var re = new RegExp(source, flags);
      return { ok: true, source: source, flags: flags, regex: re };
    } catch (e) {
      // 语法错误：把 flags 去掉再试一次（有些作者写了非法组合）
      try {
        var re2 = new RegExp(source, flags.replace(/g/g, ''));
        return { ok: true, source: source, flags: flags.replace(/g/g, ''), regex: re2, note: 'flags 已调整' };
      } catch (e2) {
        return { ok: false, reason: '正则语法错误: ' + (e && e.message ? e.message : String(e)) };
      }
    }
  }

  /**
   * 应用单条脚本
   * @param {string} text     待处理文本
   * @param {object} script   脚本对象
   * @returns {{text:string, changed:boolean, error?:string}}
   */
  function applyScript(text, script) {
    var input = String(text == null ? '' : text);
    if (!script) return { text: input, changed: false };

    // 未启用的脚本跳过（兼容 disabled / enabled 两种写法）
    if (script.disabled === true) return { text: input, changed: false };
    if (script.enabled === false && script.disabled === undefined) return { text: input, changed: false };

    var p = parseRegex(script.findRegex);
    if (!p.ok) return { text: input, changed: false, error: p.reason };

    var rep = String(script.replaceString == null ? '' : script.replaceString);

    // 处理常见的占位写法
    //   {{match}} → $&   （$& 在后续 input.replace(re, rep) 里展开为整个匹配）
    //   $0        → $&
    //  注意：这里必须用【函数式】替换。若写成 rep.replace(re, '$&')，
    //  '$&' 在替换串语义里等价于「匹配到的内容」本身，等于把 {{match}} 原样写回，
    //  是空操作 —— 用户会看到 {{match}} 四个字面字符被输出到聊天里。
    rep = rep.replace(/\{\{\s*match\s*\}\}/gi, function () { return '$&'; });
    rep = rep.replace(/\$0(?![0-9])/g, function () { return '$&'; });

    // trimStrings：对匹配到的内容做首尾字符裁剪
    var trims = Array.isArray(script.trimStrings) ? script.trimStrings.filter(Boolean) : [];

    try {
      // 正则本身针对标签/代码围栏时不走保护逻辑（作者明确要改标签）
      // 覆盖：含尖括号、代码围栏、HTML 属性名、标签名等价写法
      var src = p.source;
      var targetsMarkup =
        /[<>]/.test(src) ||
        src.indexOf('```') !== -1 ||
        /\b(class|style|href|src|id|data-[\w-]+|alt|title|width|height|colou?r|font)\s*[=:]/.test(src) ||
        /\/?\s*(div|span|p|br|img|a|b|i|u|em|strong|h[1-6]|table|tr|td|ul|ol|li|script|style|html|body)\b/i.test(src);

      // 需要捕获组展开（$1 $2 / $&）时，用字符串式 replace
      // 只有需要 trimStrings 时才走函数式（手动展开）
      if (!trims.length) {
        if (targetsMarkup) {
          var out = input.replace(p.regex, rep);
          return { text: out, changed: out !== input };
        }
        // 保护 HTML / 代码块 / 行内代码，只在普通文本上替换
        var outP = transformUnprotected(input, function (plain) {
          return plain.replace(p.regex, rep);
        });
        return { text: outP, changed: outP !== input };
      }

      var out2 = input.replace(p.regex, function () {
        var args = Array.prototype.slice.call(arguments);
        var groups = args.slice(0, -2);   // 末尾两个是 offset 和原串
        var whole = String(groups[0]);
        for (var i = 0; i < trims.length; i++) {
          var s = String(trims[i]);
          if (!s) continue;
          while (whole.indexOf(s) === 0) whole = whole.slice(s.length);
          while (s && whole.lastIndexOf(s) === whole.length - s.length) whole = whole.slice(0, whole.length - s.length);
        }
        // 手动展开捕获组：$& $0 $1..$9 $$
        var result = rep
          .replace(/\$\$/g, '\u0000')
          .replace(/\$&/g, whole)
          .replace(/\$0/g, whole);
        for (var g = 1; g < groups.length; g++) {
          result = result.replace(new RegExp('\\$' + g, 'g'),
            groups[g] === undefined ? '' : String(groups[g]));
        }
        return result.replace(/\u0000/g, '$');
      });
      return { text: out2, changed: out2 !== input };
    } catch (e) {
      return { text: input, changed: false, error: '替换失败: ' + (e && e.message ? e.message : String(e)) };
    }
  }

  /**
   * 批量应用
   * @param {string} text
   * @param {Array}  scripts
   * @param {object} ctx  { placement, depth }  用于筛选
   */
  function applyAll(text, scripts, ctx) {
    ctx = ctx || {};
    var out = String(text == null ? '' : text);
    var applied = 0, errors = [];
    var list = Array.isArray(scripts) ? scripts : [];

    for (var i = 0; i < list.length; i++) {
      var sc = list[i];
      if (!sc) continue;

      // placement 过滤
      if (ctx.placement !== undefined && Array.isArray(sc.placement) && sc.placement.length) {
        if (sc.placement.indexOf(ctx.placement) === -1) continue;
      }
      // depth 过滤
      if (ctx.depth !== undefined) {
        if (sc.minDepth !== null && sc.minDepth !== undefined && sc.minDepth >= -1 && ctx.depth < sc.minDepth) continue;
        if (sc.maxDepth !== null && sc.maxDepth !== undefined && sc.maxDepth >= 0 && ctx.depth > sc.maxDepth) continue;
      }

      var r = applyScript(out, sc);
      if (r.error) errors.push({ script: sc.scriptName, error: r.error });
      if (r.changed) applied++;
      out = r.text;
    }
    return { text: out, applied: applied, errors: errors };
  }

  /**
   * 规范化任意来源的脚本文本 → 标准数组
   * 支持：数组 / {scripts:[]} / {replaceScripts:[]} / 单条对象 / JSON 字符串
   */
  function normalizeInput(input) {
    var obj = input;
    if (typeof obj === 'string') {
      try { obj = JSON.parse(obj); } catch (e) { return []; }
    }
    if (Array.isArray(obj)) return obj;
    if (!obj || typeof obj !== 'object') return [];
    if (Array.isArray(obj.scripts)) return obj.scripts;
    if (Array.isArray(obj.replaceScripts)) return obj.replaceScripts;
    if (Array.isArray(obj.regex_scripts)) return obj.regex_scripts;
    if (obj.findRegex || obj.find_regex) return [obj];
    return [];
  }

  /* ────────────────────────────────────────────────────────
     受保护内容切分（借鉴 SillyTavern / RolePlay Hub）
     HTML、代码块、行内代码、注释、CoT 标签不参与普通正则替换，
     避免把标签结构改坏。
     ──────────────────────────────────────────────────────── */
  var PROTECTED_RE = /(<!DOCTYPE html>[\s\S]*?<\/html>|<html\b[^>]*>[\s\S]*?<\/html>|<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<!DOCTYPE html>[\s\S]*$|<html\b[^>]*>[\s\S]*$|<script\b[^>]*>[\s\S]*$|<style\b[^>]*>[\s\S]*$|<!--[\s\S]*?(?:-->|$)|```[\s\S]*?(?:```|$)|`[^`\r\n]*`|<\/?[a-zA-Z][\w:-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>)/gi;
  var EXACT_PROTECTED_RE = new RegExp('^' + PROTECTED_RE.source + '$', 'i');

  function splitProtectedText(text) {
    var source = String(text == null ? '' : text);
    var parts = [];
    source.split(PROTECTED_RE).forEach(function (part) {
      if (part) parts.push({ text: part, protected: EXACT_PROTECTED_RE.test(part) });
    });
    return parts;
  }

  function transformUnprotected(text, fn) {
    return splitProtectedText(text).map(function (p) {
      return p.protected ? p.text : fn(p.text);
    }).join('');
  }

  /* ────────────────────────────────────────────────────────
     正则修饰符归一化
     `(?s)` `(?i)` `(?m)` 这类内联标记 → 转成 flag
     ──────────────────────────────────────────────────────── */
  function normalizeModifiers(pattern, flags) {
    var pat = String(pattern == null ? '' : pattern);
    var fl = String(flags == null ? 'g' : flags) || 'g';
    ['s', 'i', 'm'].forEach(function (mod) {
      var marker = '(?' + mod + ')';
      if (pat.indexOf(marker) === -1) return;
      pat = pat.split(marker).join('');
      if (fl.indexOf(mod) === -1) fl += mod;
    });
    return { pattern: pat, flags: fl };
  }

  // 暴露到全局，供 bridge / 页面调用
  window.__furinaRegex = {
    parseRegex: parseRegex,
    applyScript: applyScript,
    applyAll: applyAll,
    normalizeInput: normalizeInput,
    splitProtectedText: splitProtectedText,
    transformUnprotected: transformUnprotected,
    normalizeModifiers: normalizeModifiers
  };
})();
