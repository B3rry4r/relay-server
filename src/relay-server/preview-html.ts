const ROOT_RELATIVE_ATTRIBUTE_PATTERN = /\b(src|href|action)=([\"'])\/(?!\/|[a-zA-Z][a-zA-Z0-9+.-]*:)([^\"']+)\2/g;
const ROOT_RELATIVE_IMPORT_PATTERN = /\b(import\s*(?:\([^)]*)?|from\s*)([\"'])\/(?!\/|[a-zA-Z][a-zA-Z0-9+.-]*:)([^\"']+)\2/g;
const ROOT_RELATIVE_STRING_PATTERN = /([\"'`])\/(?!\/|[a-zA-Z][a-zA-Z0-9+.-]*:)([^\"'`\s)]+)\1/g;
const ROOT_RELATIVE_CSS_URL_PATTERN = /url\((["']?)\/(?!\/|[a-zA-Z][a-zA-Z0-9+.-]*:)([^"')]+)\1\)/g;

export function rewritePreviewHtml(html: string, baseHref: string): string {
  const rewritten = html
    .replace(ROOT_RELATIVE_ATTRIBUTE_PATTERN, (_match, attr: string, quote: string, value: string) =>
      `${attr}=${quote}${value}${quote}`)
    .replace(ROOT_RELATIVE_IMPORT_PATTERN, (_match, prefix: string, quote: string, value: string) =>
      `${prefix}${quote}${value}${quote}`);

  if (/<base\s+href=/i.test(rewritten)) {
    return rewritten.replace(/<base\s+href=(["'])[^"']*\1\s*\/?>/i, `<base href="${baseHref}">`);
  }

  return rewritten.replace(/<head([^>]*)>/i, `<head$1><base href="${baseHref}">`);
}

export function rewritePreviewText(text: string, baseHref: string): string {
  return text
    .replace(ROOT_RELATIVE_STRING_PATTERN, (_match, quote: string, value: string) =>
      `${quote}${baseHref}${value}${quote}`)
    .replace(ROOT_RELATIVE_CSS_URL_PATTERN, (_match, quote: string, value: string) =>
      `url(${quote}${baseHref}${value}${quote})`);
}
