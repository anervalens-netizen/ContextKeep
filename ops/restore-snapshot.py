#!/usr/bin/env python3
"""Restore a trusted ContextKeep snapshot with its supported offline CLI."""
import argparse, contextlib, hashlib, json, os, pathlib, shutil, sqlite3, subprocess, tarfile, tempfile
from contextkeep_ops_config import load_profile, validate_runtime_identity

P=pathlib.Path
LIVE_DATA=P('/opt/contextkeep/apps/server/data')
COUNT_TABLES={'projects','records','sources'}

def digest(file):
    h=hashlib.sha256()
    with open(file,'rb') as stream:
        for chunk in iter(lambda:stream.read(1048576),b''):h.update(chunk)
    return h.hexdigest()

def unpack_snapshot(snapshot,destination):
    # Inspect the entire namespace, even members we do not extract. Extract only
    # two ordinary files ourselves, so links cannot redirect a subsequent write.
    # Auxiliary links emitted by the backup job are retained only as metadata:
    # their targets are never followed and those members are never extracted.
    with tarfile.open(snapshot,'r:gz') as archive:
        members={}
        for member in archive:
            name=member.name.rstrip('/')
            parts=pathlib.PurePosixPath(name).parts
            if (not parts or name.startswith('/') or '..' in parts or '\\' in name
                    or name!=str(pathlib.PurePosixPath(name)) or name in members
                    or not (member.isfile() or member.isdir() or member.issym() or member.islnk())):
                raise ValueError('Unsafe or duplicate snapshot member: '+member.name)
            members[name]=member
        for name in ['store.sqlite','manifest.json']:
            member=members.get(name)
            if member is None or not member.isfile():raise ValueError('Missing snapshot file: '+name)
            if name=='manifest.json' and member.size>1048576:raise ValueError('Snapshot manifest is too large')
            source=archive.extractfile(member)
            if source is None:raise ValueError('Unreadable snapshot file: '+name)
            with source,open(destination/name,'xb') as output:
                shutil.copyfileobj(source,output)
            if (destination/name).stat().st_size!=member.size:raise ValueError('Truncated snapshot file: '+name)
    manifest=json.loads((destination/'manifest.json').read_text())
    if not isinstance(manifest,dict):raise ValueError('Invalid snapshot manifest')
    expected=manifest.get('db_sha256')
    if (not isinstance(expected,str) or len(expected)!=64
            or any(c not in '0123456789abcdef' for c in expected)
            or digest(destination/'store.sqlite')!=expected):
        raise ValueError('Snapshot database hash mismatch')
    counts=manifest.get('counts')
    if (not isinstance(counts,dict) or set(counts)!=COUNT_TABLES
            or any(type(n) is not int or n<0 for n in counts.values())):
        raise ValueError('Invalid snapshot counts')
    release=manifest.get('release')
    if not isinstance(release,str) or not release or release in {'.','..'} or '/' in release or '\\' in release:
        raise ValueError('Invalid snapshot release')
    return manifest

def verify_database(file,counts):
    with contextlib.closing(sqlite3.connect(file.resolve().as_uri()+'?mode=ro',uri=True)) as db:
        if db.execute('pragma integrity_check').fetchall()!=[('ok',)]:raise ValueError('Database integrity check failed')
        if db.execute('pragma foreign_key_check').fetchall():raise ValueError('Database foreign-key check failed')
        for table,count in counts.items():
            if table not in COUNT_TABLES:raise ValueError('Invalid count table')
            if db.execute('select count(*) from '+table).fetchone()[0]!=count:
                raise ValueError('Snapshot count mismatch: '+table)

def require_stopped_service(runner):
    result=runner(['systemctl','--user','show','contextkeep.service','--property=LoadState','--property=ActiveState'],
                  capture_output=True,text=True,timeout=15)
    properties=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
    if (result.returncode!=0 or properties.get('LoadState')!='loaded'
            or properties.get('ActiveState') not in {'inactive','failed'}):
        raise RuntimeError('ContextKeep service is active or its state is unknown; stop/fence and verify it before restore')

def restore_snapshot(snapshot,data_dir,node,release,*,runner=None,environ=None,live_data=LIVE_DATA,dry_run=False):
    runner=runner or subprocess.run
    target=P(data_dir).resolve()
    if target==P(live_data).resolve():require_stopped_service(runner)
    with tempfile.TemporaryDirectory(prefix='ck-restore-') as tmp:
        tmp=P(tmp)
        manifest=unpack_snapshot(snapshot,tmp)
        release=P(release).resolve(strict=True)
        if release.name!=manifest['release']:raise ValueError('Use exact matching runtime kit')
        verify_database(tmp/'store.sqlite',manifest['counts'])
        if dry_run:
            return {'dry_run':True,'target':str(target),'release':manifest['release'],'counts':manifest['counts'],'integrity':'ok'}
        env={**(os.environ if environ is None else environ),'CK_DATA_DIR':str(target)}
        # The updated CLI acquires the directory lock itself. Never synthesize a
        # human acknowledgement; an older CLI requiring that flag fails closed.
        runner([str(node),str(release/'apps/server/dist/cli/restore.js'),str(tmp/'store.sqlite')],env=env,check=True)
        verify_database(target/'store.sqlite',manifest['counts'])
        return {'restored':str(target),'counts':manifest['counts'],'integrity':'ok'}

def main(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument('snapshot')
    parser.add_argument('--config',help='Private JSON operations profile; CONTEXTKEEP_OPS_CONFIG is also supported')
    parser.add_argument('--data-dir')
    preferred=P('/home/operator/.openclaw/tools/node-v24.19.0/bin/node')
    parser.add_argument('--node')
    parser.add_argument('--release')
    parser.add_argument('--dry-run',action='store_true',help='Validate identity, archive and runtime without mutating the target')
    args=parser.parse_args(argv)
    configured=bool(args.config or os.environ.get('CONTEXTKEEP_OPS_CONFIG'))
    profile=load_profile(args.config)
    observed=subprocess.run(['hostname'],check=True,capture_output=True,text=True,timeout=15).stdout.strip()
    data_dir=args.data_dir or profile['data_dir']
    release=args.release or profile['release_dir']
    if not configured:
        profile['data_dir']=str(P(data_dir).resolve())
        profile['release_dir']=str(P(release).resolve())
    validate_runtime_identity(profile,observed,data_dir,release,require_data=False)
    node=args.node or (str(preferred) if preferred.exists() else '/usr/bin/node')
    result=restore_snapshot(args.snapshot,data_dir,node,release,dry_run=args.dry_run)
    print(json.dumps(result))
    return result

if __name__=='__main__':main()
