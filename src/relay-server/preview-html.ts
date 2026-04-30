const ROOT_RELATIVE_ATTRIBUTE_PATTERN = /\b(src|href|action)=([\"'])\/(?!\/|[a-zA-Z][a-zA-Z0-9+.-]*:)([^\"']+)\2/g;
const RELATIVE_ATTRIBUTE_PATTERN = /\b(src|href|action)=([\"'])(?!\/|#|[a-zA-Z][a-zA-Z0-9+.-]*:)([^\"']+)\2/g;
const ROOT_RELATIVE_IMPORT_PATTERN = /\b(import\s*(?:\([^)]*)?|from\s*)([\"'])\/(?!\/|[a-zA-Z][a-zA-Z0-9+.-]*:)([^\"']+)\2/g;
const ROOT_RELATIVE_STRING_PATTERN = /([\"'`])\/(?!\/|[a-zA-Z][a-zA-Z0-9+.-]*:)([^\"'`\s)]+)\1/g;
const ROOT_RELATIVE_CSS_URL_PATTERN = /url\((["']?)\/(?!\/|[a-zA-Z][a-zA-Z0-9+.-]*:)([^"')]+)\1\)/g;
const PREVIEW_BRIDGE_MARKER = 'data-relay-preview-bridge';

function withPreviewAuth(url: string, authQuery = ''): string {
  if (!authQuery) return url;
  const hashIndex = url.indexOf('#');
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
  return `${withoutHash}${withoutHash.includes('?') ? '&' : '?'}${authQuery}${hash}`;
}

function toPreviewUrl(baseHref: string, value: string, authQuery = ''): string {
  const path = value.startsWith(baseHref) ? value : `${baseHref}${value.replace(/^\/+/, '')}`;
  return withPreviewAuth(path, authQuery);
}

const PREVIEW_BRIDGE_SCRIPT = `<script ${PREVIEW_BRIDGE_MARKER}>
(() => {
  if (window.__relayPreviewBridgeInstalled) return;
  window.__relayPreviewBridgeInstalled = true;

  const serialize = (value) => {
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    if (value instanceof Response) return { status: value.status, statusText: value.statusText, url: value.url, ok: value.ok };
    if (value instanceof Request) return { method: value.method, url: value.url };
    if (value instanceof Element) return value.outerHTML;
    try {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  };

  const emit = (payload) => {
    try {
      window.parent?.postMessage({
        type: 'relay-preview-event',
        source: 'relay-preview',
        href: window.location.href,
        timestamp: Date.now(),
        ...payload,
      }, '*');
    } catch {
      // Ignore postMessage failures in restricted preview contexts.
    }
  };

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level];
    console[level] = (...args) => {
      emit({ kind: 'console', level, args: args.map(serialize) });
      original.apply(console, args);
    };
  }

  window.addEventListener('error', (event) => {
    emit({
      kind: 'error',
      level: 'error',
      args: [event.message],
      stack: event.error?.stack,
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    emit({
      kind: 'error',
      level: 'error',
      args: ['Unhandled promise rejection', serialize(event.reason)],
      stack: event.reason?.stack,
    });
  });

  window.addEventListener('error', (event) => {
    const target = event.target;
    if (!target || target === window) return;
    const url = target.currentSrc || target.src || target.href || '';
    emit({
      kind: 'network',
      level: 'error',
      method: 'GET',
      url,
      status: 0,
      statusText: 'Resource failed to load',
      args: ['Failed to load resource', url],
    });
  }, true);

  if ('PerformanceObserver' in window) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const status = entry.responseStatus;
          if (typeof status === 'number' && status >= 400) {
            emit({
              kind: 'network',
              level: 'error',
              method: 'GET',
              url: entry.name,
              status,
              statusText: 'Resource failed to load',
              durationMs: Math.round(entry.duration),
            });
          }
        }
      });
      observer.observe({ type: 'resource', buffered: true });
    } catch {
      // Older browsers do not expose resource timing status.
    }
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async (...args) => {
      const startedAt = performance.now();
      const url = args[0] instanceof Request ? args[0].url : String(args[0]);
      const method = args[0] instanceof Request ? args[0].method : args[1]?.method || 'GET';
      try {
        const response = await originalFetch(...args);
        emit({
          kind: 'network',
          level: response.ok ? 'info' : 'error',
          method,
          url,
          status: response.status,
          statusText: response.statusText,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return response;
      } catch (error) {
        emit({
          kind: 'network',
          level: 'error',
          method,
          url,
          error: serialize(error),
          durationMs: Math.round(performance.now() - startedAt),
        });
        throw error;
      }
    };
  }

  const OriginalXHR = window.XMLHttpRequest;
  if (typeof OriginalXHR === 'function') {
    window.XMLHttpRequest = function RelayXMLHttpRequest() {
      const xhr = new OriginalXHR();
      let method = 'GET';
      let url = '';
      let startedAt = 0;
      const open = xhr.open;
      xhr.open = function patchedOpen(nextMethod, nextUrl, ...rest) {
        method = nextMethod;
        url = String(nextUrl);
        return open.call(xhr, nextMethod, nextUrl, ...rest);
      };
      xhr.addEventListener('loadstart', () => { startedAt = performance.now(); });
      xhr.addEventListener('loadend', () => {
        emit({
          kind: 'network',
          level: xhr.status >= 400 ? 'error' : 'info',
          method,
          url,
          status: xhr.status,
          statusText: xhr.statusText,
          durationMs: Math.round(performance.now() - startedAt),
        });
      });
      return xhr;
    };
  }
})();</script>`;

export function rewritePreviewHtml(html: string, baseHref: string): string {
  return rewritePreviewHtmlWithAuth(html, baseHref, '');
}

export function rewritePreviewHtmlWithAuth(html: string, baseHref: string, authQuery = ''): string {
  const rewritten = html
    .replace(ROOT_RELATIVE_ATTRIBUTE_PATTERN, (_match, attr: string, quote: string, value: string) =>
      `${attr}=${quote}${toPreviewUrl(baseHref, value, authQuery)}${quote}`)
    .replace(RELATIVE_ATTRIBUTE_PATTERN, (_match, attr: string, quote: string, value: string) =>
      `${attr}=${quote}${toPreviewUrl(baseHref, value, authQuery)}${quote}`)
    .replace(ROOT_RELATIVE_IMPORT_PATTERN, (_match, prefix: string, quote: string, value: string) =>
      `${prefix}${quote}${toPreviewUrl(baseHref, value, authQuery)}${quote}`);

  const withBase = /<base\s+href=/i.test(rewritten)
    ? rewritten.replace(/<base\s+href=(["'])[^"']*\1\s*\/?>/i, `<base href="${baseHref}">`)
    : rewritten.replace(/<head([^>]*)>/i, `<head$1><base href="${baseHref}">`);

  if (withBase.includes(PREVIEW_BRIDGE_MARKER)) {
    return withBase;
  }

  if (/<\/head>/i.test(withBase)) {
    return withBase.replace(/<\/head>/i, `${PREVIEW_BRIDGE_SCRIPT}</head>`);
  }

  return `${PREVIEW_BRIDGE_SCRIPT}${withBase}`;
}

export function rewritePreviewText(text: string, baseHref: string): string {
  return rewritePreviewTextWithAuth(text, baseHref, '');
}

export function rewritePreviewTextWithAuth(text: string, baseHref: string, authQuery = ''): string {
  return text
    .replace(ROOT_RELATIVE_STRING_PATTERN, (_match, quote: string, value: string) =>
      `${quote}${toPreviewUrl(baseHref, value, authQuery)}${quote}`)
    .replace(ROOT_RELATIVE_CSS_URL_PATTERN, (_match, quote: string, value: string) =>
      `url(${quote}${toPreviewUrl(baseHref, value, authQuery)}${quote})`);
}
