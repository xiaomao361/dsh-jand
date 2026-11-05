import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The locale fragment is concatenated into the Client bundle, so it is evaluated
// here the same way: as plain script text with no module wrapper.
const source=fs.readFileSync(path.join(root,'ui/locale.js'),'utf8')+'\nglobalThis.__locale={zh,en};';
const sandbox={};
vm.runInNewContext(source,sandbox);
const {zh,en}=sandbox.__locale;

test('both languages define the same keys',()=>{
  const missing=Object.keys(zh).filter(key=>!(key in en));
  assert.deepEqual(missing,[],'English locale is missing: '+missing.join(', '));
  const extra=Object.keys(en).filter(key=>!(key in zh));
  assert.deepEqual(extra,[],'Chinese locale is missing: '+extra.join(', '));
  for(const [key,value] of Object.entries(zh)) {
    assert.equal(typeof value,'string',`${key} must be a string`);
    assert.ok(value.trim().length>0,`${key} must not be empty`);
  }
});

test('every kernel failure code has a localized explanation in both languages',()=>{
  const codes=['UNSUPPORTED','OFFLINE','NETWORK','TLS','TIMEOUT','HTTP','REDIRECT','SIZE','ARCHIVE','BINARY','CACHED','WRITE','MANIFEST','OVERRIDE','INSECURE','IMPORT'];
  for(const code of codes) {
    const key='kernelErr'+code[0]+code.slice(1).toLowerCase();
    assert.ok(zh[key],`Chinese locale is missing ${key}`);
    assert.ok(en[key],`English locale is missing ${key}`);
    assert.notEqual(zh[key],key,`${key} should be user-facing text, not a key echo`);
  }
});

test('platform and relay notices exist and keep their placeholders',()=>{
  for(const key of ['unsupportedTitle','unsupportedBanner','unsupportedShort','unsupportedPublished','kernelSignedHint','kernelUnsignedHint','defaultRelayShort','kernelSources','kernelOriginPrimary','kernelOriginBackup','importFile','importFileHint','importFilePath','importFilePlaceholder','importFileAction','importing','imported','stage_download','stage_verify','stage_extract','stage_write','prepareProgress','prepareProgressUnknown','harnessNote','harnessNoteVersion']) {
    assert.ok(zh[key],`missing ${key}`);
    assert.ok(en[key],`missing ${key}`);
  }
  for(const [locale,label] of [[zh,'zh'],[en,'en']]) {
    assert.match(locale.defaultRelayNote,/\{relay\}/,`${label} defaultRelayNote must interpolate the relay address`);
    assert.match(locale.kernelSources,/\{hosts\}/,`${label} kernelSources must interpolate the source hosts`);
    for(const key of ['kernelOriginPrimary','kernelOriginBackup'])assert.match(locale[key],/\{host\}/,`${label} ${key} must interpolate the host`);
  }
});
