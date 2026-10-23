// Markdown for speaker notes (D19): raw HTML is escaped, so the output is safe
// to insert. markdown-it is loaded as a classic script before this module.
let md = null;

export function renderMarkdown(text) {
  md ??= window.markdownit({ html: false, linkify: true, breaks: true });
  return md.render(text ?? '');
}
