import type { MdBlock, MdInline, MdListItem } from './markdown';

export interface HtmlRenderOptions {
  /** Резолвер картинок: относительный путь вложения → src (например, data-URI). */
  readonly resolveImageSrc?: (target: string) => string | undefined;
}

/** Ссылка с явной схемой ведёт наружу — ей положены target/rel. */
const EXTERNAL_HREF_RE = /^[a-z][a-z0-9+.-]*:/i;

/** Источники, уже пригодные как src: читать их с диска не нужно. */
const EXTERNAL_SRC_RE = /^(?:https?:|data:|blob:|asset:|file:)/i;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Видимый номер пункта: цифры исходного маркера («3.» / «3)»). */
function markerNumber(marker: string): string {
  const digits = marker.replace(/[^0-9]/g, '');
  return digits.length > 0 ? digits : '1';
}

/** Плоский текст инлайн-узлов — для alt-атрибутов картинок. */
function inlineToText(nodes: readonly MdInline[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
      case 'code':
        out += node.value;
        break;
      case 'tag':
        out += `#${node.value}`;
        break;
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
        out += inlineToText(node.children);
        break;
      case 'wikilink':
        out += node.label;
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * `parseInline` не различает картинку и ссылку: `![alt](путь)` приходит парой
 * «text-узел, оканчивающийся на `!`» + «узел link». Такая смежная пара и есть
 * картинка — восклицательный знак срезается, ссылка превращается в `<img>`.
 */
function renderImage(link: Extract<MdInline, { kind: 'link' }>, opts: HtmlRenderOptions): string {
  const src = opts.resolveImageSrc?.(link.href) ?? link.href;
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(inlineToText(link.children))}">`;
}

function renderInlineNode(node: MdInline, opts: HtmlRenderOptions): string {
  switch (node.kind) {
    case 'text':
      return escapeHtml(node.value);
    case 'strong':
      return `<strong>${renderInlineNodes(node.children, opts)}</strong>`;
    case 'em':
      return `<em>${renderInlineNodes(node.children, opts)}</em>`;
    case 'del':
      return `<del>${renderInlineNodes(node.children, opts)}</del>`;
    case 'code':
      return `<code>${escapeHtml(node.value)}</code>`;
    case 'tag':
      return `<span class="tag">#${escapeHtml(node.value)}</span>`;
    case 'wikilink':
      return `<span class="wikilink">${escapeHtml(node.label)}</span>`;
    case 'link': {
      const external = EXTERNAL_HREF_RE.test(node.href.trim());
      const extra = external ? ' target="_blank" rel="noreferrer noopener"' : '';
      return `<a href="${escapeHtml(node.href)}"${extra}>${renderInlineNodes(node.children, opts)}</a>`;
    }
    default:
      return '';
  }
}

function renderInlineNodes(nodes: readonly MdInline[], opts: HtmlRenderOptions): string {
  let out = '';
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node.kind === 'text' && node.value.endsWith('!')) {
      const next = nodes[i + 1];
      if (next !== undefined && next.kind === 'link') {
        out += escapeHtml(node.value.slice(0, -1));
        out += renderImage(next, opts);
        i += 1;
        continue;
      }
    }
    out += renderInlineNode(node, opts);
  }
  return out;
}

function renderListItem(item: MdListItem, opts: HtmlRenderOptions): string {
  const indent = item.indent > 0 ? ` style="margin-left:${item.indent * 20}px"` : '';
  const content = renderInlineNodes(item.content, opts);
  if (item.task !== undefined) {
    const cls = item.task.checked ? 'task done' : 'task';
    const checked = item.task.checked ? ' checked' : '';
    return `<li class="${cls}"${indent}><input type="checkbox" disabled${checked}><span>${content}</span></li>`;
  }
  if (item.ordered) {
    return `<li${indent}><span class="num">${markerNumber(item.marker)}.</span><span>${content}</span></li>`;
  }
  return `<li${indent}><span class="bullet"></span><span>${content}</span></li>`;
}

function renderBlock(block: MdBlock, opts: HtmlRenderOptions): string {
  switch (block.kind) {
    case 'heading':
      return `<h${block.level}>${renderInlineNodes(block.content, opts)}</h${block.level}>`;
    case 'paragraph':
      return `<p>${renderInlineNodes(block.content, opts)}</p>`;
    case 'blockquote':
      return `<blockquote>\n${renderBodyHtml(block.children, opts)}\n</blockquote>`;
    case 'code': {
      const lang = block.lang !== undefined ? ` class="language-${escapeHtml(block.lang)}"` : '';
      return `<pre><code${lang}>${escapeHtml(block.value)}</code></pre>`;
    }
    case 'list':
      return `<ul class="list">\n${block.items.map((item) => renderListItem(item, opts)).join('\n')}\n</ul>`;
    case 'hr':
      return '<hr>';
    default:
      return '';
  }
}

/**
 * Относительные пути картинок документа — кандидаты на предзагрузку в data-URI.
 * Обходит все блоки тем же правилом смежности, что и рендер; внешние источники
 * (https, data и т.п.) остаются обычными URL и не собираются.
 */
export function collectImageTargets(blocks: readonly MdBlock[]): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();
  const takeInline = (nodes: readonly MdInline[]): void => {
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (node.kind === 'text' && node.value.endsWith('!')) {
        const next = nodes[i + 1];
        if (next !== undefined && next.kind === 'link') {
          if (!EXTERNAL_SRC_RE.test(next.href) && !seen.has(next.href)) {
            seen.add(next.href);
            targets.push(next.href);
          }
          i += 1;
          continue;
        }
      }
      if (node.kind === 'strong' || node.kind === 'em' || node.kind === 'del' || node.kind === 'link') {
        takeInline(node.children);
      }
    }
  };
  const takeBlocks = (list: readonly MdBlock[]): void => {
    for (const block of list) {
      switch (block.kind) {
        case 'heading':
        case 'paragraph':
          takeInline(block.content);
          break;
        case 'blockquote':
          takeBlocks(block.children);
          break;
        case 'list':
          for (const item of block.items) {
            takeInline(item.content);
          }
          break;
        default:
          break;
      }
    }
  };
  takeBlocks(blocks);
  return targets;
}

/**
 * Сериализует блочную модель режима чтения в HTML-строку. Никакого DOM —
 * чистые строки, так что рендер одинаково работает в webview и в тестах.
 * Весь текст, код и атрибуты экранируются.
 */
export function renderBodyHtml(blocks: readonly MdBlock[], opts: HtmlRenderOptions = {}): string {
  return blocks.map((block) => renderBlock(block, opts)).join('\n');
}
