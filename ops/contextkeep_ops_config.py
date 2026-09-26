"""Small, private-operator configuration contract for ContextKeep recovery jobs."""
import json
import os
import pathlib
import re
import stat
import shutil

P = pathlib.Path

DEFAULT_PROFILE = {
    "primary_host": "server",
    "home_dir": "/home/operator",
    "repo_dir": "/opt/contextkeep",
    "backup_dir": "/storage/backups/contextkeep",
    "runtime_kit_dir": "/storage/backups/contextkeep",
    "data_dir": "/opt/contextkeep/apps/server/data",
    "release_dir": "/home/operator/releases/contextkeep/current",
    "nas_mount": "/mnt/nas",
    "nas_dir": "/mnt/nas/backups/contextkeep",
    "dell_target": "operator@standby",
    "dell_dir": "/home/operator/backups/contextkeep",
    "runtime_release_name": None,
}
PATH_FIELDS = {
    "home_dir", "repo_dir", "backup_dir", "runtime_kit_dir", "data_dir",
    "release_dir", "nas_mount", "nas_dir", "dell_dir",
}
REQUIRED_PROFILE_KEYS = PATH_FIELDS | {"primary_host", "dell_target"}


def load_profile(filename=None):
    """Load a JSON profile, with no profile preserving installed defaults."""
    selected = filename or os.environ.get("CONTEXTKEEP_OPS_CONFIG")
    profile = dict(DEFAULT_PROFILE)
    if selected:
        source = P(selected)
        with source.open(encoding="utf-8") as stream:
            supplied = json.load(stream)
        if not isinstance(supplied, dict):
            raise ValueError("Operations profile must be a JSON object")
        unknown = set(supplied) - set(DEFAULT_PROFILE)
        if unknown:
            raise ValueError("Unknown operations profile keys: " + ", ".join(sorted(unknown)))
        missing = REQUIRED_PROFILE_KEYS - set(supplied)
        if missing:
            raise ValueError(
                "Explicit operations profile is missing required keys: "
                + ", ".join(sorted(missing))
            )
        profile.update(supplied)
    validate_profile(profile)
    return profile


def validate_profile(profile):
    if not isinstance(profile.get("primary_host"), str) or not profile["primary_host"]:
        raise ValueError("Operations profile requires primary_host")
    if any(c.isspace() for c in profile["primary_host"]):
        raise ValueError("primary_host cannot contain whitespace")
    for key in PATH_FIELDS:
        value = profile.get(key)
        if not isinstance(value, str) or not P(value).is_absolute():
            raise ValueError(f"Operations profile requires absolute {key}")
    target = profile.get("dell_target")
    target_pattern = r'(?:[A-Za-z0-9._%+~-]+@)?[A-Za-z0-9._%-]+'
    if (not isinstance(target, str) or not target or target.startswith('-') or
            not re.fullmatch(target_pattern, target)):
        raise ValueError(
            "Operations profile has an invalid dell_target; use user@hostname, "
            "an IPv4/hostname, or an SSH-config alias without a port"
        )
    release_name = profile.get("runtime_release_name")
    if release_name is not None and (
        not isinstance(release_name, str) or not release_name or P(release_name).name != release_name
    ):
        raise ValueError("runtime_release_name must be a simple directory name")


def _process_starttime(proc):
    fields=(proc/'stat').read_text().rsplit(')',1)[1].split()
    return fields[19]


def verify_running_process(run, *, proc_root=P('/proc')):
    """Read only selected Linux service identity fields before any backup write."""
    if os.name!='posix' or not P(proc_root).is_dir():
        raise RuntimeError('Linux /proc runtime identity verification is unsupported')
    raw=run(['systemctl','--user','show','contextkeep.service','--property=MainPID','--value'])
    raw=getattr(raw,'stdout',raw)
    pid_text=str(raw).strip()
    if not pid_text.isdecimal() or int(pid_text)<=1:
        raise RuntimeError('Active ContextKeep MainPID is unavailable for runtime identity verification')
    pid=int(pid_text);proc=P(proc_root)/str(pid);start=_process_starttime(proc)
    cwd=(proc/'cwd').resolve(strict=True)
    if cwd.name!='server' or cwd.parent.name!='apps':
        raise RuntimeError('Running service cwd is not the supported release/apps/server path')
    release=cwd.parent.parent.resolve(strict=True)
    selected={}
    for entry in (proc/'environ').read_bytes().split(b'\0'):
        if b'=' not in entry:continue
        key,value=entry.split(b'=',1)
        if key in {b'CK_DATA_DIR',b'CK_BUILD_SHA',b'NODE_OPTIONS'}:
            name=key.decode()
            if name in selected:raise RuntimeError('Duplicate selected runtime environment key')
            selected[name]=os.fsdecode(value)
    if selected.get('NODE_OPTIONS','').strip():
        raise RuntimeError('NODE_OPTIONS must be empty for the supported direct Node launch proof')
    configured=selected.get('CK_DATA_DIR')
    if not configured or not selected.get('CK_BUILD_SHA'):
        raise RuntimeError('Running service has no explicit CK_DATA_DIR/CK_BUILD_SHA identity')
    data=(P(configured) if P(configured).is_absolute() else cwd/P(configured)).resolve(strict=True)
    if selected['CK_BUILD_SHA']!=release.name:
        raise RuntimeError('Running CK_BUILD_SHA differs from the release path')
    entry=(release/'apps/server/dist/server.js').resolve(strict=True)
    if not entry.is_relative_to(release):
        raise RuntimeError('Pinned server entry point escapes the release')
    argv=(proc/'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
    if len(argv)!=2 or not argv[1] or argv[1].startswith(b'-'):
        raise RuntimeError('Runtime proof requires the supported direct Node server.js launch')
    invoked=P(os.fsdecode(argv[1]))
    invoked=(invoked if invoked.is_absolute() else cwd/invoked).resolve(strict=True)
    if invoked!=entry:
        raise RuntimeError('Executed server entry point differs from the pinned release')
    executable=(proc/'exe').resolve(strict=True)
    if not executable.is_file():raise RuntimeError('Running service interpreter is not a regular file')
    database=data/'store.sqlite';database_stat=database.lstat()
    if not stat.S_ISREG(database_stat.st_mode) or database_stat.st_nlink!=1:
        raise RuntimeError('Refusing an aliased database or non-regular SQLite file')
    descriptor_matches = False
    for descriptor in (proc/'fd').iterdir():
        try:
            if os.path.samefile(descriptor, database):
                descriptor_matches = True
                break
        except FileNotFoundError:
            # Proc descriptors can disappear while a process exits; that is
            # an indeterminate identity check, not a successful one.
            continue
    if not descriptor_matches:
        raise RuntimeError('Running process does not hold the expected SQLite inode')
    if _process_starttime(proc)!=start:raise RuntimeError('Service process identity changed during verification')
    final_stat=database.lstat()
    if (not stat.S_ISREG(final_stat.st_mode) or final_stat.st_nlink!=1 or
            (final_stat.st_dev,final_stat.st_ino)!=(database_stat.st_dev,database_stat.st_ino)):
        raise RuntimeError('Expected database changed during verification')
    return {'pid':pid,'data_dir':str(data),'release_dir':str(release),'node':str(executable),'database_inode_verified':True,'entry_point':str(entry)}


def validate_runtime_identity(profile, observed_host, data_dir=None, release_dir=None, require_data=True, require_observed=True):
    """Fail closed before writes when configured and observed identities differ."""
    if observed_host != profile["primary_host"]:
        raise RuntimeError("Configured primary host does not match this host")
    configured_data = P(profile["data_dir"]).resolve(strict=require_data)
    configured_release = P(profile["release_dir"]).resolve(strict=True)
    if require_observed and (data_dir is None or release_dir is None):
        raise RuntimeError('Actual running data/runtime identity observation is required')
    actual_data = configured_data if data_dir is None else P(data_dir).resolve(strict=require_data)
    actual_release = configured_release if release_dir is None else P(release_dir).resolve(strict=True)
    if actual_data != configured_data:
        raise RuntimeError("Configured data identity differs from the requested data path")
    if actual_release != configured_release:
        raise RuntimeError("Configured runtime identity differs from the requested release")
    if (require_data and not actual_data.is_dir()) or not actual_release.is_dir() or actual_data == actual_release:
        raise RuntimeError("Configured data/runtime identity is invalid")
    if require_data and not (actual_data / "store.sqlite").is_file():
        raise RuntimeError("Configured data identity has no store.sqlite")
    if not (actual_release / "package.json").is_file():
        raise RuntimeError("Configured runtime identity has no package.json")
    if profile.get("runtime_release_name") and actual_release.name != profile["runtime_release_name"]:
        raise RuntimeError("Configured runtime release name does not match the release path")
    return {"host": observed_host, "data_dir": str(actual_data), "release_dir": str(actual_release)}


def space_report(profile):
    """Return non-sensitive capacity information for snapshots and runtime kits."""
    kit_dir = P(profile["runtime_kit_dir"])
    probe = kit_dir
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    usage = shutil.disk_usage(probe)
    kits = sorted(kit_dir.glob("runtime-*.tar.gz")) if kit_dir.is_dir() else []
    return {
        "runtime_kit_dir": str(kit_dir),
        "runtime_kit_count": len(kits),
        "runtime_kit_bytes": sum(item.stat().st_size for item in kits),
        "filesystem": {"total_bytes": usage.total, "used_bytes": usage.used, "free_bytes": usage.free},
    }
