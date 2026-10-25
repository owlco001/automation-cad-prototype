import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 构建期索引的输入文档；顺序即入库顺序，便于超限时稳定截断。 */
export const KB_DOC_FILES = [
  'NL-AGENT.md',
  'MODULES.md',
  'BACKLOG.md',
  'STATUS.md',
  'PLUGIN-PACKS.md',
  'PARAMETRIC-CAD.md',
  'SKETCH-SPIKE.md',
  'COSTING.md',
  'PLC-CODEGEN.md',
  'SMART-FACTORY-INTEGRATION.md',
  'MACHINE-DESIGN.md',
  'DIMS-GAPS.md',
  'HARDENING.md'
] as const;

export const KB_MAX_CHUNK_CHARS = 800;
export const KB_MAX_BYTES = 400 * 1024;
export const KB_MAX_CHUNKS = 200;

export interface KbChunk {
  id: string;
  /** 文件 + 标题路径；截图/分类为对应文件名或数据包路径。 */
  source: string;
  file: string;
  heading: string;
  line: number;
  text: string;
}

export interface KbSourceMeta {
  path: string;
  kind: 'doc' | 'screenshot' | 'component-category';
  headingHash?: string;
  headings?: string[];
  chunks: number;
}

export interface KbMeta {
  schemaVersion: 1;
  generatedAt: string;
  /** Markdown 文档数（固定 12；截图与分类不计入）。 */
  docs: number;
  chunks: number;
  bytes: number;
  limitBytes: number;
  truncated: boolean;
  droppedChunks: number;
  sizeLimited?: boolean;
  sources: KbSourceMeta[];
}

export interface KbData {
  meta: KbMeta;
  chunks: KbChunk[];
}

interface Heading {
  line: number;
  level: number;
  title: string;
  path: string;
}

interface MarkdownLine {
  text: string;
  line: number;
}

interface Section {
  heading: string;
  line: number;
  lines: MarkdownLine[];
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

function isFence(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

/** 扫描标题行；代码围栏内的 `#` 不算标题。 */
function scanHeadings(markdown: string): Heading[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const headings: Heading[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let inFence = false;
  for (const [index, line] of lines.entries()) {
    if (isFence(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = HEADING_RE.exec(line);
    if (!match) continue;
    const level = match[1]?.length ?? 1;
    const title = (match[2] ?? '').trim();
    if (!title) continue;
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
    stack.push({ level, title });
    headings.push({
      line: index + 1,
      level,
      title,
      path: stack.map((entry) => entry.title).join(' > ')
    });
  }
  return headings;
}

/** 标题列表 hash；测试用它与当前 Markdown 比对，发现「改文档忘记重建」。 */
export function computeHeadingHash(markdown: string): string {
  const headings = scanHeadings(markdown).map((heading) => `${heading.level} ${heading.title}`);
  return createHash('sha256').update(headings.join('\n'), 'utf8').digest('hex');
}

function scanSections(markdown: string): Section[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const sections: Section[] = [{ heading: '（前言）', line: 1, lines: [] }];
  const stack: Array<{ level: number; title: string }> = [];
  let inFence = false;
  for (const [index, line] of lines.entries()) {
    if (isFence(line)) {
      inFence = !inFence;
      sections[sections.length - 1]?.lines.push({ text: line, line: index + 1 });
      continue;
    }
    const match = !inFence ? HEADING_RE.exec(line) : null;
    if (!match) {
      sections[sections.length - 1]?.lines.push({ text: line, line: index + 1 });
      continue;
    }
    const level = match[1]?.length ?? 1;
    const title = (match[2] ?? '').trim();
    if (!title) {
      sections[sections.length - 1]?.lines.push({ text: line, line: index + 1 });
      continue;
    }
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
    stack.push({ level, title });
    sections.push({
      heading: stack.map((entry) => entry.title).join(' > '),
      line: index + 1,
      lines: []
    });
  }
  return sections;
}

function trimBlankLines(lines: MarkdownLine[]): MarkdownLine[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.text.trim() === '') start += 1;
  while (end > start && lines[end - 1]?.text.trim() === '') end -= 1;
  return lines.slice(start, end);
}

/**
 * 按 Markdown 标题切分；单块超过 800 字符时按行贪心拆分，单行过长再硬切。
 * `line` 指向块内第一条内容所在行；标题本身由 `heading` 保留。
 */
export function chunkMarkdown(file: string, markdown: string): KbChunk[] {
  const chunks: KbChunk[] = [];
  let sequence = 0;
  const push = (heading: string, line: number, text: string): void => {
    const trimmed = text.replace(/^\n+|\n+$/g, '').trimEnd();
    if (!trimmed) return;
    sequence += 1;
    chunks.push({
      id: `${file}:${line}:${sequence}`,
      source: heading === '（前言）' ? file : `${file}#${heading}`,
      file,
      heading,
      line,
      text: trimmed
    });
  };

  for (const section of scanSections(markdown)) {
    const lines = trimBlankLines(section.lines);
    if (lines.length === 0) continue;
    let buffer: string[] = [];
    let bufferLength = 0;
    let startLine = section.line;
    const flush = (): void => {
      if (buffer.length === 0) return;
      push(section.heading, startLine, buffer.join('\n'));
      buffer = [];
      bufferLength = 0;
    };

    for (const item of lines) {
      const text = item.text.trimEnd();
      if (text.length > KB_MAX_CHUNK_CHARS) {
        flush();
        for (let offset = 0; offset < text.length; offset += KB_MAX_CHUNK_CHARS) {
          push(section.heading, item.line, text.slice(offset, offset + KB_MAX_CHUNK_CHARS));
        }
        continue;
      }
      if (buffer.length > 0 && bufferLength + 1 + text.length > KB_MAX_CHUNK_CHARS) flush();
      if (buffer.length === 0) startLine = item.line;
      buffer.push(text);
      bufferLength += (bufferLength > 0 ? 1 : 0) + text.length;
    }
    flush();
  }
  return chunks;
}

function readCategories(path: string): string[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { parts?: unknown }).parts)
      ? ((parsed as { parts: unknown[] }).parts)
      : [];
  const categories = new Set<string>();
  for (const item of list) {
    if (typeof item === 'object' && item !== null && typeof (item as { category?: unknown }).category === 'string') {
      const category = (item as { category: string }).category.trim();
      if (category) categories.add(category);
    }
  }
  return [...categories].sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function buildSyntheticChunks(repoRoot: string): { chunks: KbChunk[]; sources: KbSourceMeta[] } {
  const chunks: KbChunk[] = [];
  const sources: KbSourceMeta[] = [];

  const screenshotsDir = join(repoRoot, 'docs/desktop/screenshots');
  if (existsSync(screenshotsDir)) {
    const files = readdirSync(screenshotsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp|gif)$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    for (const name of files) {
      const file = `docs/desktop/screenshots/${name}`;
      chunks.push({
        id: `screenshot:${name}`,
        source: file,
        file,
        heading: '截图索引',
        line: 1,
        text: `截图文件 ${name}`
      });
    }
    if (files.length > 0) {
      sources.push({ path: 'docs/desktop/screenshots', kind: 'screenshot', chunks: files.length });
    }
  }

  const packsDir = join(repoRoot, 'packs/builtin');
  if (existsSync(packsDir)) {
    const packDirs = readdirSync(packsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    for (const packId of packDirs) {
      const partsPath = join(packsDir, packId, 'parts.json');
      if (!existsSync(partsPath)) continue;
      const categories = readCategories(partsPath);
      if (categories.length === 0) continue;
      const file = `packs/builtin/${packId}/parts.json`;
      chunks.push({
        id: `category:${packId}`,
        source: `${file}#元件库分类`,
        file,
        heading: '元件库分类',
        line: 1,
        text: `元件库分类（${packId}）：${categories.join('、')}`
      });
      sources.push({ path: file, kind: 'component-category', chunks: 1 });
    }
  }

  return { chunks, sources };
}

function truncateByChars(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function assemble(
  chunks: KbChunk[],
  sources: KbSourceMeta[],
  options: { generatedAt: string; truncated: boolean; droppedChunks: number; sizeLimited: boolean }
): { data: KbData; bytes: number } {
  const data: KbData = {
    meta: {
      schemaVersion: 1,
      generatedAt: options.generatedAt,
      docs: KB_DOC_FILES.length,
      chunks: chunks.length,
      bytes: 0,
      limitBytes: KB_MAX_BYTES,
      truncated: options.truncated,
      droppedChunks: options.droppedChunks,
      ...(options.sizeLimited ? { sizeLimited: true } : {}),
      sources
    },
    chunks
  };
  let bytes = Buffer.byteLength(JSON.stringify(data), 'utf8');
  data.meta.bytes = bytes;
  bytes = Buffer.byteLength(JSON.stringify(data), 'utf8');
  data.meta.bytes = bytes;
  return { data, bytes };
}

export interface BuildKnowledgeBaseOptions {
  repoRoot: string;
  generatedAt?: string;
  maxBytes?: number;
  maxChunks?: number;
}

/** Keep current work searchable without indexing material already archived or operational-only. */
function prepareBacklogForIndex(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const headings = scanHeadings(markdown);
  const excluded = new Set([
    '模块门控、工程安全与更新通道（2026-10-24，本轮）',
    '夜间执行约束',
    '仓库双推约定（GitHub + Gitee，2026-10-24 起）'
  ]);
  for (let index = headings.length - 1; index >= 0; index -= 1) {
    const heading = headings[index];
    if (!heading) continue;
    let endLine = lines.length;
    for (let next = index + 1; next < headings.length; next += 1) {
      const candidate = headings[next];
      if (candidate && candidate.level <= heading.level) {
        endLine = candidate.line - 1;
        break;
      }
    }
    const start = heading.line - 1;
    if (excluded.has(heading.title)) {
      for (let line = start; line < endLine; line += 1) lines[line] = '';
      continue;
    }
    if (heading.title === '已知问题（记录，不阻塞）') {
      for (let line = start + 1; line < endLine; line += 1) lines[line] = '';
      lines[start + 1] = '历史问题原文保留于 BACKLOG-HISTORY.md；当前阻塞事项列在上方 P0–P2 待办中。';
    }
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\|\s*D(?:5|8|10)\s*\|/.test(lines[index] ?? '')) lines[index] = '';
    if (/^\s+- (?:本轮局部进展（不代表 P2 完成）|新增 Windows x64 NSIS|2026-10-25 本地续测（不代表 P2 完成）|2026-10-25 Core CAD 预览续测)/u.test(lines[index] ?? '')) {
      lines[index] = '';
    }
  }
  return lines.join('\n');
}

/** 构建期生成索引；运行时不调用，启动也不扫盘。 */
export function buildKnowledgeBase(options: BuildKnowledgeBaseOptions): KbData {
  const repoRoot = options.repoRoot;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const maxBytes = options.maxBytes ?? KB_MAX_BYTES;
  const maxChunks = options.maxChunks ?? KB_MAX_CHUNKS;
  const docsDir = join(repoRoot, 'docs/desktop');
  const chunks: KbChunk[] = [];
  const sources: KbSourceMeta[] = [];

  for (const name of KB_DOC_FILES) {
    const filePath = join(docsDir, name);
    const markdown = readFileSync(filePath, 'utf8');
    const indexMarkdown = name === 'BACKLOG.md' ? prepareBacklogForIndex(markdown) : markdown;
    const docChunks = chunkMarkdown(`docs/desktop/${name}`, indexMarkdown);
    chunks.push(...docChunks);
    sources.push({
      path: `docs/desktop/${name}`,
      kind: 'doc',
      headingHash: computeHeadingHash(markdown),
      chunks: docChunks.length
    });
  }

  const synthetic = buildSyntheticChunks(repoRoot);
  chunks.push(...synthetic.chunks);
  sources.push(...synthetic.sources);

  let kept = chunks;
  let truncated = false;
  let droppedChunks = 0;
  let sizeLimited = false;
  let result = assemble(kept, sources, { generatedAt, truncated, droppedChunks, sizeLimited });

  if (result.bytes > maxBytes) {
    truncated = true;
    kept = chunks.slice(0, maxChunks);
    droppedChunks = chunks.length - kept.length;
    result = assemble(kept, sources, { generatedAt, truncated, droppedChunks, sizeLimited });
  }

  // 极端情况下前 200 块仍超限：继续压缩每块文本，仍保留前 200 块并记录 sizeLimited。
  for (let limit = KB_MAX_CHUNK_CHARS - 80; result.bytes > maxBytes && limit >= 120; limit -= 80) {
    sizeLimited = true;
    kept = kept.map((chunk) => ({ ...chunk, text: truncateByChars(chunk.text, limit) }));
    result = assemble(kept, sources, { generatedAt, truncated, droppedChunks, sizeLimited });
  }

  return result.data;
}
