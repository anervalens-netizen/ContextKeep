"""Offline workflow regressions. Run with Python 3.12's unittest runner."""
import contextlib
import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import shutil
import sqlite3
import sys
import subprocess
import tarfile
import tempfile
import unittest
import shlex
from unittest import mock

P=pathlib.Path
OPS=P(__file__).resolve().parent


def load(name):
    spec=importlib.util.spec_from_file_location(name.replace('-','_'),OPS/(name+'.py'))
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


backup=load('backup-three-hosts')
restore=load('restore-snapshot')


def put(file,content='fixture'):
    file.parent.mkdir(parents=True,exist_ok=True)
    file.write_text(content)


def make_db(file):
    file.parent.mkdir(parents=True,exist_ok=True)
    with contextlib.closing(sqlite3.connect(file)) as db:
        for table in ['projects','records','sources']:
            db.execute('CREATE TABLE '+table+' (id INTEGER PRIMARY KEY)')
            db.execute('INSERT INTO '+table+' VALUES (1)')
        db.commit()


class BackupWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='ck-ops-test-')
        self.addCleanup(self.temp.cleanup)
        self.root=P(self.temp.name)
        self.base=self.root/'backups'
        self.home=self.root/'home'
        self.repo=self.root/'repo'
        self.nas=self.root/'nas'
        self.remote=self.root/'dell'
        self.remote.mkdir()
        self.node=self.root/'node'
        put(self.node,'node fixture')
        self.release=self.home/'releases/contextkeep'/'abcdef123456'
        put(self.release/'package.json','{}')
        put(self.release/'apps/server/dist/cli/restore.js','// fixture')
        (self.release.parent/'current').symlink_to(self.release,target_is_directory=True)
        put(self.home/'.local/lib/contextkeep-tunnel/main.js')
        put(self.repo/'apps/server/.env')
        for name in ['mcp.env','secrets.env','release.env','tunnel.env','mcp-authorization','mcp-tunnel.yaml','codex-env.sh']:
            put(self.home/'.config/contextkeep'/name)
        make_db(self.repo/'apps/server/data/store.sqlite')
        self.calls=[]
        self.corrupt_remote=False
        self.fail_publication=False
        self.available=True
        self.now=dt.datetime(2026,9,25,12,0,tzinfo=dt.timezone.utc)

    def runner(self,args,**kwargs):
        self.calls.append(args)
        if args==['hostname']:return 'server'
        if args[0]=='systemctl':return 'active'
        if args[0]=='rsync':
            sources=[P(a) for a in args[1:-1] if not a.startswith('-')]
            if self.fail_publication and any(p.name=='status.json' for p in sources):
                raise RuntimeError('publication unavailable')
            for source in sources:
                shutil.copyfile(source,self.remote/source.name)
                if self.corrupt_remote and source.name.startswith('snapshot-'):
                    (self.remote/source.name).write_bytes(b'corrupt transfer')
            return ''
        if args[0]=='ssh':
            command=args[-1]
            if command.startswith('mkdir -p -- '):return ''
            if command.startswith('sha256sum -- '):
                name=P(shlex.split(command)[-1]).name
                return backup.digest(self.remote/name)+'  '+name
            if command=='python3 -':return ''
        raise AssertionError('Unexpected external command: '+repr(args))

    def invoke(self):
        return backup.main(base=self.base,home=self.home,repo=self.repo,node=self.node,
                           nas_mount=str(self.root/'mount'),nas_dir=self.nas,
                           runner=self.runner,mounted=lambda _:self.available,now=self.now)

    def status(self):
        return json.loads((self.base/'status.json').read_text())

    def test_real_archive_and_verified_copies(self):
        output=io.StringIO()
        with contextlib.redirect_stdout(output):status=self.invoke()
        self.assertEqual(status['primary'],'server')
        self.assertEqual(status['cadence_minutes'],15)
        self.assertEqual(status['counts'],{'projects':1,'records':1,'sources':1})
        self.assertTrue(all(copy['ok'] for copy in status['copies'].values()))
        for directory in [self.base,self.remote,self.nas]:
            self.assertEqual(backup.digest(directory/status['snapshot']),status['snapshot_sha256'])
            self.assertEqual(backup.digest(directory/status['runtime_kit']),status['runtime_sha256'])
        with tempfile.TemporaryDirectory() as tmp:
            manifest=restore.unpack_snapshot(self.base/status['snapshot'],P(tmp))
            restore.verify_database(P(tmp)/'store.sqlite',manifest['counts'])
        self.assertTrue(json.loads(output.getvalue())['copies']['nas'])

    def test_nas_unavailable_does_not_prevent_dell_success(self):
        self.available=False
        with contextlib.redirect_stdout(io.StringIO()),self.assertRaises(SystemExit) as error:
            self.invoke()
        self.assertEqual(error.exception.code,1)
        status=self.status()
        self.assertTrue(status['copies']['dell']['ok'])
        self.assertFalse(status['copies']['nas']['ok'])
        self.assertIn('NAS mount missing',status['copies']['nas']['error'])
        self.assertFalse(self.nas.exists())
        self.assertEqual(backup.digest(self.remote/status['snapshot']),status['snapshot_sha256'])

    def test_dell_hash_mismatch_still_allows_nas_copy(self):
        self.corrupt_remote=True
        with contextlib.redirect_stdout(io.StringIO()),self.assertRaises(SystemExit):self.invoke()
        status=self.status()
        self.assertFalse(status['copies']['dell']['ok'])
        self.assertIn('hash mismatch',status['copies']['dell']['error'])
        self.assertTrue(status['copies']['nas']['ok'])
        self.assertEqual(backup.digest(self.nas/status['snapshot']),status['snapshot_sha256'])

    def test_nas_copy_hash_is_checked_after_transfer(self):
        original=shutil.copyfile
        def copy(source,destination,*args,**kwargs):
            result=original(source,destination,*args,**kwargs)
            destination=P(destination)
            if destination.parent==self.nas and destination.suffix=='.partial':
                destination.write_bytes(b'bad NAS copy')
            return result
        with mock.patch.object(backup.shutil,'copyfile',side_effect=copy),contextlib.redirect_stdout(io.StringIO()),self.assertRaises(SystemExit):
            self.invoke()
        status=self.status()
        self.assertTrue(status['copies']['dell']['ok'])
        self.assertFalse(status['copies']['nas']['ok'])
        self.assertIn('hash mismatch',status['copies']['nas']['error'])

    def test_invalid_existing_runtime_kit_is_not_reused_or_overwritten(self):
        self.base.mkdir()
        kit=self.base/('runtime-'+self.release.name+'.tar.gz')
        for content in [b'not gzip',b'']:
            kit.write_bytes(content)
            with self.assertRaises((ValueError,tarfile.TarError,EOFError,OSError)):
                self.invoke()
            self.assertEqual(kit.read_bytes(),content)
            self.assertFalse(list(self.base.glob('snapshot-*.tar.gz')))
        with tarfile.open(kit,'w:gz') as archive:
            archive.add(self.node,arcname='node')
        original=kit.read_bytes()
        with self.assertRaisesRegex(ValueError,'missing required'):self.invoke()
        self.assertEqual(kit.read_bytes(),original)
        self.assertFalse(any(args[0]=='rsync' for args in self.calls))

    def test_remote_status_publication_failure_is_a_failed_job(self):
        self.fail_publication=True
        output=io.StringIO()
        with contextlib.redirect_stdout(output),self.assertRaises(SystemExit):self.invoke()
        self.assertFalse(self.status()['copies']['dell']['ok'])
        self.assertIn('Status publication failed',self.status()['copies']['dell']['error'])
        self.assertFalse(json.loads(output.getvalue())['copies']['dell'])
        self.assertTrue(self.status()['copies']['nas']['ok'])

    def test_late_nas_status_failure_is_republished_to_dell(self):
        original=backup.write
        def write(file,value):
            if file==self.nas/'status.json':raise OSError('NAS metadata unavailable')
            return original(file,value)
        with mock.patch.object(backup,'write',side_effect=write),contextlib.redirect_stdout(io.StringIO()),self.assertRaises(SystemExit):
            self.invoke()
        authoritative=self.status()
        self.assertFalse(authoritative['copies']['nas']['ok'])
        self.assertTrue(authoritative['copies']['dell']['ok'])
        self.assertEqual(json.loads((self.remote/'status.json').read_text()),authoritative)

    def test_publication_failure_cascade_is_bounded_and_primary_is_not_green(self):
        original_write=backup.write
        original_runner=self.runner
        publications=0
        def runner(args,**kwargs):
            nonlocal publications
            if args[0]=='rsync' and any(P(arg).name=='status.json' for arg in args[1:-1]):
                publications+=1
                if publications>1:raise RuntimeError('Dell became unavailable')
            return original_runner(args,**kwargs)
        def write(file,value):
            if file==self.nas/'status.json':raise OSError('NAS metadata unavailable')
            return original_write(file,value)
        with mock.patch.object(self,'runner',side_effect=runner),mock.patch.object(backup,'write',side_effect=write),contextlib.redirect_stdout(io.StringIO()),self.assertRaises(SystemExit):
            self.invoke()
        self.assertFalse(self.status()['copies']['nas']['ok'])
        self.assertFalse(self.status()['copies']['dell']['ok'])
        self.assertEqual(publications,2)

    def test_failed_data_verification_is_published_to_reachable_dell(self):
        put(self.remote/'status.json',json.dumps({'copies':{'dell':{'ok':True}}}))
        self.corrupt_remote=True
        with contextlib.redirect_stdout(io.StringIO()),self.assertRaises(SystemExit):self.invoke()
        self.assertFalse(self.status()['copies']['dell']['ok'])
        self.assertTrue(self.status()['publication']['dell']['ok'])
        self.assertEqual(json.loads((self.remote/'status.json').read_text()),self.status())

    def test_nas_failed_snapshot_copy_still_receives_failure_metadata(self):
        put(self.nas/'status.json',json.dumps({'copies':{'nas':{'ok':True}}}))
        original=backup.shutil.copyfile
        def copy(source,destination,*args,**kwargs):
            if P(destination).parent==self.nas:
                put(P(destination),'incomplete transfer')
                raise OSError('NAS data copy refused')
            return original(source,destination,*args,**kwargs)
        with mock.patch.object(backup.shutil,'copyfile',side_effect=copy),contextlib.redirect_stdout(io.StringIO()),self.assertRaises(SystemExit):self.invoke()
        self.assertFalse(self.status()['copies']['nas']['ok'])
        self.assertTrue(self.status()['publication']['nas']['ok'])
        self.assertFalse(list(self.nas.glob('*.partial')))
        self.assertEqual(json.loads((self.nas/'status.json').read_text()),self.status())

    def test_retention_failure_still_receives_current_status(self):
        original=self.runner
        def runner(args,**kwargs):
            if args[0]=='ssh' and args[-1]=='python3 -':raise RuntimeError('retention unavailable')
            return original(args,**kwargs)
        with mock.patch.object(self,'runner',side_effect=runner),contextlib.redirect_stdout(io.StringIO()),self.assertRaises(SystemExit):self.invoke()
        self.assertIn('Retention failed',self.status()['copies']['dell']['error'])
        self.assertTrue(self.status()['publication']['dell']['ok'])
        self.assertEqual(json.loads((self.remote/'status.json').read_text()),self.status())

    def test_node_selection_uses_running_service_not_usr_bin_default(self):
        proc=self.root/'proc'
        (proc/'123').mkdir(parents=True)
        (proc/'123'/'exe').symlink_to(self.node)
        called=[]
        def runner(command):called.append(command);return '123'
        self.assertEqual(backup.running_node(runner,proc),self.node.resolve())
        self.assertEqual(called,[['systemctl','--user','show','contextkeep.service','--property=MainPID','--value']])
        for pid in ['0','1','unknown','-5','123/../other']:
            with self.subTest(pid=pid),self.assertRaises(RuntimeError):backup.running_node(lambda _:pid,proc)

    def test_local_status_publication_failure_propagates_without_success_output(self):
        original=backup.write
        def write(file,value):
            if file==self.base/'status.json':raise OSError('disk full')
            return original(file,value)
        output=io.StringIO()
        with mock.patch.object(backup,'write',side_effect=write),contextlib.redirect_stdout(output),self.assertRaisesRegex(OSError,'disk full'):
            self.invoke()
        self.assertEqual(output.getvalue(),'')
        # Failure must also release the per-run flock.
        with open(self.base/'backup.lock','a') as lock:
            backup.fcntl.flock(lock,backup.fcntl.LOCK_EX|backup.fcntl.LOCK_NB)

    def test_restore_test_status_survives_next_backup(self):
        self.base.mkdir()
        prior={'restore_test':{'ok':True,'tested_at':'2026-09-24'}}
        backup.write(self.base/'status.json',prior)
        with contextlib.redirect_stdout(io.StringIO()):status=self.invoke()
        self.assertEqual(status['restore_test'],prior['restore_test'])

    def test_failed_archive_has_no_partial_or_successful_snapshot(self):
        (self.home/'.config/contextkeep/mcp.env').unlink()
        with self.assertRaises(FileNotFoundError):
            self.invoke()
        self.assertFalse(list(self.base.glob('snapshot-*.partial')))
        self.assertFalse(list(self.base.glob('snapshot-*.tar.gz')))
        self.assertFalse(any(args[0]=='rsync' for args in self.calls))

    def test_node_symlink_is_packed_as_a_self_contained_binary(self):
        executable=self.root/'node-real'
        self.node.rename(executable)
        self.node.symlink_to(executable)
        with contextlib.redirect_stdout(io.StringIO()):
            status=self.invoke()
        with tarfile.open(self.base/status['runtime_kit'],'r:gz') as archive:
            self.assertTrue(archive.getmember('node').isfile())
            self.assertEqual(archive.extractfile('node').read(),b'node fixture')

    def test_round_trip_keeps_auxiliary_symlinks_unextracted(self):
        env=self.repo/'apps/server/.env'
        env.unlink()
        actual=self.root/'real.env'
        put(actual,'private fixture config')
        env.symlink_to(actual)
        source_link=self.repo/'apps/server/data/sources'/'linked-note'
        source_link.parent.mkdir(parents=True)
        source_link.symlink_to(self.root/'unavailable-on-recovery')
        with contextlib.redirect_stdout(io.StringIO()):
            status=self.invoke()
        with tempfile.TemporaryDirectory() as directory:
            target=P(directory)
            manifest=restore.unpack_snapshot(self.base/status['snapshot'],target)
            restore.verify_database(target/'store.sqlite',manifest['counts'])
            self.assertEqual({entry.name for entry in target.iterdir()},{'store.sqlite','manifest.json'})
        self.assertEqual(actual.read_text(),'private fixture config')

    def profile(self, **changes):
        values={
            'primary_host':'server','home_dir':str(self.home),'repo_dir':str(self.repo),
            'backup_dir':str(self.base),'runtime_kit_dir':str(self.base),
            'data_dir':str(self.repo/'apps/server/data'),'release_dir':str(self.release),
            'nas_mount':str(self.root/'mount'),'nas_dir':str(self.nas),
            'dell_target':'synthetic-standby','dell_dir':str(self.remote),
            'runtime_release_name':None,
        }
        values.update(changes)
        filename=self.root/'ops-profile.json'
        filename.write_text(json.dumps(values))
        return filename

    def observed_runtime(self, profile, _runner):
        return {'pid':123,'data_dir':profile['data_dir'],'release_dir':profile['release_dir'],
                'node':str(self.node),'database_inode_verified':True}

    def test_profile_rejects_wrong_primary_and_runtime_before_backup_directory_creation(self):
        wrong_host=self.profile(primary_host='other-synthetic-host')
        with self.assertRaisesRegex(RuntimeError,'primary host'):
            backup.main(config=str(wrong_host),runner=self.runner)
        self.assertFalse(self.base.exists())
        self.assertEqual(self.calls,[['hostname']])

        wrong_runtime=self.profile(runtime_release_name='different-release')
        self.calls.clear()
        with self.assertRaisesRegex(RuntimeError,'release name'):
            backup.main(config=str(wrong_runtime),runner=self.runner,runtime_observer=self.observed_runtime)
        self.assertFalse(self.base.exists())
        self.assertEqual(self.calls,[['hostname']])

    def test_profile_dry_run_reports_runtime_kit_space_without_mutation(self):
        with contextlib.redirect_stdout(io.StringIO()):self.invoke()
        profile=self.profile()
        before=set(self.base.iterdir())
        self.calls.clear()
        output=io.StringIO()
        with contextlib.redirect_stdout(output):result=backup.main(config=str(profile),runner=self.runner,dry_run=True,runtime_observer=self.observed_runtime)
        self.assertTrue(result['dry_run'])
        self.assertEqual(result['space']['runtime_kit_count'],1)
        self.assertGreater(result['space']['runtime_kit_bytes'],0)
        self.assertEqual(set(self.base.iterdir()),before)
        self.assertEqual([call[0] for call in self.calls if call[0] in {'systemctl','rsync'}],[])
        self.assertEqual(json.loads(output.getvalue()),result)

    def test_profile_rejects_observed_wrong_paths_before_backup_creation(self):
        profile=self.profile()
        wrong_data=self.root/'wrong-data'
        wrong_release=self.root/'wrong-release'
        make_db(wrong_data/'store.sqlite')
        put(wrong_release/'package.json','{}')
        def observed(_profile, _runner):
            return {'pid':123,'data_dir':str(wrong_data),'release_dir':str(wrong_release),
                    'node':str(self.node),'database_inode_verified':True}
        with self.assertRaisesRegex(RuntimeError,'data identity'):
            backup.main(config=str(profile),runner=self.runner,runtime_observer=observed)
        self.assertFalse(self.base.exists())
        self.assertEqual(self.calls,[['hostname']])

    def test_separate_runtime_kit_is_archived_and_restore_uses_matching_release(self):
        kit_dir=self.root/'runtime kits'
        profile=self.profile(runtime_kit_dir=str(kit_dir))
        with contextlib.redirect_stdout(io.StringIO()):
            status=backup.main(config=str(profile),runner=self.runner,runtime_observer=self.observed_runtime,
                               mounted=lambda _:self.available,now=self.now)
        self.assertTrue((kit_dir/status['runtime_kit']).is_file())
        self.assertFalse((self.base/status['runtime_kit']).exists())
        with tarfile.open(self.base/status['snapshot'],'r:gz') as archive:
            member=archive.getmember('config/contextkeep-ops-profile.json')
            self.assertEqual(archive.extractfile(member).read(),profile.read_bytes())
            manifest=json.loads(archive.extractfile(archive.getmember('manifest.json')).read())
        self.assertEqual(manifest['runtime_kit'],status['runtime_kit'])

        target=self.root/'restored-data'
        def restore_runner(args, **kwargs):
            target_path=P(kwargs['env']['CK_DATA_DIR'])
            target_path.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(args[2],target_path/'store.sqlite')
            return subprocess.CompletedProcess(args,0)
        result=restore.restore_snapshot(self.base/status['snapshot'],target,self.node,self.release,
                                        runner=restore_runner,environ={'SYNTHETIC':'yes'})
        self.assertEqual(result['integrity'],'ok')

    def test_remote_path_quoting_handles_spaces_and_apostrophes(self):
        remote_dir=self.root/"dell dir/owner's snapshots"
        profile=self.profile(dell_dir=str(remote_dir))
        with contextlib.redirect_stdout(io.StringIO()):
            backup.main(config=str(profile),runner=self.runner,runtime_observer=self.observed_runtime,
                        mounted=lambda _:self.available,now=self.now)
        commands=[args[-1] for args in self.calls if args[0]=='ssh']
        self.assertIn('mkdir -p -- '+shlex.quote(str(remote_dir))+' && chmod 700 -- '+shlex.quote(str(remote_dir)),commands)
        self.assertTrue(any(command == 'sha256sum -- '+shlex.quote(str(remote_dir)+'/runtime-abcdef123456.tar.gz') for command in commands))
        rsync_dest=[args[-1] for args in self.calls if args[0]=='rsync' and ':' in args[-1]]
        self.assertTrue(any(rsync_dest and shlex.quote(str(remote_dir)+'/') in value for value in rsync_dest))

    def test_profile_rejects_malformed_remote_targets_without_restricting_valid_aliases(self):
        for target in ['-oProxyCommand=bad', 'host\n--bad', 'user@@host', 'host:not-a-port']:
            with self.subTest(target=target),self.assertRaisesRegex(ValueError,'invalid dell_target'):
                backup.load_profile(str(self.profile(dell_target=target)))
        valid=self.profile(dell_target='any-user@[fd00::1]:2222')
        self.assertEqual(backup.load_profile(str(valid))['dell_target'],'any-user@[fd00::1]:2222')


class RestoreWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='ck-restore-ops-test-')
        self.addCleanup(self.temp.cleanup)
        self.root=P(self.temp.name)
        self.db=self.root/'source.sqlite'
        make_db(self.db)
        self.release=self.root/'abcdef123456'
        put(self.release/'apps/server/dist/cli/restore.js')
        self.target=self.root/'custom-data'
        self.snapshot=self.root/'snapshot.tar.gz'
        self.manifest={'release':self.release.name,'db_sha256':hashlib.sha256(self.db.read_bytes()).hexdigest(),
                       'counts':{'projects':1,'records':1,'sources':1}}
        self.pack()
        self.calls=[]

    def pack(self,extra=None,duplicate=False):
        manifest=self.root/'manifest.json'
        manifest.write_text(json.dumps(self.manifest))
        with tarfile.open(self.snapshot,'w:gz') as archive:
            archive.add(self.db,arcname='store.sqlite')
            archive.add(manifest,arcname='manifest.json')
            if duplicate:archive.add(self.db,arcname='store.sqlite')
            if extra is not None:
                archive.addfile(extra,io.BytesIO(b'x') if extra.isfile() else None)

    def runner(self,args,**kwargs):
        self.calls.append((args,kwargs))
        self.assertNotIn('--service-stopped',args)
        target=P(kwargs['env']['CK_DATA_DIR'])
        target.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(args[2],target/'store.sqlite')
        return subprocess.CompletedProcess(args,0)

    def invoke(self,**kwargs):
        return restore.restore_snapshot(self.snapshot,self.target,'node',self.release,
                                        runner=kwargs.pop('runner',self.runner),environ={'TEST':'yes'},**kwargs)

    def test_custom_target_workflow_and_readback(self):
        result=self.invoke()
        self.assertEqual(result,{'restored':str(self.target),'counts':self.manifest['counts'],'integrity':'ok'})
        self.assertEqual(len(self.calls),1)
        self.assertEqual(self.calls[0][1]['env']['TEST'],'yes')

    def test_restore_dry_run_validates_archive_without_invoking_writer(self):
        result=self.invoke(dry_run=True)
        self.assertEqual(result,{'dry_run':True,'target':str(self.target),'release':self.manifest['release'],'counts':self.manifest['counts'],'integrity':'ok'})
        self.assertEqual(self.calls,[])
        self.assertFalse(self.target.exists())

    def test_snapshot_hash_mismatch_never_invokes_cli_or_changes_target(self):
        put(self.target/'owner-file','unchanged')
        self.manifest['db_sha256']='0'*64
        self.pack()
        with self.assertRaisesRegex(ValueError,'hash mismatch'):self.invoke()
        self.assertEqual(self.calls,[])
        self.assertEqual((self.target/'owner-file').read_text(),'unchanged')
        self.assertFalse((self.target/'store.sqlite').exists())

    def test_unsafe_and_duplicate_archive_members_are_rejected_before_cli(self):
        for name,kind in [('../escape',tarfile.REGTYPE),('/absolute',tarfile.REGTYPE),('device',tarfile.CHRTYPE)]:
            with self.subTest(name=name):
                member=tarfile.TarInfo(name);member.type=kind
                member.size=1 if kind==tarfile.REGTYPE else 0
                member.linkname='../../outside'
                self.pack(extra=member)
                with self.assertRaisesRegex(ValueError,'Unsafe'):self.invoke()
        self.pack(duplicate=True)
        with self.assertRaisesRegex(ValueError,'duplicate'):self.invoke()
        self.assertEqual(self.calls,[])
        self.assertFalse(self.target.exists())

    def test_linked_database_or_manifest_is_rejected_before_cli(self):
        manifest=self.root/'manifest.json'
        manifest.write_text(json.dumps(self.manifest))
        for critical in ['store.sqlite','manifest.json']:
            for kind in [tarfile.SYMTYPE,tarfile.LNKTYPE]:
                with self.subTest(critical=critical,kind=kind):
                    with tarfile.open(self.snapshot,'w:gz') as archive:
                        for name,file in [('store.sqlite',self.db),('manifest.json',manifest)]:
                            if name==critical:
                                member=tarfile.TarInfo(name)
                                member.type=kind
                                member.linkname='../../outside'
                                archive.addfile(member)
                            else:
                                archive.add(file,arcname=name)
                    with self.assertRaisesRegex(ValueError,'snapshot file'):
                        self.invoke()
        self.assertEqual(self.calls,[])
        self.assertFalse(self.target.exists())

    def test_auxiliary_links_are_never_materialized_or_followed(self):
        outside=self.root/'outside'
        put(outside,'unchanged sentinel')
        for name,kind in [('config/link',tarfile.SYMTYPE),('sources/hardlink',tarfile.LNKTYPE)]:
            member=tarfile.TarInfo(name)
            member.type=kind
            member.linkname=str(outside)
            self.pack(extra=member)
            with tempfile.TemporaryDirectory() as directory:
                destination=P(directory)
                restore.unpack_snapshot(self.snapshot,destination)
                self.assertEqual({p.name for p in destination.iterdir()},{'store.sqlite','manifest.json'})
            self.assertEqual(outside.read_text(),'unchanged sentinel')

    def test_manifest_cannot_supply_sql_identifiers(self):
        self.manifest['counts']={'projects; DROP TABLE projects':1}
        self.pack()
        with self.assertRaisesRegex(ValueError,'Invalid snapshot counts'):self.invoke()
        self.assertEqual(self.calls,[])

    def test_release_or_counts_mismatch_prevents_cli(self):
        self.manifest['release']='different-release'
        self.pack()
        with self.assertRaisesRegex(ValueError,'exact matching'):self.invoke()
        self.manifest['release']=self.release.name
        self.manifest['counts']['records']=2
        self.pack()
        with self.assertRaisesRegex(ValueError,'count mismatch'):self.invoke()
        self.assertEqual(self.calls,[])

    def test_symlinked_live_target_and_unknown_service_fail_closed(self):
        self.target.mkdir()
        alias=self.root/'alias'
        alias.symlink_to(self.target,target_is_directory=True)
        for returncode,output in [(0,'LoadState=loaded\nActiveState=active\n'),(0,'LoadState=not-found\nActiveState=inactive\n'),(1,''),(0,'LoadState=loaded\n')]:
            with self.subTest(output=output):
                runner=mock.Mock(return_value=subprocess.CompletedProcess([],returncode,stdout=output))
                with self.assertRaisesRegex(RuntimeError,'state is unknown'):
                    restore.restore_snapshot(self.snapshot,alias,'node',self.release,runner=runner,live_data=self.target)
                self.assertEqual(runner.call_count,1)
                self.assertEqual(runner.call_args.args[0][0],'systemctl')
        self.assertFalse((self.target/'store.sqlite').exists())

    def test_stopped_service_allows_cli_but_cli_failure_is_not_success(self):
        def runner(args,**kwargs):
            if args[0]=='systemctl':
                return subprocess.CompletedProcess(args,0,stdout='LoadState=loaded\nActiveState=inactive\n')
            raise subprocess.CalledProcessError(1,args)
        with self.assertRaises(subprocess.CalledProcessError):self.invoke(runner=runner,live_data=self.target)
        self.assertFalse((self.target/'store.sqlite').exists())

    def test_post_restore_count_mismatch_is_not_reported_as_success(self):
        def runner(args,**kwargs):
            result=self.runner(args,**kwargs)
            with contextlib.closing(sqlite3.connect(self.target/'store.sqlite')) as db:
                db.execute('DELETE FROM records');db.commit()
            return result
        with self.assertRaisesRegex(ValueError,'count mismatch'):self.invoke(runner=runner)


class ImportSafetyTests(unittest.TestCase):
    def test_import_does_not_parse_args_touch_storage_or_run_commands(self):
        with mock.patch('subprocess.run',side_effect=AssertionError('subprocess at import')), \
             mock.patch('argparse.ArgumentParser.parse_args',side_effect=AssertionError('arguments at import')), \
             mock.patch.object(P,'mkdir',side_effect=AssertionError('mkdir at import')), \
             mock.patch.object(P,'exists',side_effect=AssertionError('exists at import')), \
             mock.patch('sqlite3.connect',side_effect=AssertionError('database at import')), \
             mock.patch('tarfile.open',side_effect=AssertionError('archive at import')), \
             mock.patch('builtins.print',side_effect=AssertionError('output at import')):
            load('backup-three-hosts')
            load('restore-snapshot')





class RuntimeDataIdentityTests(unittest.TestCase):
    """A healthy old fixture must never be mistaken for the restored writer."""
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='ck-runtime-identity-')
        self.addCleanup(self.temp.cleanup)
        self.root=P(self.temp.name)
        self.proc=self.root/'proc'/'123'
        self.proc.mkdir(parents=True)
        (self.proc/'fd').mkdir()
        self.data=self.root/'data'
        make_db(self.data/'store.sqlite')
        self.release=self.root/'release-sha'
        (self.release/'apps/server').mkdir(parents=True)
        put(self.release/'package.json','{}')
        self.entry=self.release/'apps/server/dist/server.js'
        put(self.entry,'server fixture')
        (self.proc/'cmdline').write_bytes(('node\0'+str(self.entry)+'\0').encode())
        self.node=self.root/'node'
        put(self.node,'interpreter fixture')
        (self.proc/'cwd').symlink_to(self.release/'apps/server')
        (self.proc/'exe').symlink_to(self.node)
        (self.proc/'fd/15').symlink_to(self.data/'store.sqlite')
        put(self.proc/'stat','123 (node worker) '+' '.join(['S']+['0']*18+['555']+['0']*10))
        self.write_env(self.data)
        self.module=load('verify-runtime-data')

    def write_env(self,data):
        (self.proc/'environ').write_bytes(('CK_DATA_DIR='+str(data)+'\0CK_BUILD_SHA=release-sha\0UNRELATED_SECRET=not-for-output\0').encode())

    def test_backup_process_observer_binds_synthetic_service_identity(self):
        result=backup.verify_running_process(lambda _: '123',proc_root=self.root/'proc')
        self.assertEqual(result['pid'],123)
        self.assertEqual(result['data_dir'],str(self.data.resolve()))
        self.assertEqual(result['release_dir'],str(self.release.resolve()))
        self.assertTrue(result['database_inode_verified'])
        self.assertNotIn('not-for-output',json.dumps(result))

    def test_backup_process_observer_rejects_unsupported_proc_root(self):
        with self.assertRaisesRegex(RuntimeError,'unsupported'):
            backup.verify_running_process(lambda _: '123',proc_root=self.root/'missing-proc')

    def verify(self):
        return self.module.verify_runtime_data(123,self.data,release=self.release,node=self.node,proc_root=self.root/'proc')

    def test_matching_configured_path_and_open_inode(self):
        result=self.verify()
        self.assertEqual(result['status'],'PASS')
        self.assertNotIn('not-for-output',json.dumps(result))
        self.assertTrue(result['databaseInodeVerified'])

    def test_late_environment_override_is_rejected(self):
        other=self.root/'old-preview'
        make_db(other/'store.sqlite')
        self.write_env(other)
        with self.assertRaisesRegex(RuntimeError,'CK_DATA_DIR differs'):self.verify()

    def test_symlink_directory_alias_is_canonicalized(self):
        alias=self.root/'data-alias';alias.symlink_to(self.data)
        self.write_env(alias)
        self.assertEqual(self.verify()['status'],'PASS')

    def test_replaced_database_with_old_open_inode_is_rejected(self):
        old=self.data/'old.sqlite'
        (self.data/'store.sqlite').rename(old)
        make_db(self.data/'store.sqlite')
        (self.proc/'fd/15').unlink();(self.proc/'fd/15').symlink_to(old)
        with self.assertRaisesRegex(RuntimeError,'SQLite inode'):self.verify()

    def test_missing_explicit_path_is_not_certified(self):
        (self.proc/'environ').write_bytes(b'CK_BUILD_SHA=release-sha\0')
        with self.assertRaisesRegex(RuntimeError,'no explicit'):self.verify()

    def test_wrong_build_identity_is_rejected(self):
        self.write_env(self.data)
        p=self.proc/'environ';p.write_bytes(p.read_bytes().replace(b'release-sha',b'older-sha'))
        with self.assertRaisesRegex(RuntimeError,'CK_BUILD_SHA differs'):self.verify()

    def test_wrong_interpreter_is_rejected(self):
        other=self.root/'other-node';put(other)
        (self.proc/'exe').unlink();(self.proc/'exe').symlink_to(other)
        with self.assertRaisesRegex(RuntimeError,'interpreter differs'):self.verify()

    def test_process_reuse_is_rejected(self):
        with mock.patch.object(self.module,'process_identity',side_effect=['555','556']):
            with self.assertRaisesRegex(RuntimeError,'identity changed'):self.verify()

    def test_unreadable_process_metadata_is_not_certified(self):
        (self.proc/'environ').unlink()
        with self.assertRaises(FileNotFoundError):self.verify()

    def test_cli_requires_both_release_and_interpreter(self):
        for suffix in [[], ['--release',str(self.release)], ['--node',str(self.node)]]:
            result=subprocess.run([sys.executable,str(OPS/'verify-runtime-data.py'),'--data-dir',str(self.data),*suffix],capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode,2,result.stderr)
            self.assertIn('required',result.stderr)

    def test_direct_test_runner_includes_runtime_identity_tests(self):
        result=subprocess.run([sys.executable,str(OPS/'test_recovery.py'),'RuntimeDataIdentityTests.test_matching_configured_path_and_open_inode'],capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('Ran 1 test',result.stderr)

    def test_verifier_is_directly_executable(self):
        result=subprocess.run([str(OPS/'verify-runtime-data.py'),'--help'],capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('--data-dir',result.stdout)


    def test_database_symlink_is_rejected(self):
        outside=self.root/'outside.sqlite'
        (self.data/'store.sqlite').rename(outside)
        (self.data/'store.sqlite').symlink_to(outside)
        with self.assertRaisesRegex(RuntimeError,'aliased database'):self.verify()

    def test_database_hardlink_is_rejected(self):
        os.link(self.data/'store.sqlite',self.root/'outside.sqlite')
        with self.assertRaisesRegex(RuntimeError,'aliased database'):self.verify()

    def test_executed_entrypoint_must_match_release(self):
        other=self.root/'old/server.js';put(other,'old application')
        (self.proc/'cmdline').write_bytes(('node\0'+str(other)+'\0').encode())
        with self.assertRaisesRegex(RuntimeError,'entry point differs'):self.verify()

    def test_relative_pinned_entrypoint_is_supported(self):
        (self.proc/'cmdline').write_bytes(b'node\0dist/server.js\0')
        self.assertEqual(self.verify()['status'],'PASS')

    def test_flag_or_loader_launch_is_not_certified(self):
        (self.proc/'cmdline').write_bytes(b'node\0--eval\0require("./dist/server.js")\0')
        with self.assertRaisesRegex(RuntimeError,'direct Node server.js'):self.verify()

    def test_expected_entrypoint_cannot_escape_release(self):
        outside=self.root/'outside-server.js';put(outside)
        self.entry.unlink();self.entry.symlink_to(outside)
        with self.assertRaisesRegex(RuntimeError,'entry point escapes'):self.verify()

    def test_database_replacement_during_check_is_rejected(self):
        calls=0
        def identity(_):
            nonlocal calls
            calls+=1
            if calls==2:
                (self.data/'store.sqlite').rename(self.data/'replaced.sqlite')
                make_db(self.data/'store.sqlite')
            return '555'
        with mock.patch.object(self.module,'process_identity',side_effect=identity):
            with self.assertRaisesRegex(RuntimeError,'database changed'):self.verify()


    def test_node_options_cannot_hide_preloads(self):
        for options in ['--require /outside/module.js','--import=/outside/module.mjs','--loader /outside/loader.mjs','--max-old-space-size=1024']:
            self.write_env(self.data)
            p=self.proc/'environ';p.write_bytes(p.read_bytes()+('NODE_OPTIONS='+options+'\0').encode())
            with self.subTest(options=options):
                with self.assertRaisesRegex(RuntimeError,'NODE_OPTIONS'):self.verify()

    def test_empty_node_options_is_supported(self):
        p=self.proc/'environ';p.write_bytes(p.read_bytes()+b'NODE_OPTIONS=\0')
        self.assertEqual(self.verify()['status'],'PASS')

    def test_current_mcp_guides_match_runtime_contract(self):
        root=OPS.parent
        version=json.loads((root/'apps/server/package.json').read_text())['dependencies']['@modelcontextprotocol/server']
        for name in ['docs/contextkeep-mcp.md','docs/mcp/CLIENT_WORKFLOW.md','docs/mcp/SDK_COMPATIBILITY.md']:
            text=(root/name).read_text()
            with self.subTest(document=name):
                self.assertIn('2.10.1',text)
                self.assertIn('2026-07-28',text)
                for obsolete in ['Current MCP: **2.9.1**','@modelcontextprotocol/sdk@1.30.0','Current candidate','not-yet-deployed']:
                    self.assertNotIn(obsolete,text)
        self.assertIn('@modelcontextprotocol/server@'+version,(root/'docs/mcp/SDK_COMPATIBILITY.md').read_text())


    def test_duplicate_runtime_environment_keys_are_rejected(self):
        for key,value in [('NODE_OPTIONS','--require=/outside.js'),('NODE_OPTIONS',''),('CK_DATA_DIR',str(self.data)),('CK_BUILD_SHA','release-sha')]:
            self.write_env(self.data)
            p=self.proc/'environ'
            if key=='NODE_OPTIONS':
                p.write_bytes(p.read_bytes()+('NODE_OPTIONS='+value+'\0NODE_OPTIONS=\0').encode())
            else:
                p.write_bytes(p.read_bytes()+(key+'='+value+'\0').encode())
            with self.subTest(key=key,value=value):
                with self.assertRaisesRegex(RuntimeError,'Duplicate runtime environment key'):self.verify()


if __name__=='__main__':unittest.main()
