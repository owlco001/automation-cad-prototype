import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildDesignPackage, parseDesignPackage, sha256Hex } from '../../src/sync/package.ts';
import {
  buildCandidateReviewFiles,
  exportCandidateReviewFolder,
  PLC_REVIEW_ALLOWED_PATHS
} from '../../src/sync/candidate-review-export.ts';
import { isTrustedProjectArchiveRequest } from '../../electron/project-archive-ipc-auth.ts';

const paths = [...PLC_REVIEW_ALLOWED_PATHS];

function parsedCandidate(programOverrides = {}) {
  const machineId = 'review-machine-01';
  const programFiles = paths.map((path) => ({
    path,
    content: programOverrides[path] ?? (path.endsWith('.json') ? '{"mode":"review"}\n' : `${path} reviewed text\n`)
  }));
  const built = buildDesignPackage({
    projectId: 'review-project',
    projectName: 'Review only',
    appVersion: '0.3.0',
    createdAt: '2026-10-25T00:00:00.000Z',
    bom: [{ no: 1, name: 'fixture', spec: 'test', qty: 1, mat: 'none' }],
    bomCsv: 'no,name\n1,fixture\n',
    plc: {
      target: 's7-1200',
      generatedVersion: '1.0.0',
      machineId,
      programFiles,
      mappingCsv: 'point,address,direction\nX0.0,I0.0,input\n'
    }
  });
  return parseDesignPackage(built.zip);
}

function cloneCandidate(candidate) {
  return structuredClone(candidate);
}

function withTempParent(run) {
  const parent = mkdtempSync(join(tmpdir(), 'automationcad-review-test-'));
  try {
    return run(parent);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

test('review export copies exactly the ten validated allowlisted PLC program files and omits mapping CSV and metadata', () => {
  const candidate = parsedCandidate();
  const files = buildCandidateReviewFiles(candidate);
  assert.deepEqual(files.map((file) => file.path).sort(), [...paths].sort());
  assert.equal(files.some((file) => file.path.includes('machine-io-map.csv')), false);
  withTempParent((parent) => {
    const result = exportCandidateReviewFolder(parent, 'pkg-01', candidate, { randomSuffix: () => 'a1b2c3d4' });
    assert.equal(result.fileCount, 10);
    assert.match(result.folderName, new RegExp(`^plc-review-${sha256Hex('pkg-01').slice(0, 12)}-a1b2c3d4$`));
    const folder = join(parent, result.folderName);
    const listed = [];
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        for (const child of readdirSync(join(folder, entry.name))) listed.push(`${entry.name}/${child}`);
      } else listed.push(entry.name);
    }
    assert.deepEqual(listed.sort(), [...paths].sort());
    assert.equal(readFileSync(join(folder, 'src/OB1_Main.st'), 'utf8'), 'src/OB1_Main.st reviewed text\n');
    assert.equal(readFileSync(join(folder, 'io-tags.csv'), 'utf8'), 'io-tags.csv reviewed text\n');
    assert.equal(readFileSync(join(folder, 'mapping.json'), 'utf8'), '{"mode":"review"}\n');
    assert.equal(statSync(join(folder, 'src/OB1_Main.st')).mode & 0o777, 0o600);
    assert.equal(statSync(folder).mode & 0o777, 0o700);
  });
});

test('review export rejects traversal, absolute paths, unknown types, exact duplicates and case-colliding paths', () => {
  for (const path of ['../outside.st', '/tmp/outside.st', 'C:/outside.st', 'src\\OB1_Main.st', 'src/OB1_Main.txt']) {
    const candidate = cloneCandidate(parsedCandidate());
    candidate.plc.programFiles[0].path = path;
    assert.throws(() => buildCandidateReviewFiles(candidate), /不安全相对路径|不在白名单|文件类型/);
  }
  const duplicate = cloneCandidate(parsedCandidate());
  duplicate.plc.programFiles[1].path = duplicate.plc.programFiles[0].path;
  assert.throws(() => buildCandidateReviewFiles(duplicate), /重复路径/);
  const caseCollision = cloneCandidate(parsedCandidate());
  caseCollision.plc.programFiles[1].path = 'src/ob1_main.st';
  assert.throws(() => buildCandidateReviewFiles(caseCollision), /大小写冲突/);
});

test('review export rejects credentials before considering stale candidate hashes', () => {
  const candidate = cloneCandidate(parsedCandidate());
  candidate.plc.programFiles[0].content = 'API_KEY=review-secret-value-12345';
  assert.throws(() => buildCandidateReviewFiles(candidate), /密钥或凭据/);
});

test('review export rejects credential-like package IDs and never places raw package IDs in folder names', () => {
  const candidate = parsedCandidate();
  withTempParent((parent) => {
    assert.throws(
      () => exportCandidateReviewFolder(parent, 'api_key=review-secret-value-12345', candidate),
      /密钥或凭据/
    );
    assert.deepEqual(readdirSync(parent), []);
  });
});

test('review export enforces exact file count, per-file limit, aggregate limit and manifest hash consistency', () => {
  const tooFew = cloneCandidate(parsedCandidate());
  tooFew.plc.programFiles.pop();
  assert.throws(() => buildCandidateReviewFiles(tooFew), /恰好包含 10 个固定文件/);

  const tooMany = cloneCandidate(parsedCandidate());
  tooMany.plc.programFiles.push({ ...tooMany.plc.programFiles[0] });
  assert.throws(() => buildCandidateReviewFiles(tooMany), /恰好包含 10 个固定文件/);

  const tooLarge = cloneCandidate(parsedCandidate());
  tooLarge.plc.programFiles[0].content = 'x'.repeat(1024 * 1024 + 1);
  assert.throws(() => buildCandidateReviewFiles(tooLarge), /超过 1 MiB 上限/);

  const tooMuch = cloneCandidate(parsedCandidate());
  for (const file of tooMuch.plc.programFiles) file.content = 'x'.repeat(900 * 1024);
  assert.throws(() => buildCandidateReviewFiles(tooMuch), /总量超过 8 MiB 上限/);

  const changed = cloneCandidate(parsedCandidate());
  changed.plc.programFiles[0].content += 'tampered';
  assert.throws(() => buildCandidateReviewFiles(changed), /与已校验 manifest 不一致/);
});

test('review export refuses an existing destination without changing its contents', () => {
  const candidate = parsedCandidate();
  withTempParent((parent) => {
    const name = `plc-review-${sha256Hex('pkg-existing').slice(0, 12)}-a1b2c3d4`;
    const target = join(parent, name);
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'keep');
    assert.throws(
      () => exportCandidateReviewFolder(parent, 'pkg-existing', candidate, { randomSuffix: () => 'a1b2c3d4' }),
      /目标审阅文件夹已存在/
    );
    assert.deepEqual(readdirSync(parent).sort(), [name]);
    assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'keep');
  });
});

test('injected write and atomic-publish failures remove staging and leave no visible partial destination', () => {
  const candidate = parsedCandidate();
  withTempParent((parent) => {
    let writes = 0;
    assert.throws(
      () => exportCandidateReviewFolder(parent, 'pkg-fault', candidate, {
        randomSuffix: () => 'b2c3d4e5',
        fileSystem: {
          writeDescriptor(descriptor, bytes) {
            writes += 1;
            if (writes === 2) throw new Error('injected disk fault');
            writeFileSync(descriptor, bytes);
          }
        }
      }),
      /injected disk fault/
    );
    assert.equal(writes, 2);
    assert.deepEqual(readdirSync(parent), []);

    assert.throws(
      () => exportCandidateReviewFolder(parent, 'pkg-rename-fault', candidate, {
        randomSuffix: () => 'c3d4e5f6',
        fileSystem: {
          rename() {
            throw new Error('injected atomic-publish fault');
          }
        }
      }),
      /injected atomic-publish fault/
    );
    assert.deepEqual(readdirSync(parent), []);
  });
});

test('export IPC trust requires the registered application main-frame sender and exact local renderer URL', () => {
  const mainFrame = { url: 'file:///opt/automationcad/index.html' };
  const subFrame = { url: 'file:///opt/automationcad/index.html' };
  const sender = { mainFrame };
  const expected = 'file:///opt/automationcad/index.html';
  assert.equal(isTrustedProjectArchiveRequest(true, sender, mainFrame, expected), true);
  assert.equal(isTrustedProjectArchiveRequest(false, sender, mainFrame, expected), false);
  assert.equal(isTrustedProjectArchiveRequest(true, sender, subFrame, expected), false);
  assert.equal(isTrustedProjectArchiveRequest(true, sender, { url: 'https://evil.example/' }, expected), false);
});
