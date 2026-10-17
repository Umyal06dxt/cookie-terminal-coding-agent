import { highlightLine } from './highlight.ts';
import { type Line, type Seg, wrap } from './lines.ts';

/** `code` spans and **bold**. Anything unclosed (mid-stream) stays literal text. */
export function inline(text: string, base: Seg = { text: '' }): Seg[] {
  const segs: Seg[] = [];
  const pattern = /(`+)(.+?)\1|\*\*(.+?)\*\*/g;
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > at)
      segs.push({ ...base, text: text.slice(at, match.index) });
    const code = match[2];
    if (code !== undefined) segs.push({ ...base, text: code, fg: 'crust' });
    else segs.push({ ...base, text: match[3] ?? '', bold: true });
    at = match.index + match[0].length;
  }
  if (at < text.length) segs.push({ ...base, text: text.slice(at) });
  return segs;
}

const FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)/;
const HEADING = /^#{1,6}\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+[.)])\s+(.*)$/;

/**
 * Markdown to terminal rows, `width` cells wide including `indent`. Handles what models
 * actually send: paragraphs, headings, bullets, numbered lists, fenced code with syntax colour,
 * inline code and bold. An unclosed fence (still streaming) renders as code to the end.
 */
export function renderMarkdown(
  text: string,
  width: number,
  indent = '',
): Line[] {
  const rows: Line[] = [];
  const pad = (segs: Seg[], hang = ''): Line[] =>
    wrap([{ text: indent }, ...segs], width, indent + hang);
  let fence: { marker: string; lang: string } | null = null;

  for (const raw of text.replaceAll('\r\n', '\n').split('\n')) {
    const fenceMatch = FENCE.exec(raw);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1] === fence.marker &&
        fenceMatch[2] === ''
      ) {
        fence = null;
        continue;
      }
      rows.push(
        ...wrap(
          [
            { text: indent },
            { text: '▏ ', fg: 'butter' },
            ...highlightLine(raw, fence.lang),
          ],
          width,
          `${indent}▏ `,
        ).map(colourBar),
      );
      continue;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1] ?? '```', lang: fenceMatch[2] ?? '' };
      continue;
    }
    if (raw.trim() === '') {
      rows.push([]);
      continue;
    }
    const heading = HEADING.exec(raw);
    if (heading) {
      rows.push(
        ...pad(inline(heading[1] ?? '', { text: '', fg: 'crust', bold: true })),
      );
      continue;
    }
    const bullet = BULLET.exec(raw);
    if (bullet) {
      const lead = `${bullet[1] ?? ''}• `;
      rows.push(
        ...pad(
          [{ text: lead, fg: 'crust' }, ...inline(bullet[2] ?? '')],
          ' '.repeat(lead.length),
        ),
      );
      continue;
    }
    const numbered = NUMBERED.exec(raw);
    if (numbered) {
      const lead = `${numbered[1] ?? ''}${numbered[2] ?? ''} `;
      rows.push(
        ...pad(
          [{ text: lead, fg: 'crust' }, ...inline(numbered[3] ?? '')],
          ' '.repeat(lead.length),
        ),
      );
      continue;
    }
    rows.push(...pad(inline(raw)));
  }
  return rows;
}

/** Wrapped code rows carry the bar as plain indent text; give it the border colour. */
function colourBar(line: Line): Line {
  return line.flatMap((seg) => {
    const at = seg.text.indexOf('▏ ');
    if (seg.fg !== undefined || at === -1) return [seg];
    const before = seg.text.slice(0, at);
    const after = seg.text.slice(at + 2);
    return [
      ...(before === '' ? [] : [{ ...seg, text: before }]),
      { text: '▏ ', fg: 'butter' as const },
      ...(after === '' ? [] : [{ ...seg, text: after }]),
    ];
  });
}
