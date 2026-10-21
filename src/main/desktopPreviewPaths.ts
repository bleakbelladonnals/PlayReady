/** Desktop previews have their own origin. Browser previews need a private project namespace. */
export function namespaceDesktopPreview(bytes: Buffer, contentType: string, base: string): Buffer {
  if (!/^(?:text\/html|text\/css|(?:text|application)\/javascript|application\/json)/iu.test(contentType)) return bytes;
  const source = bytes.toString('utf8');
  const rooted = source.replace(/(["'`])\/(?!\/)([A-Za-z0-9_.$%~-][^"'`\r\n]*)\1/gu,
    (_match, quote: string, path: string) => `${quote}${base}${path}${quote}`);
  const css = rooted.replace(/url\(\s*\/(?!\/)([^\s)'"\r\n]+)\s*\)/giu,
    (_match, path: string) => `url(${base}${path})`);
  return Buffer.from(css);
}
