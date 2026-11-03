#!/usr/bin/env python3
"""Developer-only builds into ignored .local; never changes the release manifest."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import shutil

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('repository', type=Path)
args = parser.parse_args()
manifest = json.loads((ROOT / 'kernel/manifest.json').read_text())
revision = manifest['source_revision']
output = ROOT / '.local' / 'kernel-builds' / revision
output.mkdir(parents=True, exist_ok=True)
development = {'source_revision': revision, 'version': manifest['version'], 'targets': {}}
actual = subprocess.check_output(['git', '-C', str(args.repository), 'rev-parse', revision + '^{commit}'], text=True).strip()
if actual != revision:
    raise SystemExit('Pinned commit does not match')
archive = subprocess.check_output(['git', '-C', str(args.repository), 'archive', revision])
with tempfile.TemporaryDirectory(prefix='dsh-jand-kernel-') as temp:
    source = Path(temp).resolve()
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        for member in tar:
            destination = source / member.name
            if not destination.resolve().is_relative_to(source) or not (member.isfile() or member.isdir()):
                raise SystemExit('Unsafe source archive member')
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(member) as incoming, destination.open('wb') as output:
                    shutil.copyfileobj(incoming, output)
    for target, asset in manifest['targets'].items():
        platform, arch = target.split('-')
        binary = output / target / Path(asset['binary_path']).name
        binary.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['go', 'build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', '-o', str(binary), './cmd/jand'],
                       cwd=source, env=dict(os.environ, CGO_ENABLED='0', GOOS={'darwin':'darwin','linux':'linux','win32':'windows'}[platform], GOARCH={'x64':'amd64','arm64':'arm64'}[arch]), check=True)
        development['targets'][target] = {'file': str(binary.relative_to(output)), 'sha256': hashlib.sha256(binary.read_bytes()).hexdigest()}
    (output / 'LICENSE-jand').write_bytes((source / 'LICENSE').read_bytes())
goroot = subprocess.check_output(['go','env','GOROOT'],text=True).strip()
(output / 'LICENSE-Go').write_bytes((Path(goroot) / 'LICENSE').read_bytes())
development['build'] = {'toolchain':subprocess.check_output(['go','version'],text=True).strip(), 'cgo':False, 'flags':['-trimpath','-buildvcs=false','-ldflags=-s -w'], 'platformSigned':False, 'notarized':False}
(output / 'development-manifest.json').write_text(json.dumps(development, indent=2) + '\n')
print(str(output))
