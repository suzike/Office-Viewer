// Script injected into HTML preview documents served over the office-html: protocol.
// It forwards console output, uncaught errors, resource entries and paint metrics
// to the host window via postMessage so the viewer can render debug panels, and it
// hosts the preview simulations (color scheme emulation, in-page find highlight).
// The preview CSP already allows 'unsafe-inline' scripts, and the script must not
// contain a literal closing script tag.
//
// Note: the sandboxed preview runs in an opaque origin where Chromium does not
// record PerformanceResourceTiming entries, so the resource list is rebuilt from
// a DOM scan plus cache-hit probe fetches (size) and MutationObserver/load-event
// timestamps (start/duration for the waterfall view) as a fallback.
export const HTML_INSPECTOR_SOURCE = `(function () {
  if (window.__officeHtmlInspector) return;
  window.__officeHtmlInspector = true;
  var post = function (payload) {
    try { window.parent.postMessage(Object.assign({ source: 'office-html-inspector' }, payload), '*'); } catch (error) { void error; }
  };
  var stringify = function (value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || value.message;
    try { return JSON.stringify(value); } catch (error) { void error; return String(value); }
  };
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var original = typeof console[level] === 'function' ? console[level].bind(console) : function () {};
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      post({ type: 'console', level: level, text: args.map(stringify).join(' ') });
      original.apply(null, args);
    };
  });
  window.addEventListener('error', function (event) {
    if (event.target && event.target !== window) return;
    post({ type: 'console', level: 'error', text: event.message + ' @ ' + (event.filename || 'inline') + ':' + event.lineno + ':' + event.colno });
  });
  window.addEventListener('unhandledrejection', function (event) {
    post({ type: 'console', level: 'error', text: 'Unhandled rejection: ' + stringify(event.reason) });
  });
  var RESOURCE_SELECTOR = 'link[href], script[src], img[src], source[src], video[src], audio[src], track[src], embed[src], object[data]';
  var nodeUrl = function (node) { return node.src || node.href || node.data || ''; };
  var failedResources = {};
  var resourceTiming = {};
  var recordResourceSeen = function (node) {
    var url = nodeUrl(node);
    if (url && !resourceTiming[url]) resourceTiming[url] = { start: performance.now(), end: 0 };
  };
  document.addEventListener('error', function (event) {
    var target = event.target;
    if (target && target !== window) {
      var url = nodeUrl(target);
      if (url) {
        failedResources[url] = true;
        recordResourceSeen(target);
        resourceTiming[url].end = performance.now();
      }
    }
  }, true);
  document.addEventListener('load', function (event) {
    var target = event.target;
    if (target && target !== window) {
      var url = nodeUrl(target);
      if (url) {
        recordResourceSeen(target);
        resourceTiming[url].end = performance.now();
      }
    }
  }, true);
  try {
    document.querySelectorAll(RESOURCE_SELECTOR).forEach(recordResourceSeen);
    new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;
          if (node.matches && node.matches(RESOURCE_SELECTOR)) recordResourceSeen(node);
          if (node.querySelectorAll) node.querySelectorAll(RESOURCE_SELECTOR).forEach(recordResourceSeen);
        });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (error) { void error; }
  var metrics = { dcl: 0, fcp: 0, lcp: 0, resourceCount: 0, resourceBytes: 0 };
  var sendMetrics = function (entries) {
    if (entries) {
      metrics.resourceCount = entries.length;
      metrics.resourceBytes = entries.reduce(function (total, entry) { return total + (entry.size || 0); }, 0);
    }
    post({ type: 'metrics', metrics: metrics });
  };
  var probeResource = function (entry) {
    var started = performance.now();
    return fetch(entry.name, { cache: 'force-cache' }).then(function (response) {
      return response.blob().then(function (blob) {
        entry.size = blob.size;
        if (!entry.duration) entry.duration = Math.round((performance.now() - started) * 10) / 10;
        entry.status = response.ok ? '已加载' : '失败';
      });
    }).catch(function () { void 0; });
  };
  var scanResources = function () {
    var entries = [];
    var seen = {};
    document.querySelectorAll(RESOURCE_SELECTOR).forEach(function (node) {
      var url = nodeUrl(node);
      if (!url || seen[url]) return;
      seen[url] = true;
      var kind = node.tagName.toLowerCase();
      if (kind === 'link') kind = (node.rel || 'link').toLowerCase();
      var failed = !!failedResources[url] || (kind === 'img' && node.complete && node.naturalWidth === 0);
      var timing = resourceTiming[url];
      entries.push({
        name: url,
        kind: kind,
        size: 0,
        start: timing ? Math.round(timing.start * 10) / 10 : 0,
        duration: timing && timing.end ? Math.round((timing.end - timing.start) * 10) / 10 : 0,
        status: failed ? '失败' : '已加载',
      });
    });
    return entries;
  };
  var collectResources = function () {
    var timed = performance.getEntriesByType('resource');
    if (timed.length) {
      var timedEntries = timed.map(function (entry) {
        return {
          name: entry.name,
          kind: entry.initiatorType,
          size: entry.transferSize || entry.encodedBodySize || 0,
          start: Math.round(entry.startTime * 10) / 10,
          duration: Math.round(entry.duration * 10) / 10,
          status: '已加载',
        };
      });
      post({ type: 'resources', entries: timedEntries });
      sendMetrics(timedEntries);
      return;
    }
    var entries = scanResources();
    var probes = entries
      .filter(function (entry) { return entry.name.indexOf(location.protocol) === 0; })
      .map(probeResource);
    Promise.race([
      Promise.all(probes),
      new Promise(function (resolve) { setTimeout(resolve, 15000); }),
    ]).then(function () {
      post({ type: 'resources', entries: entries });
      sendMetrics(entries);
    });
  };
  document.addEventListener('DOMContentLoaded', function () {
    metrics.dcl = Math.round(performance.now() * 10) / 10;
    sendMetrics();
  });
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        if (entry.name === 'first-contentful-paint') metrics.fcp = Math.round(entry.startTime * 10) / 10;
      });
      sendMetrics();
    }).observe({ type: 'paint', buffered: true });
  } catch (error) { void error; }
  try {
    new PerformanceObserver(function (list) {
      var entries = list.getEntries();
      if (entries.length) metrics.lcp = Math.round(entries[entries.length - 1].startTime * 10) / 10;
      sendMetrics();
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (error) { void error; }
  window.addEventListener('load', function () { collectResources(); });
  var selectionTimer = 0;
  var reportSelection = function () {
    var text = '';
    var rect = null;
    try {
      var selection = window.getSelection();
      text = selection ? String(selection).trim() : '';
      if (text && selection.rangeCount) {
        var bounds = selection.getRangeAt(0).getBoundingClientRect();
        rect = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
      }
    } catch (error) { void error; }
    post({ type: 'selection', text: text.slice(0, 16000), rect: rect });
  };
  document.addEventListener('selectionchange', function () {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(reportSelection, 150);
  });
  // Color scheme emulation: rewrite prefers-color-scheme media queries (which
  // cannot be forced from inside the page) and patch matchMedia accordingly.
  var schemeState = { mode: 'system', originals: [], matchMedia: window.matchMedia ? window.matchMedia.bind(window) : null };
  var rewriteSchemeMedia = function (css, mode) {
    return css.replace(/\\(\\s*prefers-color-scheme\\s*:\\s*(dark|light)\\s*\\)/gi, function (match, value) {
      return value.toLowerCase() === mode ? 'all' : 'not all';
    });
  };
  var restoreColorScheme = function () {
    if (schemeState.mode === 'system') return;
    schemeState.mode = 'system';
    if (schemeState.matchMedia) window.matchMedia = schemeState.matchMedia;
    document.documentElement.style.colorScheme = '';
    schemeState.originals.forEach(function (item) {
      if (item.css !== undefined) item.node.textContent = item.css;
      if (item.replacement) item.replacement.remove();
      if (item.disabled !== undefined) item.node.disabled = item.disabled;
    });
    schemeState.originals = [];
  };
  var applyColorScheme = function (mode) {
    restoreColorScheme();
    if (mode !== 'light' && mode !== 'dark') { post({ type: 'scheme-applied', mode: 'system' }); return; }
    schemeState.mode = mode;
    if (schemeState.matchMedia) {
      window.matchMedia = function (query) {
        return schemeState.matchMedia(rewriteSchemeMedia(String(query), mode));
      };
    }
    document.documentElement.style.colorScheme = mode;
    var tasks = [];
    document.querySelectorAll('style, link[rel~="stylesheet"][href]').forEach(function (node) {
      if (node.tagName === 'STYLE') {
        var css = node.textContent || '';
        if (!/prefers-color-scheme/i.test(css)) return;
        schemeState.originals.push({ node: node, css: css });
        node.textContent = rewriteSchemeMedia(css, mode);
        return;
      }
      var href = node.href || '';
      if (!href || href.indexOf(location.protocol) !== 0) return;
      tasks.push(fetch(href, { cache: 'force-cache' }).then(function (response) { return response.text(); }).then(function (css) {
        if (!/prefers-color-scheme/i.test(css)) return;
        var replacement = document.createElement('style');
        replacement.textContent = rewriteSchemeMedia(css, mode);
        node.parentNode.insertBefore(replacement, node.nextSibling);
        schemeState.originals.push({ node: node, disabled: node.disabled, replacement: replacement });
        node.disabled = true;
      }).catch(function () { void 0; }));
    });
    Promise.all(tasks).then(function () { post({ type: 'scheme-applied', mode: mode }); });
  };
  // In-page find: wrap matches in marks, track the current hit and report counts.
  var findState = { hits: [], current: -1 };
  var findStyle = document.createElement('style');
  findStyle.textContent = 'mark[data-office-find]{background:#ffe58f;color:inherit;padding:0;}mark[data-office-find].office-html-find-hit--current{background:#ffa940;outline:1px solid #d48806;}';
  (document.head || document.documentElement).appendChild(findStyle);
  var clearFind = function () {
    findState.hits.forEach(function (mark) {
      if (mark.parentNode) {
        mark.parentNode.replaceChild(document.createTextNode(mark.textContent), mark);
      }
    });
    document.body && document.body.normalize();
    findState.hits = [];
    findState.current = -1;
  };
  var postFindResult = function () {
    post({ type: 'find-result', count: findState.hits.length, current: findState.current + 1 });
  };
  var setFindCurrent = function (index) {
    if (!findState.hits.length) { findState.current = -1; postFindResult(); return; }
    var total = findState.hits.length;
    findState.current = ((index % total) + total) % total;
    findState.hits.forEach(function (mark, at) {
      mark.classList.toggle('office-html-find-hit--current', at === findState.current);
    });
    var hit = findState.hits[findState.current];
    if (hit.scrollIntoView) hit.scrollIntoView({ block: 'center' });
    postFindResult();
  };
  var runFind = function (query) {
    clearFind();
    if (!query || !document.body) { postFindResult(); return; }
    var lower = query.toLowerCase();
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || node.nodeValue.toLowerCase().indexOf(lower) < 0) return NodeFilter.FILTER_REJECT;
        var parent = node.parentNode;
        if (!parent || /^(script|style|noscript|mark)$/i.test(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    var nodes = [];
    while (walker.nextNode() && nodes.length < 200) nodes.push(walker.currentNode);
    nodes.forEach(function (node) {
      var text = node.nodeValue;
      var lowerText = text.toLowerCase();
      var fragment = document.createDocumentFragment();
      var at = 0;
      var index;
      while ((index = lowerText.indexOf(lower, at)) >= 0 && findState.hits.length < 500) {
        if (index > at) fragment.appendChild(document.createTextNode(text.slice(at, index)));
        var mark = document.createElement('mark');
        mark.setAttribute('data-office-find', '');
        mark.textContent = text.slice(index, index + query.length);
        fragment.appendChild(mark);
        findState.hits.push(mark);
        at = index + query.length;
      }
      if (at < text.length) fragment.appendChild(document.createTextNode(text.slice(at)));
      if (node.parentNode) node.parentNode.replaceChild(fragment, node);
    });
    setFindCurrent(0);
  };
  window.addEventListener('keydown', function (event) {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key === 'f' || event.key === 'F')) {
      event.preventDefault();
      post({ type: 'open-find' });
    }
  });
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.source !== 'office-html-host') return;
    if (data.type === 'collect-resources') collectResources();
    else if (data.type === 'set-color-scheme') applyColorScheme(String(data.mode || 'system'));
    else if (data.type === 'find') runFind(String(data.query || ''));
    else if (data.type === 'find-step') setFindCurrent(findState.current + (data.delta === -1 ? -1 : 1));
    else if (data.type === 'find-close') { clearFind(); postFindResult(); }
  });
})();`

const HTML_NOSCRIPT_STYLE = '<style>noscript{display:block!important}</style>'

export function injectHtmlInspector(html: string): string {
  return injectIntoHead(html, `<script>${HTML_INSPECTOR_SOURCE}</script>`)
}

// Used when the preview is reloaded with scripting disabled: noscript elements
// are not revealed by a CSP script block, so reveal them with plain CSS.
export function injectNoscriptStyle(html: string): string {
  return injectIntoHead(html, HTML_NOSCRIPT_STYLE)
}

function injectIntoHead(html: string, snippet: string): string {
  const headMatch = /<head(?:\s[^>]*)?>/i.exec(html)
  if (headMatch) {
    const at = headMatch.index + headMatch[0].length
    return `${html.slice(0, at)}${snippet}${html.slice(at)}`
  }
  const doctypeMatch = /^\s*<!doctype[^>]*>/i.exec(html)
  if (doctypeMatch) {
    return `${doctypeMatch[0]}${snippet}${html.slice(doctypeMatch[0].length)}`
  }
  return `${snippet}${html}`
}
