(function () {
  'use strict';
  const CONFIG = {
    maxLogsPerSession: 500,
    maxSessions: 10,
    dedupeWindow: 2000,
    maxRawLength: 10000,
    interceptUrls: [
      'chat-completions',
      'chat/completions',
      'image-generate',
      'images/generations',
      'generate-image',
      'completions'
    ]
  };
  const LOGS_STATE = {
    sessions: {},
    currentSessionId: null,
    recentRequestKeys: new Set()
  };
  function getSessionId() {
    return location.pathname + location.search + location.hash;
  }
  function getCurrentSessionLogs() {
    const sid = getSessionId();
    LOGS_STATE.currentSessionId = sid;
    if (!LOGS_STATE.sessions[sid]) {
      LOGS_STATE.sessions[sid] = [];
      const keys = Object.keys(LOGS_STATE.sessions);
      if (keys.length > CONFIG.maxSessions) {
        const oldest = keys.sort((a, b) => {
          const aLogs = LOGS_STATE.sessions[a];
          const bLogs = LOGS_STATE.sessions[b];
          return (aLogs[0]?.time || 0) - (bLogs[0]?.time || 0);
        });
        oldest.slice(0, keys.length - CONFIG.maxSessions).forEach(k => delete LOGS_STATE.sessions[k]);
      }
    }
    return LOGS_STATE.sessions[sid];
  }
  function getFilteredLogs(type) {
    const logs = getCurrentSessionLogs();
    if (type === 'all') return logs;
    return logs.filter(l => l.type === type);
  }
  function addLog(log) {
    const logs = getCurrentSessionLogs();
    const dupCheck = logs.find(l => l.id === log.id);
    if (dupCheck) return;
    logs.unshift(log);
    if (logs.length > CONFIG.maxLogsPerSession) {
      logs.length = CONFIG.maxLogsPerSession;
    }
  }
  function generateRequestKey(url, body) {
    try {
      const u = String(url || '').split('?')[0];
      const b = body ? JSON.stringify(body) : '';
      return u + '|' + b;
    } catch (_) {
      return Date.now() + Math.random();
    }
  }
  function isDuplicateRequest(url, body) {
    const key = generateRequestKey(url, body);
    if (LOGS_STATE.recentRequestKeys.has(key)) return true;
    LOGS_STATE.recentRequestKeys.add(key);
    setTimeout(() => {
      LOGS_STATE.recentRequestKeys.delete(key);
    }, CONFIG.dedupeWindow);
    return false;
  }
  function tryParseJSON(s) {
    if (typeof s !== 'string') return null;
    try { return JSON.parse(s); } catch (_) { return null; }
  }
  function bodyToObject(body) {
    if (!body) return null;
    if (typeof body === 'string') return tryParseJSON(body);
    if (body instanceof FormData || body instanceof Blob || body instanceof ArrayBuffer) return null;
    if (typeof body === 'object') return body;
    return null;
  }
  function isInterceptRequest(url, body) {
    const urlStr = String(url || '').toLowerCase();
    const urlMatch = CONFIG.interceptUrls.some(k => urlStr.includes(k.toLowerCase()));
    if (urlMatch) return true;
    if (body && typeof body === 'object') {
      if (Array.isArray(body.messages) && body.messages.length) return true;
      if (Array.isArray(body.contents) && body.contents.length) return true;
      if (body.prompt || body.input) return true;
    }
    return false;
  }
  function urlOf(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && input.url) return input.url;
    } catch (_) {}
    return '';
  }
  function parseSSE(text) {
    if (!text || typeof text !== 'string') return null;
    const lines = text.split('\n');
    const dataLines = [];
    let fullContent = '';
    let isOpenAIFormat = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) {
        const dataStr = trimmed.slice(5).trim();
        if (dataStr.toLowerCase() === '[done]') continue;
        dataLines.push(dataStr);
        const json = tryParseJSON(dataStr);
        if (json) {
          if (json.choices && json.choices[0]) {
            isOpenAIFormat = true;
            const choice = json.choices[0];
            if (choice.delta && choice.delta.content) {
              fullContent += choice.delta.content;
            } else if (choice.message && choice.message.content) {
              fullContent += choice.message.content;
            }
          } else if (json.content && typeof json.content === 'string') {
            fullContent += json.content;
          } else if (json.output && typeof json.output === 'string') {
            fullContent += json.output;
          }
        }
      }
    }
    if (isOpenAIFormat && fullContent) {
      return { isStream: true, format: 'sse-openai', content: fullContent, chunks: dataLines.length, raw: text };
    }
    if (dataLines.length > 0) {
      return { isStream: true, format: 'sse-raw', content: dataLines.join('\n'), chunks: dataLines.length, raw: text };
    }
    return null;
  }
  function parseNDJSON(text) {
    if (!text || typeof text !== 'string') return null;
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length <= 1) return null;
    let fullContent = '';
    let validCount = 0;
    let isOpenAIStyle = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const json = tryParseJSON(trimmed);
      if (!json) continue;
      validCount++;
      if (json.choices && json.choices[0]) {
        isOpenAIStyle = true;
        const choice = json.choices[0];
        if (choice.delta && choice.delta.content) {
          fullContent += choice.delta.content;
        } else if (choice.message && choice.message.content) {
          fullContent += choice.message.content;
        }
      } else if (json.content && typeof json.content === 'string') {
        fullContent += json.content;
      } else if (json.output && typeof json.output === 'string') {
        fullContent += json.output;
      }
    }
    if (validCount >= 2 && fullContent) {
      return { isStream: true, format: isOpenAIStyle ? 'ndjson-openai' : 'ndjson', content: fullContent, chunks: validCount, raw: text };
    }
    return null;
  }
  function parseStreamResponse(text) {
    if (!text || typeof text !== 'string') return null;
    const sse = parseSSE(text);
    if (sse) return sse;
    const ndjson = parseNDJSON(text);
    if (ndjson) return ndjson;
    const braceMatches = text.match(/^\s*\{/gm);
    if (braceMatches && braceMatches.length >= 2) {
      const parts = text.split(/\n(?=\s*\{)/).filter(p => p.trim());
      if (parts.length >= 2) {
        let fullContent = '';
        let validCount = 0;
        for (const part of parts) {
          const json = tryParseJSON(part.trim());
          if (json) {
            validCount++;
            if (json.choices && json.choices[0]) {
              const c = json.choices[0];
              if (c.delta && c.delta.content) fullContent += c.delta.content;
              else if (c.message && c.message.content) fullContent += c.message.content;
            } else if (json.content && typeof json.content === 'string') {
              fullContent += json.content;
            }
          }
        }
        if (validCount >= 2 && fullContent) {
          return { isStream: true, format: 'generic-stream', content: fullContent, chunks: validCount, raw: text };
        }
      }
    }
    return null;
  }
  function extractAssistantMessage(response) {
    if (!response || !response.body) return null;
    const body = response.body;
    if (body && typeof body === 'object' && body._isStream) {
      return { role: 'assistant', content: body.content || '', isStream: true, streamInfo: { chunks: body.chunks, format: body.format } };
    }
    if (typeof body === 'string') {
      const stream = parseStreamResponse(body);
      if (stream) {
        return { role: 'assistant', content: stream.content, isStream: true, streamInfo: { chunks: stream.chunks, format: stream.format } };
      }
      const json = tryParseJSON(body);
      if (json) return extractAssistantMessage({ ...response, body: json });
      return { role: 'assistant', content: body };
    }
    if (typeof body === 'object') {
      if (body.choices && body.choices[0]) {
        const choice = body.choices[0];
        if (choice.message) return choice.message;
        if (choice.delta) return { role: 'assistant', content: choice.delta.content || '' };
      }
      if (body.output && typeof body.output === 'string') return { role: 'assistant', content: body.output };
      if (body.content) return { role: 'assistant', content: typeof body.content === 'string' ? body.content : JSON.stringify(body.content, null, 2) };
      if (body.data && Array.isArray(body.data)) return { role: 'assistant', content: JSON.stringify(body, null, 2), isImageResponse: true };
      if (body.error) return { role: 'assistant', content: JSON.stringify(body.error, null, 2), isError: true };
    }
    return null;
  }
  function isImageRequest(url, body) {
    const urlStr = String(url || '').toLowerCase();
    if (urlStr.includes('image') && (urlStr.includes('generat') || urlStr.includes('create'))) return true;
    if (body && typeof body === 'object') {
      if (body.model && String(body.model).toLowerCase().includes('dall')) return true;
      if ((body.size || body.quality || body.n) && (body.prompt || body.input)) return true;
    }
    return false;
  }
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const method = (init && init.method) || (input && input.method) || 'GET';
    let logId = null;
    let logEntry = null;
    try {
      if (String(method).toUpperCase() === 'POST') {
        const body = (init && init.body) != null ? init.body : (input && input.body);
        const parsed = bodyToObject(body);
        const url = urlOf(input);
        if (isInterceptRequest(url, parsed) && !isDuplicateRequest(url, parsed)) {
          logId = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
          const isImg = isImageRequest(url, parsed);
          logEntry = {
            id: logId,
            url: url,
            time: new Date(),
            request: parsed,
            requestBody: body,
            response: null,
            responseTime: null,
            type: isImg ? 'image' : 'chat'
          };
          addLog(logEntry);
        }
      }
    } catch (_) {}
    const promise = origFetch.apply(this, arguments);
    if (logId && logEntry) {
      promise.then(async (response) => {
        try {
          const contentType = response.headers.get('content-type') || '';
          if (/image|audio|video|application\/pdf/.test(contentType)) {
            logEntry.response = {
              status: response.status,
              statusText: response.statusText,
              body: { _binary: true, type: contentType },
              ok: response.ok
            };
            logEntry.responseTime = new Date();
            return response;
          }
          const cloned = response.clone();
          const text = await cloned.text();
          let bodyData = tryParseJSON(text);
          if (!bodyData) {
            const stream = parseStreamResponse(text);
            if (stream) {
              bodyData = { _isStream: true, ...stream };
            } else {
              bodyData = text;
            }
          }
          const rawText = text.length > CONFIG.maxRawLength ? text.slice(0, CONFIG.maxRawLength) + '…' : text;
          logEntry.response = {
            status: response.status,
            statusText: response.statusText,
            body: bodyData,
            raw: rawText,
            ok: response.ok
          };
          logEntry.responseTime = new Date();
          if (!response.ok && bodyData && bodyData.error) {
            logEntry.error = bodyData.error;
          }
        } catch (e) {
          logEntry.response = {
            status: response.status,
            statusText: response.statusText,
            body: null,
            error: String(e)
          };
        }
        return response;
      }).catch((err) => {
        if (logEntry) {
          logEntry.response = {
            status: 0,
            statusText: 'Network Error',
            body: null,
            error: String(err)
          };
        }
      });
    }
    return promise;
  };
  const STYLE_ID = 'pv-style';
  const BTN_FLAG = 'data-pv-injected';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      .pv-mask{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99999;display:flex;align-items:center;justify-content:center;animation:pv-fade .15s ease}
      @keyframes pv-fade{from{opacity:0}to{opacity:1}}
      .pv-modal{background:var(--bg-color,#fff);color:var(--text-color,#222);width:min(720px,95vw);height:min(85vh,800px);border-radius:14px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.3)}
      .pv-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid rgba(127,127,127,.2);flex-shrink:0}
      .pv-head h3{margin:0;font-size:16px;font-weight:600}
      .pv-head .pv-meta{font-size:11px;opacity:.6;margin-top:2px;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pv-close{background:transparent;border:none;color:inherit;font-size:22px;cursor:pointer;padding:4px 8px;line-height:1;flex-shrink:0}
      .pv-log-nav{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid rgba(127,127,127,.1);flex-shrink:0;font-size:12px;background:rgba(127,127,127,.04);flex-wrap:nowrap;overflow-x:auto}
      .pv-log-nav::-webkit-scrollbar{display:none}
      .pv-log-nav button{background:rgba(127,127,127,.12);border:none;color:inherit;border-radius:6px;padding:6px 10px;font-size:12px;cursor:pointer;flex-shrink:0;white-space:nowrap}
      .pv-log-nav button:disabled{opacity:.4;cursor:not-allowed}
      .pv-log-nav button.pv-active{background:rgba(45,140,240,.2);color:#2d8cf0;font-weight:600}
      .pv-log-nav .pv-log-info{display:inline-flex;align-items:baseline;gap:0;flex-shrink:0;min-width:48px;text-align:center;font-variant-numeric:tabular-nums}
      .pv-log-nav .pv-log-info input{width:36px;text-align:right;padding:0 2px;background:transparent;border:none;color:inherit;font:inherit;outline:none;-webkit-appearance:none;-moz-appearance:textfield}
      .pv-log-nav .pv-log-info input::-webkit-outer-spin-button,.pv-log-nav .pv-log-info input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
      .pv-log-nav .pv-log-info #pv-page-sep{margin:0 1px;opacity:.8;flex-shrink:0}
      .pv-log-nav .pv-log-info #pv-page-total{flex-shrink:0}
      .pv-log-nav .pv-type-filter{display:flex;gap:4px;margin-left:12px;flex-shrink:0}
      .pv-log-nav .pv-type-filter button{padding:4px 10px;font-size:11px;border-radius:4px}
      .pv-tabs{display:flex;gap:4px;padding:8px 12px 0;border-bottom:1px solid rgba(127,127,127,.15);flex-shrink:0}
      .pv-tabs button{background:transparent;border:none;color:inherit;padding:8px 14px;font-size:13px;cursor:pointer;border-radius:8px 8px 0 0;opacity:.6;white-space:nowrap}
      .pv-tabs button.pv-active{opacity:1;background:rgba(127,127,127,.12);font-weight:600}
      .pv-tools{display:flex;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(127,127,127,.15);flex-shrink:0;align-items:center}
      .pv-tools input{flex:1;min-width:0;background:rgba(127,127,127,.1);border:1px solid rgba(127,127,127,.2);border-radius:8px;padding:6px 10px;color:inherit;font-size:13px;outline:none}
      .pv-tools button{background:rgba(127,127,127,.15);border:none;color:inherit;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;white-space:nowrap;flex-shrink:0}
      .pv-tools button:active{opacity:.7}
      .pv-tools button.pv-danger{background:rgba(239,68,68,.12);color:#ef4444}
      .pv-body{flex:1;overflow-y:auto;padding:12px;font-size:13px;line-height:1.55;min-height:0}
      .pv-empty{opacity:.5;text-align:center;padding:40px 12px;font-size:13px}
      .pv-section-title{font-size:11px;font-weight:600;opacity:.6;text-transform:uppercase;letter-spacing:.5px;margin:12px 0 6px;padding:0 2px}
      .pv-section-title:first-child{margin-top:0}
      .pv-msg{margin-bottom:10px;border:1px solid rgba(127,127,127,.18);border-radius:10px;overflow:hidden}
      .pv-msg-head{display:flex;justify-content:space-between;align-items:center;padding:6px 10px;font-size:11px;background:rgba(127,127,127,.08)}
      .pv-role{font-weight:600;text-transform:uppercase;letter-spacing:.5px}
      .pv-role-system{color:#a259ff}
      .pv-role-user{color:#2d8cf0}
      .pv-role-assistant{color:#19be6b}
      .pv-role-tool,.pv-role-function{color:#ff9900}
      .pv-len{opacity:.5}
      .pv-msg-body{padding:8px 10px;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;max-height:none}
      .pv-hl{background:rgba(255,215,0,.45);border-radius:2px}
      .pv-json{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;margin:0}
      .pv-hidden{display:none}
      .pv-response-info{padding:8px 10px;background:rgba(25,190,107,.06);border:1px solid rgba(25,190,107,.15);border-radius:8px;margin-bottom:10px;font-size:12px}
      .pv-response-info.pv-error{background:rgba(239,68,68,.06);border-color:rgba(239,68,68,.15)}
      .pv-response-info.pv-stream{background:rgba(255,153,0,.06);border-color:rgba(255,153,0,.15)}
      .pv-stream-badge{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;background:rgba(255,153,0,.15);color:#ff9900;margin-left:6px;vertical-align:middle}
      .pv-error-box{padding:10px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:8px;margin-bottom:10px;font-size:12px;color:#ef4444;white-space:pre-wrap;word-break:break-word}
      .pv-image-preview{max-width:100%;border-radius:8px;margin-top:8px}
      .settings-btn svg{width:1.6em!important;height:1.6em!important;stroke:currentColor!important;stroke-width:2!important;display:block!important;margin:0 auto!important;flex-shrink:0!important;color:inherit!important;vertical-align:middle!important}
      .pv-icon-wrap{display:flex!important;align-items:center!important;justify-content:center!important;margin-top:2px!important}
      @media(max-width:520px){
        .pv-log-nav{gap:3px;padding:6px 8px}
        .pv-log-nav button{padding:4px 6px;font-size:11px}
        .pv-log-nav .pv-type-filter{margin-left:4px}
        .pv-log-nav .pv-type-filter button{padding:3px 6px;font-size:10px}
      }
    `;
    document.head.appendChild(s);
  }
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function highlight(html, query) {
    if (!query) return html;
    try {
      const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return html.replace(new RegExp(q, 'gi'), m => `<span class="pv-hl">${m}</span>`);
    } catch (_) { return html; }
  }
  function flattenContent(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(p => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object') {
          if (typeof p.text === 'string') return p.text;
          if (p.type === 'image_url') return '[image]';
          if (p.type === 'tool_use') return '[tool_use: ' + (p.name || '') + ']';
          return JSON.stringify(p);
        }
        return String(p);
      }).join('\n');
    }
    if (typeof content === 'object') return JSON.stringify(content, null, 2);
    return String(content);
  }
  function normalizeMessages(body) {
    if (!body) return [];
    if (Array.isArray(body.messages)) return body.messages;
    if (Array.isArray(body.contents)) {
      return body.contents.map(c => ({
        role: c.role || 'user',
        content: Array.isArray(c.parts) ? c.parts.map(p => p.text || '').join('\n') : ''
      }));
    }
    return [];
  }
  function extractLastUserMessage(messages) {
    if (!messages || !messages.length) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i];
    }
    return messages[messages.length - 1];
  }
  function logContainsQuery(log, query) {
    if (!query || !log) return true;
    const q = query.toLowerCase();
    try {
      // 搜索请求内容
      if (log.request) {
        const req = log.request;
        // 搜索 messages
        if (Array.isArray(req.messages)) {
          for (const msg of req.messages) {
            if (flattenContent(msg.content).toLowerCase().includes(q)) return true;
          }
        }
        // 搜索 prompt/input
        if (req.prompt && String(req.prompt).toLowerCase().includes(q)) return true;
        if (req.input && String(req.input).toLowerCase().includes(q)) return true;
        // 搜索 model
        if (req.model && String(req.model).toLowerCase().includes(q)) return true;
      }
      // 搜索响应内容
      if (log.response && log.response.body) {
        const body = log.response.body;
        if (typeof body === 'string') {
          if (body.toLowerCase().includes(q)) return true;
        } else if (typeof body === 'object') {
          // 流式响应
          if (body.content && String(body.content).toLowerCase().includes(q)) return true;
          // choices
          if (Array.isArray(body.choices)) {
            for (const choice of body.choices) {
              if (choice.message && flattenContent(choice.message.content).toLowerCase().includes(q)) return true;
              if (choice.delta && choice.delta.content && String(choice.delta.content).toLowerCase().includes(q)) return true;
            }
          }
          // output
          if (body.output && String(body.output).toLowerCase().includes(q)) return true;
          // error
          if (body.error) {
            const errStr = typeof body.error === 'string' ? body.error : JSON.stringify(body.error);
            if (errStr.toLowerCase().includes(q)) return true;
          }
        }
      }
      // 搜索 URL
      if (log.url && log.url.toLowerCase().includes(q)) return true;
    } catch (_) {}
    return false;
  }
  function renderMessages(log, query) {
    if (!log) return '<div class="pv-empty">暂无数据</div>';
    const req = log.request;
    const resp = log.response;
    let html = '';
    if (resp) {
      const status = resp.status;
      const isError = !resp.ok || status >= 400;
      const isStream = resp.body && (resp.body._isStream || resp.body.isStream);
      const duration = log.responseTime ? ((log.responseTime - log.time) / 1000).toFixed(2) + 's' : '-';
      let infoClass = 'pv-response-info';
      if (isError) infoClass += ' pv-error';
      else if (isStream) infoClass += ' pv-stream';
      let statusText = `${status} ${escapeHTML(resp.statusText || '')}`;
      if (isStream) statusText += ' (流式)';
      html += `<div class="${infoClass}">响应状态：${statusText} · 耗时：${duration}</div>`;
      if (resp.error || (resp.body && resp.body.error)) {
        const errMsg = resp.error || (resp.body && resp.body.error.message) || JSON.stringify(resp.body.error || resp.body);
        html += `<div class="pv-error-box">❌ 错误：${escapeHTML(errMsg)}</div>`;
      }
    }
    if (log.type === 'image') {
      html += '<div class="pv-section-title">图片生成请求</div>';
      const prompt = req.prompt || req.input || '(无 prompt)';
      const text = escapeHTML(typeof prompt === 'string' ? prompt : JSON.stringify(prompt, null, 2));
      html += `<div class="pv-msg"><div class="pv-msg-head"><span class="pv-role pv-role-user">prompt</span><span class="pv-len">${prompt.length} 字</span></div><div class="pv-msg-body">${highlight(text, query)}</div></div>`;
      const params = {};
      ['model', 'size', 'quality', 'style', 'n', 'response_format'].forEach(k => {
        if (req[k] !== undefined) params[k] = req[k];
      });
      if (Object.keys(params).length > 0) {
        const paramsStr = JSON.stringify(params, null, 2);
        html += `<div class="pv-msg" style="margin-top:8px"><div class="pv-msg-head"><span class="pv-role" style="color:#666">参数</span></div><div class="pv-msg-body">${highlight(escapeHTML(paramsStr), query)}</div></div>`;
      }
    } else {
      const allMessages = normalizeMessages(req);
      const lastUserMsg = extractLastUserMessage(allMessages);
      if (lastUserMsg) {
        html += '<div class="pv-section-title">本次提问</div>';
        const role = (lastUserMsg.role || 'user').toLowerCase();
        const content = flattenContent(lastUserMsg.content);
        const text = escapeHTML(content);
        const shown = highlight(text, query);
        html += `<div class="pv-msg"><div class="pv-msg-head"><span class="pv-role pv-role-${escapeHTML(role)}">${escapeHTML(role)}</span><span class="pv-len">${content.length} 字</span></div><div class="pv-msg-body">${shown}</div></div>`;
      }
    }
    if (resp && resp.body) {
      const assistantMsg = extractAssistantMessage(resp);
      if (assistantMsg && assistantMsg.content) {
        html += '<div class="pv-section-title">助手回复</div>';
        const content = flattenContent(assistantMsg.content);
        const text = escapeHTML(content);
        const shown = highlight(text, query);
        const streamBadge = assistantMsg.isStream ? '<span class="pv-stream-badge">流式</span>' : '';
        html += `<div class="pv-msg"><div class="pv-msg-head"><span class="pv-role pv-role-assistant">assistant${streamBadge}</span><span class="pv-len">${content.length} 字</span></div><div class="pv-msg-body">${shown}</div></div>`;
      }
      if (log.type === 'image' && resp.body && resp.body.data) {
        const images = Array.isArray(resp.body.data) ? resp.body.data : [resp.body.data];
        images.forEach((img, i) => {
          if (img.url) {
            html += `<img src="${escapeHTML(img.url)}" class="pv-image-preview" alt="生成的图片 ${i + 1}" />`;
          } else if (img.b64_json) {
            html += `<img src="data:image/png;base64,${img.b64_json}" class="pv-image-preview" alt="生成的图片 ${i + 1}" />`;
          }
        });
      }
    }
    return html;
  }
  function renderJSON(log, query) {
    if (!log) return '<div class="pv-empty">暂无数据</div>';
    let responseData;
    if (log.response) {
      const body = log.response.body;
      if (body && typeof body === 'object' && (body._isStream || body.isStream)) {
        responseData = {
          status: log.response.status,
          statusText: log.response.statusText,
          ok: log.response.ok,
          body: { _isStream: true, format: body.format, chunks: body.chunks, content: body.content }
        };
      } else if (typeof body === 'string') {
        const stream = parseStreamResponse(body);
        if (stream) {
          responseData = {
            status: log.response.status,
            statusText: log.response.statusText,
            ok: log.response.ok,
            body: { _isStream: true, format: stream.format, chunks: stream.chunks, content: stream.content }
          };
        } else {
          responseData = log.response.body || log.response.error;
        }
      } else {
        responseData = log.response.body || log.response.error;
      }
    } else {
      responseData = null;
    }
    const data = { request: log.request, response: responseData };
    const json = JSON.stringify(data, null, 2);
    return `<pre class="pv-json">${highlight(escapeHTML(json), query)}</pre>`;
  }
  let isOpening = false;
  let viewLogIndex = 0;
  let currentFilter = 'chat';
  let searchQuery = '';
  function getSearchedLogs() {
    const logs = getFilteredLogs(currentFilter);
    if (!searchQuery) return logs;
    return logs.filter(log => logContainsQuery(log, searchQuery));
  }
  function getViewLog() {
    const logs = getSearchedLogs();
    if (logs.length === 0) return null;
    return logs[Math.max(0, Math.min(viewLogIndex, logs.length - 1))];
  }
  function openViewer() {
    if (document.getElementById('pv-mask')) return;
    if (isOpening) return;
    isOpening = true;
    setTimeout(() => { isOpening = false; }, 500);
    closeViewer();
    injectStyle();
    const logs = getFilteredLogs('chat');
    // 默认显示最新日志（索引0），但页码显示为最后一页
    viewLogIndex = 0;
    currentFilter = 'chat';
    searchQuery = '';
    const log = logs.length > 0 ? logs[0] : null;
    const mask = document.createElement('div');
    mask.className = 'pv-mask';
    mask.id = 'pv-mask';
    mask.innerHTML = `
      <div class="pv-modal" role="dialog">
        <div class="pv-head">
          <div>
            <h3>请求日志</h3>
            <div class="pv-meta">${log ? escapeHTML(`${log.time.toLocaleTimeString()} · ${(log.url || '').split('?')[0].split('/').pop() || '请求'}`) : '尚无捕获 — 先发一条消息再回来看'}</div>
          </div>
          <button class="pv-close" aria-label="关闭">×</button>
        </div>
        <div class="pv-log-nav">
          <button data-nav="prev" ${logs.length <= 1 ? 'disabled' : ''}>← 更早</button>
          <span class="pv-log-info" id="pv-log-info">
            <input type="number" id="pv-page-input" min="1" max="${logs.length || 1}" value="${logs.length > 0 ? logs.length : 1}" />
            <span id="pv-page-sep">/</span>
            <span id="pv-page-total">${logs.length}</span>
          </span>
          <button data-nav="next" ${logs.length <= 1 ? 'disabled' : ''}>更新 →</button>
          <div class="pv-type-filter">
            <button data-filter="chat" class="${currentFilter === 'chat' ? 'pv-active' : ''}">聊天</button>
            <button data-filter="image" class="${currentFilter === 'image' ? 'pv-active' : ''}">图片</button>
            <button data-filter="all" class="${currentFilter === 'all' ? 'pv-active' : ''}">全部</button>
          </div>
        </div>
        <div class="pv-tabs">
          <button data-tab="msg" class="pv-active">消息视图</button>
          <button data-tab="json">原始 JSON</button>
        </div>
        <div class="pv-tools">
          <input type="text" placeholder="搜索关键词（在所有日志中搜索）..." />
          <button data-act="clear" class="pv-danger">清空</button>
        </div>
        <div class="pv-body" id="pv-body"></div>
      </div>`;
    document.body.appendChild(mask);
    let tab = 'msg';
    let query = '';
    let searchDebounce = null;
    function rerender() {
      const logs = getSearchedLogs();
      const total = logs.length;
      // viewLogIndex 是数组索引，0 是最新
      if (viewLogIndex >= total) viewLogIndex = Math.max(0, total - 1);
      if (viewLogIndex < 0) viewLogIndex = 0;
      const log = total > 0 ? logs[viewLogIndex] : null;
      const el = mask.querySelector('#pv-body');
      // 页码显示：最新日志对应 total，最旧对应 1
      const pageNumber = total > 0 ? total - viewLogIndex : 0;
      const prevBtn = mask.querySelector('[data-nav="prev"]');
      const nextBtn = mask.querySelector('[data-nav="next"]');
      // prev：更早（索引+1），next：更新（索引-1）
      if (prevBtn) prevBtn.disabled = total <= 1 || viewLogIndex >= total - 1;
      if (nextBtn) nextBtn.disabled = total <= 1 || viewLogIndex <= 0;
      mask.querySelectorAll('[data-filter]').forEach(b => {
        b.classList.toggle('pv-active', b.dataset.filter === currentFilter);
      });
      const pageInput = mask.querySelector('#pv-page-input');
      if (pageInput) {
        pageInput.max = total;
        pageInput.value = pageNumber > 0 ? pageNumber : '';
      }
      const pageTotal = mask.querySelector('#pv-page-total');
      if (pageTotal) {
        const allLogs = getFilteredLogs(currentFilter);
        if (searchQuery) {
          pageTotal.textContent = `${total} / ${allLogs.length}`;
        } else {
          pageTotal.textContent = total;
        }
      }
      const metaEl = mask.querySelector('.pv-meta');
      if (metaEl) {
        if (log) {
          metaEl.textContent = log.time.toLocaleTimeString() + ' · ' + ((log.url || '').split('?')[0].split('/').pop() || '请求');
        } else {
          metaEl.textContent = searchQuery ? '没有找到匹配的日志' : '尚无捕获 — 先发一条消息再回来看';
        }
      }
      if (!log) {
        const filterText = currentFilter === 'chat' ? '聊天' : currentFilter === 'image' ? '图片生成' : '';
        el.innerHTML = `<div class="pv-empty">${searchQuery ? '没有找到匹配的日志' : `暂无${filterText}日志。<br>发一条消息后，回到这里就能看到。`}</div>`;
        return;
      }
      el.innerHTML = tab === 'msg' ? renderMessages(log, query) : renderJSON(log, query);
    }
    rerender();
    mask.querySelector('.pv-close').addEventListener('click', closeViewer);
    mask.addEventListener('click', e => { if (e.target === mask) closeViewer(); });
    mask.querySelectorAll('.pv-tabs button').forEach(b => {
      b.addEventListener('click', () => {
        mask.querySelectorAll('.pv-tabs button').forEach(x => x.classList.remove('pv-active'));
        b.classList.add('pv-active');
        tab = b.dataset.tab;
        rerender();
      });
    });
    mask.querySelectorAll('[data-filter]').forEach(b => {
      b.addEventListener('click', () => {
        currentFilter = b.dataset.filter;
        viewLogIndex = 0;
        rerender();
      });
    });
    mask.querySelectorAll('[data-nav]').forEach(b => {
      b.addEventListener('click', () => {
        const action = b.dataset.nav;
        const logs = getSearchedLogs();
        const total = logs.length;
        if (action === 'prev' && viewLogIndex < total - 1) {
          viewLogIndex++;
        } else if (action === 'next' && viewLogIndex > 0) {
          viewLogIndex--;
        }
        rerender();
      });
    });
    const pageInput = mask.querySelector('#pv-page-input');
    if (pageInput) {
      pageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const val = parseInt(pageInput.value, 10);
          const logs = getSearchedLogs();
          const total = logs.length;
          // 页码 val 对应数组索引 total - val
          if (val >= 1 && val <= total) {
            viewLogIndex = total - val;
            rerender();
          }
        }
      });
      pageInput.addEventListener('click', () => { pageInput.select(); });
      pageInput.addEventListener('blur', () => {
        const val = parseInt(pageInput.value, 10);
        const logs = getSearchedLogs();
        const total = logs.length;
        const expectedPage = total > 0 ? total - viewLogIndex : 0;
        if (val >= 1 && val <= total && val !== expectedPage) {
          viewLogIndex = total - val;
          rerender();
        }
      });
    }
    const search = mask.querySelector('input[type="text"]');
    search.addEventListener('input', () => {
      if (searchDebounce) clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        query = search.value.trim();
        searchQuery = query;
        viewLogIndex = 0;
        rerender();
      }, 300);
    });
    mask.querySelector('[data-act="clear"]').addEventListener('click', () => {
      const filterText = currentFilter === 'chat' ? '聊天' : currentFilter === 'image' ? '图片生成' : '所有';
      if (confirm(`确定要清空当前会话的${filterText}日志吗？`)) {
        if (currentFilter === 'all') {
          const sid = getSessionId();
          LOGS_STATE.sessions[sid] = [];
        } else {
          const sid = getSessionId();
          LOGS_STATE.sessions[sid] = LOGS_STATE.sessions[sid].filter(l => l.type !== currentFilter);
        }
        viewLogIndex = 0;
        rerender();
      }
    });
    document.addEventListener('keydown', escClose);
  }
  function closeViewer() {
    const m = document.getElementById('pv-mask');
    if (m) m.remove();
    document.removeEventListener('keydown', escClose);
  }
  function escClose(e) { if (e.key === 'Escape') closeViewer(); }
  const EYE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>`;
  function handleButtonClick(e) {
    e.preventDefault();
    e.stopPropagation();
    openViewer();
  }
  function getScopeAttr(el) {
    if (!el) return null;
    for (const a of el.attributes) {
      if (a.name.startsWith('data-v-')) return a.name;
    }
    return null;
  }
  function buildButton() {
    const sample = document.querySelector('.settings-btn');
    let btn;
    if (sample) {
      btn = sample.cloneNode(true);
      btn.setAttribute(BTN_FLAG, '1');
      if (btn.tagName.toLowerCase() === 'button') {
        btn.style.border = 'none';
        btn.style.background = 'transparent';
        btn.style.padding = '0';
      } else {
        btn.style.border = 'none';
        btn.style.outline = 'none';
      }
      const iconWrap = btn.querySelector('div');
      if (iconWrap) {
        iconWrap.innerHTML = EYE_SVG;
        iconWrap.className += ' pv-icon-wrap';
        const scopeAttr = getScopeAttr(iconWrap);
        const svg = iconWrap.querySelector('svg');
        if (svg && scopeAttr) svg.setAttribute(scopeAttr, '');
      }
      const label = btn.querySelector('span');
      if (label) {
        label.textContent = '日志';
        label.style.whiteSpace = 'nowrap';
      }
    } else {
      btn = document.createElement('div');
      btn.className = 'settings-btn';
      btn.setAttribute(BTN_FLAG, '1');
      btn.innerHTML = `<div class="pv-icon-wrap">${EYE_SVG}</div><span style="white-space:nowrap;">日志</span>`;
      btn.style.display = 'flex';
      btn.style.flexDirection = 'column';
      btn.style.alignItems = 'center';
      btn.style.justifyContent = 'center';
      btn.style.gap = '6px';
    }
    btn.removeEventListener('click', handleButtonClick);
    btn.addEventListener('click', handleButtonClick);
    return btn;
  }
  let injectTimer = null;
  function tryInjectDebounced() {
    if (injectTimer) {
      clearTimeout(injectTimer);
      injectTimer = null;
    }
    injectTimer = setTimeout(() => {
      tryInject();
      injectTimer = null;
    }, 100);
  }
  function tryInject() {
    const labels = document.querySelectorAll('.menu-label');
    labels.forEach(lbl => {
      if (lbl.textContent.trim() !== '聊天操作') return;
      let grid = lbl.nextElementSibling;
      while (grid && !grid.classList.contains('settings-grid')) grid = grid.nextElementSibling;
      if (!grid) return;
      if (grid.querySelector(`[${BTN_FLAG}]`)) return;
      grid.appendChild(buildButton());
    });
  }
  function forceInject() {
    tryInject();
  }
  const observer = new MutationObserver(tryInjectDebounced);
  function start() {
    observer.observe(document.body, { childList: true, subtree: true });
    tryInject();
    window.addEventListener('popstate', forceInject);
    window.addEventListener('hashchange', forceInject);
    setTimeout(forceInject, 2000);
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
  window.__requestLogger = {
    open: openViewer,
    logs: LOGS_STATE,
    getFilteredLogs,
    parseStreamResponse,
    get filter() { return currentFilter; },
    set filter(v) { currentFilter = v; }
  };
})();
