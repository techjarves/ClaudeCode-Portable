// Turns local paths and URLs in rendered text into clickable elements.
//
// A path is only made clickable when it looks like an absolute local path or a
// file:// URL; relative fragments such as "src/app.ts" stay plain text so the
// reader is not sent chasing paths that mean nothing outside a project.

// A quoted path may contain spaces; an unquoted one may not, because spaces in
// running text are far more often the sentence than part of the folder name.
const QUOTED_PATH = /"[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]+"/g;
const WINDOWS_PATH = /[A-Za-z]:\\(?:[^\\\s/:*?"<>|\r\n]+\\)*[^\\\s/:*?"<>|\r\n]+/g;
const UNC_PATH = /\\\\[^\\\s/:*?"<>|\r\n]+\\[^\\\s/:*?"<>|\r\n]+(?:\\[^\\\s/:*?"<>|\r\n]+)*/g;
const FILE_URL = /file:\/\/\/[^\s<>"']+/gi;
// Trailing punctuation is usually the sentence, not the path.
const TRAILING = /[.,;:!?)\]}'"»”]+$/;

export function trimPath(value) {
  let text = String(value || '');
  let leading = '';
  let trailing = '';
  // Quotes belong to the sentence as well, and to the pattern that allows spaces.
  while (text.length > 2 && /^["']/.test(text)) { leading += text[0]; text = text.slice(1); }
  while (text.length > 1 && TRAILING.test(text)) {
    trailing = text.slice(-1) + trailing;
    text = text.slice(0, -1);
  }
  return { path: text, leading, trailing };
}

export function isFilePath(candidate) {
  const value = String(candidate || '');
  if (/^file:\/\//i.test(value)) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  return /^\\\\[^\\/]+[\\/]/.test(value);
}

/**
 * Replaces every path in a plain-text run with an anchor the caller styles.
 * Returns the original text untouched when there is nothing to link.
 */
export function linkifyText(text, { allowed = isFilePath } = {}) {
  const source = String(text ?? '');
  if (!source) return source;
  const matches = [];
  // The quoted pattern runs first so a path with spaces is not cut short.
  for (const pattern of [QUOTED_PATH, FILE_URL, WINDOWS_PATH, UNC_PATH]) {
    for (const match of source.matchAll(pattern)) matches.push({ index: match.index, text: match[0] });
  }
  if (!matches.length) return source;
  matches.sort((a, b) => a.index - b.index);
  const parts = [];
  let cursor = 0;
  let inserted = 0;
  for (const match of matches) {
    // Overlapping patterns can report the same run twice; the first one wins.
    if (match.index < cursor) continue;
    const { path, leading, trailing } = trimPath(match.text);
    if (!path || !allowed(path)) continue;
    parts.push(escapeHtml(source.slice(cursor, match.index)));
    parts.push(escapeHtml(leading));
    parts.push(pathButtonHtml(path));
    parts.push(escapeHtml(trailing));
    cursor = match.index + match.text.length;
    inserted++;
  }
  if (!inserted) return source;
  parts.push(escapeHtml(source.slice(cursor)));
  return parts.join('');
}

// A button, not a link: opening a local file is an action with no URL, and a
// button stays reachable with Tab and the keyboard.
function pathButtonHtml(path) {
  return `<button type="button" class="path-link" data-open-path="${escapeHtml(path)}" title="Open ${escapeHtml(path)}">${escapeHtml(path)}</button>`;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * Acts on already-rendered HTML: every web link gets target and rel so it never
 * navigates the studio away, and every text node outside code blocks and links
 * is scanned for paths. Returns how many nodes were rewritten.
 *
 * Inline code is linkified as a whole: backticks mark the exact value, so a
 * space inside them belongs to the path (`D:\Apps\Claude Code\x.jpg`) rather
 * than to the sentence. Code blocks stay plain so copying them still works.
 */
export function linkifyElement(root, documentRef = globalThis.document, { skip = 'PRE, A, BUTTON, TEXTAREA, SCRIPT, STYLE' } = {}) {
  if (!root) return 0;
  for (const link of root.querySelectorAll('a[href]')) {
    if (!/^https?:/i.test(link.getAttribute('href'))) continue;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  const walker = documentRef.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue || !node.nodeValue.trim()) continue;
    const parent = node.parentElement;
    // Code blocks keep their text selectable and copyable, and links stay links.
    if (!parent || parent.closest(skip)) continue;
    targets.push({ node, inlineCode: parent.tagName === 'CODE' });
  }
  let changed = 0;
  for (const { node, inlineCode } of targets) {
    const replacement = inlineCode ? inlineCodeHtml(node.nodeValue) : linkifyText(node.nodeValue);
    if (replacement === node.nodeValue) continue;
    const template = documentRef.createElement('template');
    template.innerHTML = replacement;
    node.parentNode.replaceChild(template.content, node);
    changed++;
  }
  return changed;
}

// A whole inline-code span that is one path becomes one button.
function inlineCodeHtml(text) {
  const value = String(text ?? '');
  const path = inlineCodePath(value);
  // Inside backticks the value is either one path or nothing; a partial
  // replacement would cut a path with spaces in half.
  return path ? pathButtonHtml(path) : value;
}

/**
 * The path an inline-code span holds, or null. Accepts the whole span only when
 * it holds exactly one path: two drive letters mean two paths, and a path with
 * spaces would otherwise be split at the wrong place.
 */
export function inlineCodePath(text) {
  const value = String(text ?? '').trim();
  if (!value || /\n/.test(value)) return null;
  // A file URL carries a drive letter of its own, so it is counted separately.
  const markers = /^file:\/\//i.test(value) ? [(value.match(/^file:\/\//i) || [''])[0]] : value.match(/[A-Za-z]:[\\/]/g);
  if (!markers || markers.length !== 1) return null;
  const { path } = trimPath(value);
  return path && isFilePath(path) ? path : null;
}
