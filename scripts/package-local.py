#!/usr/bin/env python3
"""Pack locally and audit the actual distributed contents. Never publishes."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import xml.etree.ElementTree as ET
import shutil

root = Path(__file__).resolve().parents[1]
(root / 'dist').mkdir(exist_ok=True)
npm = 'npm.cmd' if os.name == 'nt' else 'npm'
metadata = json.loads(subprocess.check_output([npm,'pack','--pack-destination','dist','--json'],cwd=root,text=True))[0]
output = root / 'dist' / metadata['filename']
manifest = json.loads((root / 'kernel/manifest.json').read_text())
secret_file = os.environ.get('DSH_JAND_AUDIT_TOKEN_FILE')
secret = Path(secret_file).read_bytes().strip() if secret_file else None
if secret_file and not secret:
    raise SystemExit('Audit token file is empty')
with tarfile.open(output) as tar:
    names = tar.getnames()
    if any(any(part in name for part in ['/node_modules/','/credentials/','/conversations/','/.git/']) for name in names):
        raise SystemExit('Runtime/development files leaked into package')
    for member in tar:
        if member.isfile() and secret and secret in tar.extractfile(member).read():
            raise SystemExit('Private audit credential found in package')
    if any(name.endswith('/jand') or name.endswith('/jand.exe') for name in names):
        raise SystemExit('A platform binary leaked into the thin plugin bundle')
    packed_manifest = json.load(tar.extractfile('package/kernel/manifest.json'))
    if packed_manifest != manifest or manifest['schema_version'] != 1:
        raise SystemExit('Pinned runtime manifest mismatch')
    for asset in manifest['targets'].values():
        if not asset['archive_url'].startswith('https://') or len(asset['archive_sha256']) != 64 or len(asset['binary_sha256']) != 64 or 'file' in asset:
            raise SystemExit('Invalid download-only runtime entry')
    for name in ['README.md','docs/RELEASE_0.5.1.md','docs/ARCHITECTURE.md','icon.svg','locale/zh.json','index.js','client.js','src/worker.js']:
        if 'package/' + name not in names:
            raise SystemExit('Required package resource is missing: ' + name)
    icon = ET.fromstring(tar.extractfile('package/icon.svg').read())
    if icon.tag != '{http://www.w3.org/2000/svg}svg' or 'viewBox' not in icon.attrib:
        raise SystemExit('Invalid SVG resource')
    package = json.load(tar.extractfile('package/package.json'))
    if not package.get('dsh',{}).get('client') or package['exports'].get('./client') != './client.js':
        raise SystemExit('Native Client metadata is missing')
digest = hashlib.sha256(output.read_bytes()).hexdigest()
(root/'dist/SHA256SUMS.txt').write_text(digest + '  ' + output.name + '\n')
bundle = root/'dist/bundles'/digest[:12]
bundle.mkdir(parents=True,exist_ok=True)
with tarfile.open(output) as tar:
    for member in tar:
        destination=bundle/member.name
        if not destination.resolve().is_relative_to(bundle.resolve()) or not member.isfile():
            raise SystemExit('Unexpected package archive member')
        destination.parent.mkdir(parents=True,exist_ok=True)
        data=tar.extractfile(member).read()
        if destination.exists():
            if destination.read_bytes()!=data:
                raise SystemExit('Existing generated bundle was modified; leaving it untouched')
        else:
            with destination.open('xb') as file:
                file.write(data)
            destination.chmod(member.mode)
print(json.dumps({'package':str(output),'installDirectory':str(bundle/'package'),'size':metadata['size'],'files':metadata['entryCount'],'sha256':digest,
                  'audit':'passed','privateCredentialScan':'passed' if secret else 'not_requested'},ensure_ascii=False))
