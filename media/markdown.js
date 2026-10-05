// Markdown renderer for chat replies. Hand-rolled because node_modules is not
// shipped with the extension and the webview CSP forbids remote scripts.
//
// Everything is escaped before any tag is emitted, so model output can never
// inject markup. Links are kept only for http(s) and mailto.
//
// Must tolerate half-finished input: it re-runs on every streamed token, so an
// unterminated fence renders as an open code block rather than as raw text.

(function (root) {
  const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const QUOTE = /^\s{0,3}>\s?/;
  const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  // Line patterns that open a block of their own (tables need two lines).
  const BLOCK_STARTS = [FENCE, HEADING, HR, QUOTE, ITEM];
  // Separator cells, dashes collapsed to one, keyed to their cell attribute.
  const ALIGN = {
    ':-:': ' style="text-align:center"',
    '-:': ' style="text-align:right"',
    ':-': ' style="text-align:left"',
  };

  function esc(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function indentOf(line) { return line.match(/^\s*/)[0].replace(/\t/g, '    ').length; }

  function dedent(line, n) {
    let i = 0;
    for (let col = 0; col < n && (line[i] === ' ' || line[i] === '\t'); i++) col += line[i] === '\t' ? 4 : 1;
    return line.slice(i);
  }

  function isTableStart(lines, i) {
    return lines[i].indexOf('|') >= 0 && i + 1 < lines.length &&
      lines[i + 1].indexOf('-') >= 0 && TABLE_SEP.test(lines[i + 1]);
  }

  function startsBlock(lines, i) {
    return BLOCK_STARTS.some((re) => re.test(lines[i])) || isTableStart(lines, i);
  }

  // ---- inline ----------------------------------------------------------------

  function inline(text) {
    const slots = [];
    const hold = (html) => '\u0000' + (slots.push(html) - 1) + '\u0000';

    // Code spans first: nothing inside them is markdown.
    let s = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, code) =>
      hold('<code>' + esc(code.replace(/^ (.*) $/, '$1')) + '</code>'));

    s = s.replace(/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (all, label, url) =>
      /^(https?:|mailto:)/i.test(url)
        ? hold('<a href="' + esc(url) + '" title="' + esc(url) + '">') + label + hold('</a>')
        : label);

    s = esc(s);
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
    s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
    s = s.replace(/\n/g, '<br>');

    return s.replace(/\u0000(\d+)\u0000/g, (_, n) => slots[+n]);
  }

  // ---- blocks ----------------------------------------------------------------

  function codeBlock(code, lang, closed) {
    const enc = encodeURIComponent(code);
    return '<div class="codeBlock">' +
      (lang ? '<div class="lang">' + esc(lang) + '</div>' : '') +
      '<pre><code>' + esc(code) + '</code></pre>' +
      (closed
        ? '<div class="codeActions">' +
          '<button class="secondary" data-copy="' + enc + '">Copy</button>' +
          '<button class="secondary" data-insert="' + enc + '">Insert</button></div>'
        : '') +
      '</div>';
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  }

  function table(lines, i) {
    const head = splitRow(lines[i]);
    const align = splitRow(lines[i + 1]).map((c) => ALIGN[c.replace(/-+/, '-')] || '');
    // Rows are cut or padded to the header's width.
    const tr = (tag, cells) => '<tr>' + head.map((_, k) =>
      '<' + tag + (align[k] || '') + '>' + inline(cells[k] || '') + '</' + tag + '>').join('') + '</tr>';

    let html = '<table><thead>' + tr('th', head) + '</thead><tbody>';
    for (i += 2; i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0; i++) {
      html += tr('td', splitRow(lines[i]));
    }
    return { html: html + '</tbody></table>', next: i };
  }

  function list(lines, i) {
    const first = lines[i].match(ITEM);
    const ordered = /\d/.test(first[2]);
    // cur is the item being filled; fencePad is non-null inside a fenced block.
    const st = { base: indentOf(first[1]), ordered, items: [], cur: null, fencePad: null, sawBlank: false };
    while (i < lines.length && listLine(st, lines, i)) i++;
    return { html: renderList(st.items, ordered, parseInt(first[2], 10)), next: i };
  }

  // Feeds line i to the list being collected in st; false when it ends the list.
  function listLine(st, lines, i) {
    const l = lines[i];
    if (st.fencePad !== null) return bodyLine(st, l, st.fencePad);
    if (!l.trim()) { st.sawBlank = true; st.cur.push(''); return true; }

    const ind = indentOf(l);
    const m = ind <= st.base + 1 && l.match(ITEM);
    if (m) return listItem(st, m);
    if (ind > st.base) return bodyLine(st, l, Math.min(ind, st.cur.pad));
    // Unindented: either a lazy continuation of the paragraph or the end.
    if (st.sawBlank || startsBlock(lines, i)) return false;
    st.cur.push(l.trim());
    return true;
  }

  // An indented line of the current item, dedented by pad. A fence opens a code
  // block that keeps this pad for every line up to the fence that closes it.
  function bodyLine(st, l, pad) {
    st.cur.push(dedent(l, pad));
    if (FENCE.test(l)) st.fencePad = st.fencePad === null ? pad : null;
    return true;
  }

  function listItem(st, m) {
    // Switching between bullets and numbers starts a new list.
    if (/\d/.test(m[2]) !== st.ordered) return false;
    // A sibling item. Its body is measured from where the text starts.
    st.cur = [m[3]];
    st.cur.pad = m[1].length + m[2].length + 1;
    st.items.push(st.cur);
    st.sawBlank = false;
    return true;
  }

  function renderList(items, ordered, start) {
    // A blank line anywhere between items makes the list "loose" (paragraphs).
    const loose = items.some((it, k) => k < items.length - 1 && it[it.length - 1] === '');
    const tag = ordered ? 'ol' : 'ul';
    const attr = ordered && start !== 1 ? ' start="' + start + '"' : '';
    return '<' + tag + attr + '>' +
      items.map((it) => '<li>' + blocks(it, !loose) + '</li>').join('') +
      '</' + tag + '>';
  }

  function fenced(lines, i, f) {
    const ind = f[1].length, marker = f[2];
    const close = marker[0].repeat(marker.length);
    const code = [];
    for (i++; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t.startsWith(close) && /^([`~])\1*$/.test(t)) {
        return { html: codeBlock(code.join('\n'), f[3], true), next: i + 1 };
      }
      code.push(dedent(lines[i], ind));
    }
    return { html: codeBlock(code.join('\n'), f[3], false), next: i };
  }

  function blockquote(lines, i) {
    const body = [];
    for (; i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !startsBlock(lines, i)); i++) {
      body.push(lines[i].replace(QUOTE, ''));
    }
    return { html: '<blockquote>' + blocks(body, false) + '</blockquote>', next: i };
  }

  function paragraph(lines, i, tight) {
    const para = [lines[i].trim()];
    for (i++; i < lines.length && lines[i].trim() && !startsBlock(lines, i); i++) para.push(lines[i].trim());
    const body = inline(para.join('\n'));
    return { html: tight ? '<div>' + body + '</div>' : '<p>' + body + '</p>', next: i };
  }

  // The block starting at (non-blank) line i: its html and the line after it.
  function block(lines, i, tight) {
    const l = lines[i];
    const f = l.match(FENCE);
    if (f) return fenced(lines, i, f);

    const h = l.match(HEADING);
    if (h) return { html: '<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>', next: i + 1 };

    if (HR.test(l)) return { html: '<hr>', next: i + 1 };
    if (QUOTE.test(l)) return blockquote(lines, i);
    if (isTableStart(lines, i)) return table(lines, i);
    if (ITEM.test(l)) return list(lines, i);
    return paragraph(lines, i, tight);
  }

  // tight = render lone paragraphs without <p>, as in list items.
  function blocks(lines, tight) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      if (!lines[i].trim()) { i++; continue; }
      const b = block(lines, i, tight);
      out.push(b.html);
      i = b.next;
    }
    return out.join('');
  }

  function renderMarkdown(text) {
    return blocks(text.replace(/\r\n?/g, '\n').split('\n'), false);
  }

  root.renderMarkdown = renderMarkdown;
  if (typeof module !== 'undefined') module.exports = { renderMarkdown };
})(typeof window !== 'undefined' ? window : globalThis);
