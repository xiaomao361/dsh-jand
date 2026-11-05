import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {installLocal, kernelOrigin, sha256, target} from '../src/kernel.js';

function tar(name, bytes) {
  const header = Buffer.alloc(512);
  header.write(name); header.write('0000700\0', 100);
  header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
  header.fill(32, 148, 156); header[156] = 48;
  header.write(header.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return gzipSync(Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512 + 1024)]));
}

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-import-'));
const manifestFor = (bytes, archive) => ({schema_version: 1, version: '2.0.0', targets: {[target()]: {archive_url: 'https://github.com/fixture/kernel', archive_sha256: sha256(archive), binary_sha256: sha256(bytes), binary_path: 'release/jand', archive_format: 'tar.gz'}}});
const saved = (dir, name, bytes) => { const file = path.join(dir, name); fs.writeFileSync(file, bytes); return file; };

test('an official archive imports offline and lands in the normal release cache', async t => {
  const dir = root(); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const bytes = Buffer.from('imported kernel, never executed'), archive = tar('release/jand', bytes);
  const manifest = manifestFor(bytes, archive);
  const install = await installLocal(dir, manifest, saved(dir, 'jand-0.5.0-macos-arm64.tar.gz', archive));
  assert.ok(install.includes(path.join('kernels', '2.0.0', target(), sha256(bytes))));
  assert.deepEqual(fs.readFileSync(install), bytes);
  assert.equal(kernelOrigin(install).source, 'import');
});

test('an already extracted runtime imports without an archive', async t => {
  const dir = root(); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const bytes = Buffer.from('extracted runtime, never executed'), archive = tar('release/jand', bytes);
  const install = await installLocal(dir, manifestFor(bytes, archive), saved(dir, 'jand', bytes));
  assert.deepEqual(fs.readFileSync(install), bytes);
  const again = await installLocal(dir, manifestFor(bytes, archive), saved(dir, 'jand', bytes));
  assert.equal(again, install, 'a verified cache hit is reused');
});

test('modified or unknown files are refused and never cached', async t => {
  const dir = root(); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const bytes = Buffer.from('official runtime'), archive = tar('release/jand', bytes);
  const manifest = manifestFor(bytes, archive);
  const tampered = saved(dir, 'jand', Buffer.from('official runtime!'));
  await assert.rejects(installLocal(dir, manifest, tampered), {code: 'JAND_KERNEL_IMPORT'});
  await assert.rejects(installLocal(dir, manifest, path.join(dir, 'missing.zip')), {code: 'JAND_KERNEL_IMPORT'});
  await assert.rejects(installLocal(dir, manifest, 'relative/path.zip'), {code: 'JAND_KERNEL_IMPORT'});
  await assert.rejects(installLocal(dir, manifest, dir), {code: 'JAND_KERNEL_IMPORT'});
  assert.ok(!fs.existsSync(path.join(dir, 'kernels')), 'nothing is written for a refused file');
});

test('import on a platform without a published runtime reports unsupported', async t => {
  const dir = root(); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = saved(dir, 'jand', Buffer.from('x'));
  await assert.rejects(installLocal(dir, {schema_version: 1, version: '2.0.1', targets: {}}, file), {code: 'JAND_KERNEL_UNSUPPORTED'});
});

test('an imported archive that yields the wrong binary is refused after extraction', async t => {
  const dir = root(); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const bytes = Buffer.from('expected runtime');
  const manifest = {schema_version: 1, version: '2.0.2', targets: {[target()]: {archive_url: 'https://github.com/fixture/kernel', archive_sha256: sha256(tar('release/jand', bytes)), binary_sha256: sha256(Buffer.from('different runtime')), binary_path: 'release/jand', archive_format: 'tar.gz'}}};
  const archive = tar('release/jand', bytes);
  await assert.rejects(installLocal(dir, manifest, saved(dir, 'kernel.tar.gz', archive)), {code: 'JAND_KERNEL_BINARY'});
  assert.ok(!fs.existsSync(path.join(dir, 'kernels')));
});
