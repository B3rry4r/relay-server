import { describe, expect, it } from 'vitest';
import { rewritePreviewHtml, rewritePreviewHtmlWithAuth, rewritePreviewText } from '../src/relay-server/preview-html';
import { shouldBypassPreviewTextRewrite, shouldRewritePreviewResponse } from '../src/relay-server/core-routes';

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
    expect(html).toContain('Node.prototype.appendChild = function relayAppendChild(child)');
    expect(html).toContain('Element.prototype.append = function relayAppend(...nodes)');
  });

  it('keeps auth on browser-managed preview assets', () => {
    const html = rewritePreviewHtmlWithAuth(`
      <html>
        <head>
          <link rel="manifest" href="manifest.json" />
          <script src="/src/main.tsx"></script>
        </head>
      </html>
    `, '/preview/5179/', 'token=test-token');

    expect(html).toContain('href="/preview/5179/manifest.json?token=test-token"');
    expect(html).toContain('src="/preview/5179/src/main.tsx?token=test-token"');
    expect(html).toContain('const relayPreviewAuthQuery = "token=test-token"');
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

  it('streams Flutter debug runtime files without preview text rewriting', () => {
    expect(shouldBypassPreviewTextRewrite('/dart_sdk.js')).toBe(true);
    expect(shouldBypassPreviewTextRewrite('/ddc_module_loader.js')).toBe(true);
    expect(shouldBypassPreviewTextRewrite('/dwds/src/injected/client.js')).toBe(true);
    expect(shouldBypassPreviewTextRewrite('/src/main.tsx')).toBe(false);
    expect(shouldBypassPreviewTextRewrite('/@vite/client')).toBe(false);
  });

  it('does not rewrite generated JavaScript for active Flutter debug previews', () => {
    expect(shouldRewritePreviewResponse('text/html; charset=utf-8', '/', true)).toBe(true);
    expect(shouldRewritePreviewResponse('application/javascript', '/packages/app/main.dart.lib.js', true)).toBe(false);
    expect(shouldRewritePreviewResponse('application/javascript', '/src/main.tsx', false)).toBe(true);
  });
});
