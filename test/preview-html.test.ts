import { describe, expect, it } from 'vitest';
import { rewritePreviewHtml, rewritePreviewText } from '../src/relay-server/preview-html';

describe('preview HTML rewriting', () => {
  it('routes Vite HTML assets and inline module imports through the preview base', () => {
    const html = rewritePreviewHtml(`
      <html>
        <head>
          <script type="module">import { injectIntoGlobalHook } from "/@react-refresh";</script>
          <script type="module" src="/@vite/client"></script>
          <link rel="icon" href="/app_logo_2.svg" />
        </head>
        <body>
          <form action="/submit"></form>
          <script type="module" src="/src/main.tsx"></script>
        </body>
      </html>
    `, '/preview/5179/');

    expect(html).toContain('<head><base href="/preview/5179/">');
    expect(html).toContain('from "@react-refresh"');
    expect(html).toContain('src="@vite/client"');
    expect(html).toContain('href="app_logo_2.svg"');
    expect(html).toContain('action="submit"');
    expect(html).toContain('src="src/main.tsx"');
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
