import { describe, expect, it } from 'vitest';
import * as previewHtml from '../src/relay-server/preview-html';
import { rewritePreviewHtml, rewritePreviewText } from '../src/relay-server/preview-html';

describe('preview HTML rewriting', () => {
  it('routes Vite HTML assets and inline module imports through the preview base', () => {
    const html = rewritePreviewHtml(`
      <html>
        <head>
          <script type="module">import { injectIntoGlobalHook } from "/@react-refresh";</script>
          <script type="module" src="/@vite/client"></script>
          <link rel="icon" href="/app_logo_2.svg" />
          <link rel="manifest" href="manifest.json" />
        </head>
        <body>
          <form action="/submit"></form>
          <script type="module" src="/src/main.tsx"></script>
        </body>
      </html>
    `, '/preview/5179/');

    expect(html).toContain('<head><base href="/preview/5179/">');
    expect(html).toContain('from "/preview/5179/@react-refresh"');
    expect(html).toContain('src="/preview/5179/@vite/client"');
    expect(html).toContain('href="/preview/5179/app_logo_2.svg"');
    expect(html).toContain('href="/preview/5179/manifest.json"');
    expect(html).toContain('action="/preview/5179/submit"');
    expect(html).toContain('src="/preview/5179/src/main.tsx"');
    expect(html).toContain('data-relay-preview-bridge');
    expect(html).toContain("window.fetch = async (...args)");
    expect(html).toContain('window.XMLHttpRequest = function RelayXMLHttpRequest()');
    expect(html).toContain("statusText: 'Resource failed to load'");
    // The bridge only reports to the parent; it no longer patches DOM insertion to
    // rewrite URLs (that existed solely to append ?token=).
    expect(html).not.toContain('Node.prototype.appendChild');
    expect(html).not.toContain('Element.prototype.setAttribute =');
  });

  it('never injects query-string auth; a path capability in <base href> carries access instead', () => {
    // audit §6 item 23: the ?token= rewriting (withPreviewAuth / relayPreviewAuthQuery)
    // is gone. The capability lives in the path, so <base href> hands it to every
    // relative asset, including DDC's dynamically inserted scripts.
    const base = '/flutter-preview/demo/c/lz3k9q0.0b7c1d2e-1111-4222-8333-944445555666.AbCdEfGhIjKlMnOpQrStUv/';
    const html = rewritePreviewHtml(`
      <html>
        <head>
          <base href="/">
          <link rel="manifest" href="manifest.json" />
          <script src="flutter_bootstrap.js" async></script>
        </head>
      </html>
    `, base);

    expect(html).toContain(`<base href="${base}">`);
    expect(html).toContain(`href="${base}manifest.json"`);
    expect(html).toContain(`src="${base}flutter_bootstrap.js"`);
    expect(html).not.toMatch(/token=/);
    expect(html).not.toContain('relayPreviewAuthQuery');
    expect(Object.keys(previewHtml)).not.toContain('rewritePreviewHtmlWithAuth');
    expect(Object.keys(previewHtml)).not.toContain('rewritePreviewTextWithAuth');
  });

  it('routes Vite module imports through the preview path', () => {
    const script = rewritePreviewText(`
      import React from "/node_modules/.vite/deps/react.js?v=123";
      import "/src/index.css";
      const logo = "/app_logo_2.svg";
      navigator.serviceWorker.register('/sw.js');
    `, '/preview/5179/');

    expect(script).toContain('from "/preview/5179/node_modules/.vite/deps/react.js?v=123"');
    expect(script).toContain('import "/preview/5179/src/index.css"');
    expect(script).toContain('"/preview/5179/app_logo_2.svg"');
    expect(script).toContain("register('/preview/5179/sw.js')");
  });
});
