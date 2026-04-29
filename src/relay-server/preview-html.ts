const ROOT_RELATIVE_ASSET_PATTERN = /\b(src|href)=([\"'])\/(?!\/|[a-zA-Z][a-zA-Z0-9+.-]*:)([^\"']+)\2/g;

export function rewritePreviewHtml(html: string, baseHref: string): string {
  return html
    .replace(/<base\s+href=(["'])\/\1\s*\/?>/i, `<base href="${baseHref}">`)
    .replace(ROOT_RELATIVE_ASSET_PATTERN, (_match, attr: string, quote: string, value: string) =>
      `${attr}=${quote}${value}${quote}`);
}
