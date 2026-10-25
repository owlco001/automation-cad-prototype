import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const appArgument = process.argv.slice(2).find((argument) => argument.startsWith('--app='));
if (!appArgument || process.argv.slice(2).length !== 1) {
  throw new Error('用法：node scripts/smoke-core-preview.mjs --app=/absolute/path/to/packaged-core-executable');
}
const appPath = resolve(appArgument.slice('--app='.length));
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'automationcad-core-preview-package-smoke-'));

function makeStl() {
  const buffer = Buffer.alloc(134);
  buffer.write('Core synthetic STL smoke fixture', 0, 'ascii');
  buffer.writeUInt32LE(1, 80);
  const vertices = [[0, 0, 0], [40, 0, 0], [0, 25, 0]];
  for (let vertex = 0; vertex < 3; vertex += 1) {
    for (let axis = 0; axis < 3; axis += 1) buffer.writeFloatLE(vertices[vertex][axis], 96 + vertex * 12 + axis * 4);
  }
  return buffer;
}

function makeGlb() {
  const binary = Buffer.from(new Float32Array([0, 0, 0, 40, 0, 0, 0, 25, 0]).buffer);
  const document = {
    asset: { version: '2.0', generator: 'synthetic Core smoke fixture' },
    buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    meshes: [{ name: 'Core smoke triangle', primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0
  };
  const json = Buffer.from(JSON.stringify(document), 'utf8');
  const jsonChunk = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const binaryChunk = Buffer.concat([binary, Buffer.alloc((4 - (binary.length % 4)) % 4)]);
  const totalLength = 12 + 8 + jsonChunk.length + 8 + binaryChunk.length;
  const glb = Buffer.alloc(totalLength);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(totalLength, 8);
  let offset = 12;
  glb.writeUInt32LE(jsonChunk.length, offset);
  glb.writeUInt32LE(0x4e4f534a, offset + 4);
  jsonChunk.copy(glb, offset + 8);
  offset += 8 + jsonChunk.length;
  glb.writeUInt32LE(binaryChunk.length, offset);
  glb.writeUInt32LE(0x004e4942, offset + 4);
  binaryChunk.copy(glb, offset + 8);
  return glb;
}

function runPackagedApp(label, files) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('xvfb-run', [
      '-a', '-s', '-screen 0 1280x900x24', appPath,
      ...files.map((file) => `--core-preview-smoke-file=${file}`)
    ], {
      cwd: dirname(appPath),
      env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', LIBGL_ALWAYS_SOFTWARE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let timedOut = false;
    const append = (chunk) => {
      output += chunk.toString();
      if (output.length > 200_000) output = output.slice(-200_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 60_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const marker = output.split(/\r?\n/u).find((line) => line.includes('CORE_CAD_PREVIEW_PACKAGE_SMOKE_OK'));
      if (timedOut || code !== 0 || !marker || !marker.includes(`format=${label}`) || !marker.includes('failedReplacements=2 preserved=true externalRequests=0')) {
        rejectRun(new Error(`Packaged Core ${label} preview smoke failed (code=${code}, signal=${signal}).\n${output}`));
      } else {
        resolveRun(marker.trim());
      }
    });
  });
}

function runPackagedAttachmentSmoke(files) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('xvfb-run', [
      '-a', '-s', '-screen 0 1280x900x24', appPath,
      '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      ...files.map((file) => `--core-project-attachment-smoke-file=${file}`)
    ], {
      cwd: dirname(appPath),
      env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', LIBGL_ALWAYS_SOFTWARE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let timedOut = false;
    const append = (chunk) => {
      output += chunk.toString();
      if (output.length > 200_000) output = output.slice(-200_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 60_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const marker = output.split(/\r?\n/u).find((line) => line.includes('CORE_PROJECT_ATTACHMENT_PACKAGE_SMOKE_OK'));
      if (timedOut || code !== 0 || !marker || !marker.includes('added=1 reopened=true parseRejected=true preserved=true externalRequests=0')) {
        rejectRun(new Error(`Packaged Core project attachment smoke failed (code=${code}, signal=${signal}).\n${output}`));
      } else {
        resolveRun(marker.trim());
      }
    });
  });
}

try {
  const stlPath = join(temporaryDirectory, 'synthetic-triangle.stl');
  const glbPath = join(temporaryDirectory, 'synthetic-triangle.glb');
  const malformedGlbPath = join(temporaryDirectory, 'malformed.glb');
  const unsupportedStepPath = join(temporaryDirectory, 'unsupported.stp');
  await writeFile(stlPath, makeStl());
  await writeFile(glbPath, makeGlb());
  await writeFile(malformedGlbPath, Buffer.from('not a glTF binary file'));
  await writeFile(unsupportedStepPath, Buffer.from('synthetic unsupported STEP fixture'));

  const stlResult = await runPackagedApp('STL', [stlPath, malformedGlbPath, unsupportedStepPath]);
  console.log(`PACKAGED_CORE_PREVIEW_STL ${stlResult}`);
  const glbResult = await runPackagedApp('GLB', [glbPath, malformedGlbPath, unsupportedStepPath]);
  console.log(`PACKAGED_CORE_PREVIEW_GLB ${glbResult}`);
  const sourceBeforeAttachment = await readFile(stlPath);
  const attachmentResult = await runPackagedAttachmentSmoke([stlPath, malformedGlbPath]);
  const sourceAfterAttachment = await readFile(stlPath);
  if (!sourceBeforeAttachment.equals(sourceAfterAttachment)) throw new Error('Packaged Core attachment operation modified the selected source fixture');
  console.log(`PACKAGED_CORE_PROJECT_ATTACHMENT ${attachmentResult} sourceUnchanged=true`);
  console.log(`PACKAGED_CORE_PREVIEW_SMOKE_OK executable=${basename(appPath)} syntheticFixtures=4 formats=STL,GLB attachmentAddReopen=true sourceUnchanged=true parseFailurePreserved=true externalRequests=0`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
