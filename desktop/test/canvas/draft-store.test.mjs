import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CANVAS_DRAFT_FILE,
  CANVAS_DRAFT_MAX_BYTES,
  canvasDraftPath,
  clearCanvasDraft,
  readCanvasDraft,
  writeCanvasDraft
} from '../../src/canvas/draft-store.ts';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'canvas-draft-'));
}

test('writeCanvasDraft / readCanvasDraft：往返一致，文件 0600', (t) => {
  const dir = tempDir();
  try {
    const payload = { schema: 'canvas-workbench-draft/1', graph: { nodes: [], edges: [] } };
    const written = writeCanvasDraft(dir, payload);
    assert.equal(written.path, canvasDraftPath(dir));
    assert.ok(written.bytes > 0);
    const read = readCanvasDraft(dir);
    assert.equal(read.recovered, false);
    assert.deepEqual(read.draft, payload);
    if (process.platform === 'win32') {
      // Windows 无 POSIX 模式位：NTFS 上 stat().mode 恒为 0o666，0600 无法表达也不能验证。
      // 只跳过这一条断言，往返/换行/其余语义照跑；POSIX 权限语义由 Linux unit job 继续把关。
      t.diagnostic('Windows 无 POSIX 模式位，跳过 0600 断言（Linux unit job 覆盖）');
    } else {
      assert.equal(statSync(join(dir, CANVAS_DRAFT_FILE)).mode & 0o777, 0o600);
    }
    assert.ok(readFileSync(join(dir, CANVAS_DRAFT_FILE), 'utf8').endsWith('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCanvasDraft：没有文件返回 null 且不算损坏', () => {
  const dir = tempDir();
  try {
    const read = readCanvasDraft(dir);
    assert.equal(read.draft, null);
    assert.equal(read.recovered, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCanvasDraft：坏 JSON 报 recovered，且不删文件（保留现场）', () => {
  const dir = tempDir();
  try {
    writeFileSync(canvasDraftPath(dir), '{ 这不是 JSON');
    const read = readCanvasDraft(dir);
    assert.equal(read.draft, null);
    assert.equal(read.recovered, true);
    assert.equal(statSync(canvasDraftPath(dir)).size > 0, true, '坏文件必须留着');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCanvasDraft：超过上限直接报错，不写半截文件', () => {
  const dir = tempDir();
  try {
    const huge = { blob: 'x'.repeat(CANVAS_DRAFT_MAX_BYTES + 100) };
    assert.throws(() => writeCanvasDraft(dir, huge), /超过 1500000 上限/);
    assert.equal(readCanvasDraft(dir).draft, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clearCanvasDraft：删掉文件后读回 null', () => {
  const dir = tempDir();
  try {
    writeCanvasDraft(dir, { a: 1 });
    clearCanvasDraft(dir);
    assert.equal(readCanvasDraft(dir).draft, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
