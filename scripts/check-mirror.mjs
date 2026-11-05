#!/usr/bin/env node
// Checks the public download index against the kernel manifest shipped in this
// package. Nothing is published or uploaded here: the index is the operator's
// artifact, and the plugin's pinned manifest stays the source of truth.
//
//   node scripts/check-mirror.mjs
//   node scripts/check-mirror.mjs --download
//   node scripts/check-mirror.mjs --package dist/local-dsh-jand-0.5.3.tgz
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {download, sha256, shippedManifest, target} from '../src/kernel.js';
import {extractBinary} from '../src/archive.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf('--' + name); return i < 0 ? undefined : args[i + 1]; };
const has = name => args.includes('--' + name);
const indexUrl = option('index') ?? 'https://jand.zhou-wei.com/downloads/index.json';
const manifest = shippedManifest();
const failures = [];
const fail = message => { failures.push(message); console.log('  FAIL ' + message); };

async function readIndex() {
  const response = await fetch(indexUrl, {signal: AbortSignal.timeout(15_000), redirect: 'error'});
  if (!response.ok) throw new Error(`index returned HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 256 * 1024) throw new Error('index is larger than 256 KB');
  const value = JSON.parse(text);
  if (value.schema_version !== 1 || !Array.isArray(value.artifacts)) throw new Error('index does not match schema_version 1');
  return value;
}

function kernelEntry(index, key) {
  return index.artifacts.find(entry => entry.kind === 'kernel' && entry.version === manifest.version && entry.target === key);
}

const index = await readIndex();
console.log(`index   ${indexUrl} (updated ${index.updated ?? 'unknown'})`);
console.log(`pinned  kernel ${manifest.version} from kernel/manifest.json\n`);

for (const [key, asset] of Object.entries(manifest.targets)) {
  const entry = kernelEntry(index, key);
  if (!entry) { fail(`${key}: no kernel entry for version ${manifest.version}`); continue; }
  const problems = [];
  if (entry.sha256 !== asset.archive_sha256) problems.push('archive sha256 differs from the pinned manifest');
  if (entry.binary_sha256 !== asset.binary_sha256) problems.push('binary sha256 differs from the pinned manifest');
  const published = asset.archive_mirrors?.[0];
  if (published && entry.url !== published) problems.push('index url differs from the manifest backup url');
  if (entry.upstream !== asset.archive_url) problems.push('index upstream differs from the primary url');
  if (problems.length) problems.forEach(problem => fail(`${key}: ${problem}`));
  else console.log(`  ok   ${key}`);
}

const wanted = option('platform') ?? target();
const archive = manifest.targets[wanted];
if (has('download') && archive) {
  const entry = kernelEntry(index, wanted);
  if (!entry) fail(`${wanted}: cannot test a download without an index entry`);
  else {
    console.log(`\ndownload ${wanted} from the backup origin`);
    try {
      const bytes = await download(entry.url);
      if (sha256(bytes) !== archive.archive_sha256) fail(`${wanted}: downloaded archive hash differs`);
      else {
        const binary = extractBinary(bytes, archive.binary_path, archive.archive_format);
        if (sha256(binary) !== archive.binary_sha256) fail(`${wanted}: extracted binary hash differs`);
        else console.log(`  ok   ${wanted}: ${bytes.length} bytes, archive and binary match`);
      }
    } catch (error) { fail(`${wanted}: download failed (${error.code ?? error.message})`); }
  }
} else if (has('download')) console.log(`\nskip   ${wanted} has no published kernel`);

const packagePath = option('package');
if (packagePath) {
  const file = path.resolve(root, packagePath);
  const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const entry = index.artifacts.find(item => item.kind === 'plugin-candidate' && item.version === version);
  console.log(`\npackage ${path.basename(file)} (${version})`);
  if (!entry) fail(`la version ${version} has no plugin-candidate entry in the index`);
  else if (entry.sha256 !== digest) fail(`index sha256 ${entry.sha256} differs from this file ${digest}; re-upload it and regenerate the index`);
  else if (entry.size !== undefined && entry.size !== fs.statSync(file).size) fail(`index size ${entry.size} differs from this file ${fs.statSync(file).size}`);
  else console.log('  ok   the published candidate matches this file');
}

console.log('');
if (failures.length) { console.log(`${failures.length} problem(s) found.`); process.exitCode = 1; }
else console.log('index, manifest and downloads agree.');
