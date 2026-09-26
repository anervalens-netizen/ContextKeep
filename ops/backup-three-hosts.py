#!/usr/bin/env python3
"""ContextKeep: consistent snapshots, recovery kits and verified independent copies."""
import argparse, contextlib, datetime as dt, fcntl, gzip, hashlib, json, os, pathlib, posixpath, shlex, shutil, sqlite3, subprocess, tarfile, tempfile
from contextkeep_ops_config import load_profile, space_report, validate_runtime_identity, verify_running_process
P=pathlib.Path
BASE=P('/storage/backups/contextkeep')
HOME=P('/home/operator')
REPO=P('/opt/contextkeep')
STATUS=BASE/'status.json'
def run(args, **kw):
    return subprocess.run(args,check=True,capture_output=True,text=True,timeout=180,**kw).stdout.strip()
def digest(p):
    h=hashlib.sha256()
    with open(p,'rb') as f:
        for b in iter(lambda:f.read(1048576),b''): h.update(b)
    return h.hexdigest()
def write(p,v):
    fd,name=tempfile.mkstemp(prefix=p.name+'.tmp-',dir=p.parent)
    tmp=P(name)
    try:
        with os.fdopen(fd,'w') as f:
            json.dump(v,f,indent=2)
            f.flush();os.fsync(f.fileno())
        os.replace(tmp,p)
    finally:
        tmp.unlink(missing_ok=True)

def validate_runtime_kit(kit):
    """Validate every existing kit before trusting its hash or distributing it."""
    required={'release/package.json','release/apps/server/dist/cli/restore.js','node'}
    files=set();seen=set();has_tunnel=False
    with tarfile.open(kit,'r:gz') as archive:
        for member in archive:
            name=member.name.rstrip('/')
            parts=pathlib.PurePosixPath(name).parts
            if (not parts or name.startswith('/') or '..' in parts or '\\' in name
                    or name in seen or parts[0] not in {'release','node','tunnel'}):
                raise ValueError('Unsafe or duplicate runtime member: '+member.name)
            seen.add(name)
            if member.issym() or member.islnk():
                link=member.linkname
                target=posixpath.normpath(posixpath.join(posixpath.dirname(name),link) if member.issym() else link)
                if (not link or link.startswith('/') or '\\' in link
                        or target.split('/')[0] not in {'release','node','tunnel'}):
                    raise ValueError('Runtime link escapes the kit: '+name)
            elif member.isfile():
                source=archive.extractfile(member)
                if source is None:raise ValueError('Unreadable runtime member: '+name)
                with source:
                    size=sum(len(chunk) for chunk in iter(lambda:source.read(1048576),b''))
                if size!=member.size:raise ValueError('Truncated runtime member: '+name)
                if size>0:files.add(name)
            elif not member.isdir():
                raise ValueError('Unsupported runtime member: '+name)
            if name=='tunnel' and member.isdir():has_tunnel=True
    # Read through the gzip trailer too; tar EOF alone need not validate its CRC.
    with gzip.open(kit,'rb') as stream:
        for _ in iter(lambda:stream.read(1048576),b''):pass
    if not required.issubset(files) or not has_tunnel:
        raise ValueError('Runtime kit is missing required runtime files')

def ensure_runtime_kit(kit,release,home,node):
    if kit.exists():
        validate_runtime_kit(kit)
        return
    part=kit.with_suffix('.partial')
    try:
        with tarfile.open(part,'w:gz',compresslevel=1,dereference=False) as archive:
            archive.add(release,arcname='release')
            archive.add(P(node).resolve(strict=True),arcname='node')
            archive.add(home/'.local/lib/contextkeep-tunnel',arcname='tunnel')
        validate_runtime_kit(part)
        os.replace(part,kit)
    finally:
        part.unlink(missing_ok=True)
def prune(root):
    rows=sorted(root.glob('snapshot-*.tar.gz'),reverse=True)
    keep=set(rows[:96]);days=set()
    for p in rows:
        day=p.name[9:17]
        if day not in days and len(days)<30: keep.add(p);days.add(day)
    for p in rows:
        if p not in keep: p.unlink()
def running_node(run,proc_root=P('/proc')):
    """Bundle the actual service interpreter, never an unrelated PATH default."""
    pid=run(['systemctl','--user','show','contextkeep.service','--property=MainPID','--value'])
    if not pid.isdecimal() or int(pid)<=1:raise RuntimeError('Active ContextKeep MainPID is unavailable')
    executable=(P(proc_root)/pid/'exe').resolve(strict=True)
    if not executable.is_file():raise RuntimeError('Service interpreter is not a regular file')
    return executable

def main(*,base=BASE,home=HOME,repo=REPO,node=None,nas_mount='/mnt/nas',nas_dir=None,runner=None,mounted=None,now=None,config=None,dry_run=False,report_space=False,runtime_observer=None,proc_root=P('/proc')):
    profile_file=config or os.environ.get('CONTEXTKEEP_OPS_CONFIG')
    configured=bool(profile_file)
    profile=load_profile(config)
    profile_path=P(profile_file).expanduser() if configured else None
    if profile_path is not None and (profile_path.is_symlink() or not profile_path.is_file()):
        raise RuntimeError('Configured operations profile must be a regular file')
    if not configured:
        # Preserve the installed script's defaults when tests or an existing
        # unit invokes main with explicit legacy paths.
        profile.update({'home_dir':str(P(home).resolve()),'repo_dir':str(P(repo).resolve()),
                        'backup_dir':str(P(base).resolve()),'runtime_kit_dir':str(P(base).resolve()),
                        'data_dir':str((P(repo)/'apps/server/data').resolve()),
                        'release_dir':str((P(home)/'releases/contextkeep/current').resolve()),
                        'nas_mount':str(P(nas_mount).resolve()),
                        'nas_dir':str(P(nas_dir).resolve() if nas_dir is not None else P(nas_mount).resolve()/'backups/contextkeep')})
    base=P(profile['backup_dir']);home=P(profile['home_dir']);repo=P(profile['repo_dir'])
    nas_mount=profile['nas_mount'];nas_dir=P(profile['nas_dir'])
    runner=runner or run
    observed=runner(['hostname'])
    if not isinstance(observed,str):observed=getattr(observed,'stdout','')
    observed=observed.strip()
    runtime=None
    if configured:
        if observed != profile['primary_host']:
            raise RuntimeError('Configured primary host does not match this host')
        runtime=runtime_observer(profile,runner) if runtime_observer is not None else verify_running_process(runner,proc_root=proc_root)
        identity=validate_runtime_identity(profile,observed,runtime.get('data_dir'),runtime.get('release_dir'))
        identity.update({'verification':'running_process',**runtime})
        if node is None:node=runtime['node']
    else:
        identity=validate_runtime_identity(profile,observed,profile['data_dir'],profile['release_dir'],require_observed=False)
        identity['verification']='legacy_configured_paths_only'
    report=space_report(profile)
    if report_space or dry_run:
        result={'dry_run':bool(dry_run),'identity':identity,'space':report,'backup_dir':str(base)}
        print(json.dumps(result))
        return result
    old_umask=os.umask(0o077)
    try:
        base.mkdir(parents=True,exist_ok=True)
        with open(base/'backup.lock','a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            return backup(base,home,repo,base/'status.json',node,nas_mount,
                          nas_dir,runner,mounted or os.path.ismount,now,
                          profile=profile if configured else None,runtime=runtime,profile_path=profile_path)
    finally:
        os.umask(old_umask)

def backup(BASE,HOME,REPO,STATUS,node,nas_mount,NAS,run,mounted,now,profile=None,runtime=None,profile_path=None):
    if profile is not None:
        runtime=runtime or verify_running_process(run)
        validate_runtime_identity(profile,run(['hostname']).strip(),runtime.get('data_dir'),runtime.get('release_dir'))
    elif run(['hostname'])!='server':
        raise RuntimeError('Only the active primary may run this job')
    run(['systemctl','--user','is-active','contextkeep.service'])
    node=P(runtime['node']) if runtime is not None and node is None else (running_node(run) if node is None else P(node))
    now=now or dt.datetime.now(dt.timezone.utc);stamp=now.strftime('%Y%m%dT%H%M%SZ')
    release=(P(profile['release_dir']) if profile is not None else HOME/'releases/contextkeep/current').resolve(strict=True)
    data_dir=P(profile['data_dir']) if profile is not None else REPO/'apps/server/data'
    kit_dir=P(profile['runtime_kit_dir']) if profile is not None else BASE
    kit_dir.mkdir(parents=True,exist_ok=True)
    kit=kit_dir/('runtime-'+release.name+'.tar.gz')
    ensure_runtime_kit(kit,release,HOME,node)
    kit_hash=digest(kit)
    with tempfile.TemporaryDirectory(prefix='ck-snapshot-',dir=BASE) as tmp:
        tmp=P(tmp);db=tmp/'store.sqlite'
        with contextlib.closing(sqlite3.connect((data_dir/'store.sqlite').resolve().as_uri()+'?mode=ro',uri=True)) as src:
            with contextlib.closing(sqlite3.connect(db)) as dst:
                src.backup(dst)
                if dst.execute('pragma integrity_check').fetchall()!=[('ok',)]:raise ValueError('Snapshot integrity check failed')
                if dst.execute('pragma foreign_key_check').fetchall():raise ValueError('Snapshot foreign-key check failed')
                counts={t:dst.execute('select count(*) from '+t).fetchone()[0] for t in ['projects','records','sources']}
        manifest={'created_at':now.isoformat(),'primary':profile['primary_host'] if profile is not None else 'server','release':release.name,'db_sha256':digest(db),'runtime_kit':kit.name,'runtime_sha256':kit_hash,'counts':counts,'integrity':'ok'}
        write(tmp/'manifest.json',manifest)
        archive=BASE/('snapshot-'+stamp+'.tar.gz')
        part=archive.with_suffix('.partial')
        try:
            with tarfile.open(part,'w:gz',compresslevel=1) as t:
                t.add(db,arcname='store.sqlite');t.add(tmp/'manifest.json',arcname='manifest.json')
                t.add(REPO/'apps/server/.env',arcname='config/app.env')
                for n in ['mcp.env','secrets.env','release.env','tunnel.env','mcp-authorization','mcp-tunnel.yaml','codex-env.sh']:
                    t.add(HOME/'.config/contextkeep'/n,arcname='config/'+n)
                if profile_path is not None:
                    t.add(profile_path,arcname='config/contextkeep-ops-profile.json',recursive=False)
                for n in ['contextkeep.service','contextkeep.service.d','contextkeep-mcp-tunnel.service','contextkeep-backup.service','contextkeep-backup.timer']:
                    p=HOME/'.config/systemd/user'/n
                    if p.exists():t.add(p,arcname='systemd/'+n)
                for n in ['ops','docs/operations','docs/archive/trackers/CK_DR_TRACKER-2026-09-24.md']:
                    p=REPO/n
                    if p.exists():t.add(p,arcname='source/'+n)
            os.replace(part,archive)
        finally:
            part.unlink(missing_ok=True)
    ah=digest(archive)
    status={**manifest,'snapshot':archive.name,'snapshot_sha256':ah,'cadence_minutes':15,'retention':'96 recent + 30 daily snapshots; runtime kits retained','copies':{'server':{'ok':True,'verified_at':now.isoformat(),'path':str(archive),'sha256':ah}}}
    if STATUS.exists():
        old=json.loads(STATUS.read_text())
        if 'restore_test' in old:status['restore_test']=old['restore_test']
    remote_target=profile['dell_target'] if profile is not None else 'operator@100.64.0.142'
    remote_dir=profile['dell_dir'] if profile is not None else '/home/operator/backups/contextkeep'
    for target in ['dell','nas']:
        try:
            if target=='dell':
                remote=remote_target;dest=remote_dir
                quoted_dest=shlex.quote(dest)
                run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8',remote,'mkdir -p -- '+quoted_dest+' && chmod 700 -- '+quoted_dest])
                run(['rsync','-a','--timeout=60',str(kit),str(archive),remote+':'+shlex.quote(dest+'/')])
                for p,h in [(kit,kit_hash),(archive,ah)]:
                    actual=run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8',remote,'sha256sum -- '+shlex.quote(dest+'/'+p.name)]).split()[0]
                    if actual!=h:raise ValueError('Dell hash mismatch: '+p.name)
                path=dest+'/'+archive.name
            else:
                if not mounted(nas_mount):raise RuntimeError('NAS mount missing')
                dest=NAS;dest.mkdir(parents=True,exist_ok=True)
                for p,h in [(kit,kit_hash),(archive,ah)]:
                    out=dest/p.name
                    if not out.exists() or digest(out)!=h:
                        part=out.with_suffix('.partial')
                        try:
                            shutil.copyfile(p,part);os.replace(part,out)
                        finally:
                            part.unlink(missing_ok=True)
                    if digest(out)!=h:raise ValueError('NAS hash mismatch: '+p.name)
                path=str(dest/archive.name);prune(dest)
            status['copies'][target]={'ok':True,'verified_at':now.isoformat(),'path':path,'sha256':ah,'runtime_sha256':kit_hash}
        except Exception as e:
            status['copies'][target]={'ok':False,'error':type(e).__name__+': '+str(e)[:250]}
        write(STATUS,status)
    prune(BASE)
    # Retention only affects this job's timestamped snapshots, never live data.
    if status['copies'].get('dell',{}).get('ok'):
        try:
            code="from pathlib import Path\n"+__import__('inspect').getsource(prune)+f"\nprune(Path({remote_dir!r}))"
            run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8',remote_target,'python3 -'],input=code)
        except Exception as e:
            status['copies']['dell'].update(ok=False,error='Retention failed: '+str(e)[:250])
    targets=['dell','nas']
    status['publication']={target:{'ok':True} for target in ['server',*targets]}
    # Outcomes only move from success to failure. If a later publication fails,
    # restart with the corrected document so earlier reachable replicas cannot
    # retain green claims about that failure. At most N+1 rounds are necessary.
    for _ in range(len(targets)+1):
        write(STATUS,status)
        changed=False
        for target in targets:
            if not status['publication'][target]['ok']:continue
            try:
                if target=='dell':
                    run(['rsync','-a','--timeout=60',str(STATUS),remote_target+':'+shlex.quote(remote_dir+'/')])
                else:
                    if not mounted(nas_mount):raise RuntimeError('NAS mount missing for status publication')
                    write(NAS/'status.json',status)
            except Exception as e:
                message='Status publication failed: '+str(e)[:250]
                status['publication'][target].update(ok=False,error=message)
                status['copies'][target]['ok']=False
                status['copies'][target].setdefault('error',message)
                changed=True
                break
        if not changed:break
    # Unreachable replicas cannot be updated; primary explicitly marks them
    # failed. Every reachable status destination received the same final document,
    # even when its snapshot/runtime verification or retention failed.
    write(STATUS,status)
    print(json.dumps({'snapshot':archive.name,'counts':counts,'copies':{k:v['ok'] for k,v in status['copies'].items()}}))
    if not all(v['ok'] for v in status['copies'].values()):raise SystemExit(1)
    return status
if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--config',help='Private JSON operations profile; CONTEXTKEEP_OPS_CONFIG is also supported')
    parser.add_argument('--dry-run',action='store_true',help='Validate primary/data/runtime identity and report space without mutation')
    parser.add_argument('--report-space',action='store_true',help='Report runtime-kit capacity without running a backup')
    args=parser.parse_args()
    main(config=args.config,dry_run=args.dry_run,report_space=args.report_space)
