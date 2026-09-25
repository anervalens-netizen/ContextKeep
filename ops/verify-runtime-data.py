#!/usr/bin/env python3
"""Read-only proof that a Linux service serves its intended release and database.

A selected release and a successful HTTP probe cannot detect an environment
file override that redirects CK_DATA_DIR. Check the running process and the
open SQLite inode as well. This command never prints other environment values.
"""
import argparse
import json
import os
import stat
from pathlib import Path
import subprocess


def process_identity(proc):
    # comm may contain spaces and closing parentheses; fields after the final
    # ')' start with field 3. Field 22 (starttime) prevents a PID-reuse success.
    fields=(proc/'stat').read_text().rsplit(')',1)[1].split()
    return fields[19]


def verify_runtime_data(pid,data_dir,*,release,node,proc_root=Path('/proc')):
    if type(pid) is not int or pid<=1:
        raise ValueError('A live service PID greater than one is required')
    proc=Path(proc_root)/str(pid)
    identity=process_identity(proc)
    cwd=(proc/'cwd').resolve(strict=True)
    expected=Path(data_dir).resolve(strict=True)
    env={}
    for entry in (proc/'environ').read_bytes().split(b'\0'):
        if b'=' in entry:
            key,value=entry.split(b'=',1)
            if key in {b'CK_DATA_DIR',b'CK_BUILD_SHA',b'NODE_OPTIONS'}:
                name=key.decode()
                if name in env:
                    raise RuntimeError('Duplicate runtime environment key prevents unambiguous verification')
                env[name]=os.fsdecode(value)
    if env.get('NODE_OPTIONS','').strip():
        raise RuntimeError('NODE_OPTIONS must be empty for the supported direct Node launch proof')
    configured=env.get('CK_DATA_DIR')
    if not configured:
        raise RuntimeError('Running service has no explicit CK_DATA_DIR')
    configured_path=Path(configured)
    actual=(configured_path if configured_path.is_absolute() else cwd/configured_path).resolve(strict=True)
    if actual!=expected:
        raise RuntimeError('Running CK_DATA_DIR differs from the expected database directory')
    database=expected/'store.sqlite'
    database_stat=database.lstat()
    if not stat.S_ISREG(database_stat.st_mode) or database_stat.st_nlink!=1:
        raise RuntimeError('Refusing an aliased database or non-regular SQLite file')
    database_identity=(database_stat.st_dev,database_stat.st_ino)
    opened=False
    for descriptor in (proc/'fd').iterdir():
        try:
            if os.path.samefile(descriptor,database):
                opened=True
                break
        except FileNotFoundError:
            # Individual descriptors may legitimately close during the scan.
            continue
    if not opened:
        raise RuntimeError('Running process does not hold the expected SQLite inode')
    release_path=Path(release).resolve(strict=True)
    if cwd!=(release_path/'apps/server').resolve(strict=True):
        raise RuntimeError('Running cwd differs from the expected pinned release')
    if env.get('CK_BUILD_SHA')!=release_path.name:
        raise RuntimeError('Running CK_BUILD_SHA differs from the pinned release')
    entry=(release_path/'apps/server/dist/server.js').resolve(strict=True)
    if not entry.is_relative_to(release_path):
        raise RuntimeError('Pinned server entry point escapes the release')
    argv=(proc/'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
    if len(argv)!=2 or not argv[1] or argv[1].startswith(b'-'):
        raise RuntimeError('Runtime proof requires the supported direct Node server.js launch')
    invoked=Path(os.fsdecode(argv[1]))
    invoked=(invoked if invoked.is_absolute() else cwd/invoked).resolve(strict=True)
    if invoked!=entry:
        raise RuntimeError('Executed server entry point differs from the pinned release')
    executable=(proc/'exe').resolve(strict=True)
    if executable!=Path(node).resolve(strict=True):
        raise RuntimeError('Running interpreter differs from the validated interpreter')
    if process_identity(proc)!=identity:
        raise RuntimeError('Service process identity changed during verification')
    final_database_stat=database.lstat()
    if (not stat.S_ISREG(final_database_stat.st_mode) or final_database_stat.st_nlink!=1 or
            (final_database_stat.st_dev,final_database_stat.st_ino)!=database_identity):
        raise RuntimeError('Expected database changed during verification')
    return {'status':'PASS','pid':pid,'dataDir':str(expected),'databaseInodeVerified':True,
            'cwd':str(cwd),'entryPoint':str(entry),'node':str(executable),'buildSha':env.get('CK_BUILD_SHA')}


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid',type=int)
    parser.add_argument('--data-dir',required=True)
    parser.add_argument('--release',required=True)
    parser.add_argument('--node',required=True)
    args=parser.parse_args(argv)
    pid=args.pid
    if pid is None:
        result=subprocess.run(['systemctl','--user','show','contextkeep.service','-p','MainPID','--value'],
                              check=True,capture_output=True,text=True,timeout=10)
        pid=int(result.stdout.strip())
    result=verify_runtime_data(pid,args.data_dir,release=args.release,node=args.node)
    print(json.dumps(result))
    return result


if __name__=='__main__':
    main()
