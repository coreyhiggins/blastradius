'use strict';

// The rule set. This file is the opinionated part of the tool, and it is
// deliberately data rather than code so that disagreeing with a call means
// editing one row, not reading a program.
//
// Two independent axes, because conflating them is what makes existing
// guards annoying enough to get uninstalled:
//
//   RADIUS       how far the damage reaches
//     local      only the working directory. Your editor can undo it.
//     machine    this box, outside the project. Reinstall or restore.
//     remote     another host, cluster, or cloud account. Someone else
//                feels it, and your git history is irrelevant.
//
//   DESTRUCTIVE whether the effect removes or overwrites state
//
// Only the intersection is worth interrupting a human for. `kubectl get
// pods` is remote and harmless. `rm -rf ./build` is destructive and local.
// Neither should prompt. `kubectl delete` against a prod context is both,
// and that is the entire target of this tool.

const LOCAL = 'local';
const MACHINE = 'machine';
const REMOTE = 'remote';

const RADIUS_ORDER = { [LOCAL]: 0, [MACHINE]: 1, [REMOTE]: 2 };

/** Hosts that mean "this machine", so a -h flag pointing here is not remote. */
const LOCAL_HOSTS = new Set([
  'localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal', '',
]);

const has = (argv, ...flags) => argv.some((a) => flags.includes(a));
const sub = (argv) => (argv[1] || '').toLowerCase();

/** Value of --flag=x or --flag x, whichever form was used. */
function flagValue(argv, ...names) {
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    for (const name of names) {
      if (a === name) return argv[i + 1];
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      // Short flags written joined, as in `mysql -hdb.prod`.
      if (name.length === 2 && name.startsWith('-') && a.startsWith(name) && a.length > 2) {
        return a.slice(2);
      }
    }
  }
  return undefined;
}

function isRemoteHost(host) {
  if (host === undefined) return false;
  return !LOCAL_HOSTS.has(String(host).toLowerCase());
}

// Plain-language guidance for `blastradius explain`. Keyed by command name.
//
// `unrecoverable` is the field that matters and the one people get wrong.
// It is not "this is dangerous", it is specifically what no backup, undo,
// or rerun brings back. If a command has no such consequence, say so, and
// the tool stops crying wolf.
const GUIDANCE = {
  terraform: {
    changes: 'Real infrastructure in whichever state this workspace points at. Nothing on this machine.',
    unrecoverable: 'Anything not backed up outside Terraform. Managed databases are commonly deleted together with their snapshots, so the backup goes with the thing it was backing up.',
    before: ['terraform workspace show', 'terraform plan -destroy, and read the resource list'],
  },
  kubectl: {
    changes: 'Workloads in whichever cluster your current context points at.',
    unrecoverable: 'Data in deleted PersistentVolumes, and anything a namespace deletion takes with it. Deleting a namespace deletes everything inside it.',
    before: ['kubectl config current-context', 'add --dry-run=server to see what would happen'],
  },
  helm: {
    changes: 'Released workloads in the target cluster.',
    unrecoverable: 'Data in volumes the release owns. A rollback restores manifests, not data.',
    before: ['helm list to confirm the namespace and release', 'helm diff upgrade if you have the plugin'],
  },
  git: {
    changes: 'The branch on the shared remote, for everyone who has it.',
    unrecoverable: 'Commits that only existed on the remote. Anyone who already pulled will have a conflicting history and will need to reset.',
    before: ['git log --oneline origin/BRANCH -5 to see what you are overwriting', 'prefer --force-with-lease, which refuses when the remote has moved'],
  },
  rm: {
    changes: 'Files on this machine.',
    unrecoverable: 'Anything not committed to git and not in a backup. There is no trash: rm unlinks immediately.',
    before: ['ls the path first, since a stray space turns "rm -rf ./build" into something much worse'],
  },
  systemctl: {
    changes: 'A running service, and anything currently depending on it.',
    unrecoverable: 'Nothing permanently, but in-flight requests and connected sessions are dropped and do not resume.',
    before: ['systemctl status NAME to see what is actually running', 'check whether anyone is connected before restarting'],
  },
  docker: {
    changes: 'Containers, images, or volumes on this machine.',
    unrecoverable: 'Volume contents. Databases run in Docker keep their data in volumes, so "down -v" deletes the database, not just the container.',
    before: ['docker volume ls to see what would go', 'drop the -v flag if you only meant to stop the containers'],
  },
  mysql: {
    changes: 'Rows and schema in the target database.',
    unrecoverable: 'Everything the statement touches, unless you took a dump first. A restore only returns you to the dump.',
    before: ['confirm which host the connection actually points at', 'mysqldump first, it takes seconds'],
  },
  ssh: {
    changes: 'Whatever the payload does, on the far machine.',
    unrecoverable: 'Depends entirely on the payload. Your local editor and its undo have no reach there at all.',
    before: ['read the payload as if it were being run locally, because to that host it is'],
  },
  aws: {
    changes: 'Resources in the account this profile authenticates to.',
    unrecoverable: 'Deleted buckets and their contents, terminated instances with ephemeral storage, and anything without a retention policy.',
    before: ['aws sts get-caller-identity to confirm the account', 'add --dryrun where the subcommand supports it'],
  },
};

GUIDANCE.tofu = GUIDANCE.terraform;
GUIDANCE.oc = GUIDANCE.kubectl;
GUIDANCE.podman = GUIDANCE.docker;
GUIDANCE.psql = GUIDANCE.mysql;
GUIDANCE.mariadb = GUIDANCE.mysql;
GUIDANCE.gcloud = GUIDANCE.aws;
GUIDANCE.az = GUIDANCE.aws;
GUIDANCE.scp = GUIDANCE.ssh;
GUIDANCE.sftpc = GUIDANCE.ssh;
GUIDANCE.sexec = GUIDANCE.ssh;

const RULES = [
  // ---- Reaches another machine -------------------------------------------
  {
    // sftpc and sexec are Bitvise. They are not obscure: they are what real
    // deploy runbooks use to reach production, and leaving them out meant
    // every actual deploy command sailed past the guard.
    match: ['ssh', 'scp', 'sftp', 'rsync', 'sftpc', 'sexec', 'plink', 'pscp'],
    radius: (argv, cmd) => {
      // rsync is only remote when an argument names a host.
      if (cmd === 'rsync') {
        return argv.slice(1).some((a) => /^[^-][^\s]*:/.test(a)) ? REMOTE : MACHINE;
      }
      return REMOTE;
    },
    // ssh carries an arbitrary payload; we classify the payload separately
    // by re-parsing it, so the bare connection is not itself destructive.
    destructive: (argv, cmd) => cmd === 'rsync' && has(argv, '--delete', '--delete-after', '--delete-before'),
    why: 'runs on, or copies to, another machine',
    payload: (argv, cmd) => (cmd === 'ssh' ? remainderAfterHost(argv) : null),
  },
  {
    match: ['terraform', 'tofu'],
    radius: REMOTE,
    destructive: (argv) => ['destroy', 'apply'].includes(sub(argv)),
    why: (argv) => (sub(argv) === 'destroy'
      ? 'destroys every resource in the targeted state'
      : 'changes real infrastructure in the targeted state'),
  },
  {
    match: ['pulumi'],
    radius: REMOTE,
    destructive: (argv) => ['destroy', 'up', 'refresh'].includes(sub(argv)),
    why: 'changes real infrastructure in the selected stack',
  },
  {
    match: ['kubectl', 'oc'],
    radius: REMOTE,
    destructive: (argv) => ['delete', 'drain', 'cordon', 'replace', 'apply', 'patch', 'scale', 'rollout'].includes(sub(argv)),
    why: (argv) => `${sub(argv)} against the active cluster context`,
  },
  {
    match: ['helm'],
    radius: REMOTE,
    destructive: (argv) => ['uninstall', 'delete', 'rollback', 'upgrade'].includes(sub(argv)),
    why: 'changes released workloads in the target cluster',
  },
  {
    match: ['aws', 'gcloud', 'az', 'doctl', 'flyctl', 'fly', 'heroku', 'railway', 'vercel'],
    radius: REMOTE,
    destructive: (argv) => argv.slice(1).some((a) => /^(delete|destroy|terminate|rm|remove|purge|drop|deprovision|scale|rollback)$/i.test(a)),
    why: 'mutates cloud resources on a live account',
  },
  {
    match: ['ansible-playbook', 'ansible'],
    radius: REMOTE,
    destructive: true,
    why: 'applies configuration across an inventory of hosts',
  },
  {
    match: ['mysql', 'psql', 'mongosh', 'mongo', 'redis-cli', 'mariadb'],
    radius: (argv) => (isRemoteHost(flagValue(argv, '-h', '--host')) ? REMOTE : MACHINE),
    destructive: (argv, cmd, meta = {}) => {
      const inline = (flagValue(argv, '-e', '--eval', '--command', '-c') || '').toLowerCase();
      if (/\b(drop|truncate|delete\s+from|flushall|flushdb)\b/.test(inline)) return true;
      // A database client on the receiving end of a pipe is being fed a
      // script. In practice that is a restore, and a restore overwrites
      // everything it touches. `gunzip -c all-databases.sql.gz | mysql` was
      // the single most destructive line in a 166-command audit corpus, and
      // it classified as harmless until this existed.
      if (meta.pipedInto) return true;
      // Reading a dump in via redirection is the same operation.
      return argv.some((a) => a === '<');
    },
    why: (argv) => (isRemoteHost(flagValue(argv, '-h', '--host'))
      ? `connects to database host ${flagValue(argv, '-h', '--host')}`
      : 'connects to a local database'),
  },
  {
    match: ['git'],
    radius: (argv) => (['push', 'fetch', 'pull', 'clone', 'remote'].includes(sub(argv)) ? REMOTE : LOCAL),
    destructive: (argv) => {
      if (sub(argv) !== 'push') return false;
      // Prefix match, not equality: --force-with-lease and --force-if-includes
      // are still history rewrites, they are just politer about it.
      if (argv.some((a) => a === '-f' || a.startsWith('--force'))) return true;
      if (has(argv, '--delete', '-d')) return true;
      // A leading + on a refspec is a force push wearing a disguise.
      return argv.slice(2).some((a) => /^\+/.test(a));
    },
    why: (argv) => (has(argv, '--force-with-lease')
      ? 'force-pushes to a shared remote (lease-checked, but still rewrites history)'
      : 'force-pushes to a shared remote, overwriting other people\'s commits'),
  },

  // ---- Reaches this machine, outside the project --------------------------
  {
    match: ['docker', 'podman'],
    radius: () => (process.env.DOCKER_HOST ? REMOTE : MACHINE),
    destructive: (argv) => {
      const parts = argv.slice(1).map((a) => a.toLowerCase());
      if (parts.includes('down') && has(argv, '-v', '--volumes')) return true;
      if (parts.includes('prune')) return true;
      if (parts.includes('rm') || parts.includes('rmi')) return true;
      return false;
    },
    why: (argv) => (has(argv, '-v', '--volumes')
      ? 'removes containers AND their volumes, which is where data lives'
      : 'removes container or image state'),
  },
  {
    match: ['systemctl', 'service', 'launchctl', 'sc'],
    radius: MACHINE,
    // `restart` belongs here. It causes real downtime, and leaving it out
    // made every restart in a 166-command audit invisible to the classifier.
    // It still lands at `machine`, so it produces a `notice` and never
    // interrupts: routine restarts stay quiet, but a project config can now
    // escalate the ones that actually matter (a service with users on it).
    destructive: (argv) => argv.slice(1).some((a) => /^(stop|disable|mask|kill|unload|delete|restart|reload)$/i.test(a)),
    why: (argv) => (argv.slice(1).some((a) => /^(restart|reload)$/i.test(a))
      ? 'restarts a service, which interrupts anything currently using it'
      : 'stops or disables a service on this machine'),
  },
  {
    match: ['apt', 'apt-get', 'yum', 'dnf', 'pacman', 'brew', 'zypper', 'apk'],
    radius: MACHINE,
    destructive: (argv) => argv.slice(1).some((a) => /^(remove|purge|autoremove|uninstall|erase|-R|-Rns)$/i.test(a)),
    why: 'removes system packages',
  },
  {
    match: ['mkfs', 'fdisk', 'parted', 'wipefs', 'shred', 'diskutil'],
    radius: MACHINE,
    destructive: true,
    why: 'writes to a block device, which no version control can undo',
  },
  {
    match: ['dd'],
    radius: MACHINE,
    destructive: (argv) => argv.some((a) => a.startsWith('of=')),
    why: 'writes a raw image, typically over a device or disk',
  },
  {
    match: ['userdel', 'usermod', 'groupdel', 'passwd', 'visudo'],
    radius: MACHINE,
    destructive: true,
    why: 'changes accounts or privileges on this machine',
  },
  {
    match: ['iptables', 'nft', 'ufw', 'firewall-cmd'],
    radius: MACHINE,
    destructive: true,
    why: 'changes firewall rules, which can lock you out of the box',
  },
  {
    match: ['shutdown', 'reboot', 'halt', 'poweroff', 'init'],
    radius: MACHINE,
    destructive: true,
    why: 'takes this machine down',
  },
  {
    match: ['crontab'],
    radius: MACHINE,
    destructive: (argv) => has(argv, '-r'),
    why: 'removes all scheduled jobs for the user',
  },
  {
    match: ['chown', 'chmod'],
    radius: (argv) => (touchesOutsideProject(argv) ? MACHINE : LOCAL),
    destructive: (argv) => has(argv, '-R', '--recursive') && touchesOutsideProject(argv),
    why: 'recursively changes ownership or permissions outside the project',
  },
  {
    match: ['rm'],
    radius: (argv) => (touchesOutsideProject(argv) ? MACHINE : LOCAL),
    destructive: (argv) => has(argv, '-r', '-rf', '-fr', '-R', '--recursive', '-f', '--force'),
    why: (argv) => (touchesOutsideProject(argv)
      ? 'recursively deletes a path outside the project directory'
      : 'deletes files in the project'),
  },
];

/**
 * Does any non-flag argument point outside the current working directory?
 * Absolute paths and parent traversals both count. This is intentionally
 * conservative: `rm -rf ~/.config` should be treated as leaving the project
 * even though it never touches `/`.
 */
function touchesOutsideProject(argv) {
  return argv.slice(1).some((a) => {
    if (a.startsWith('-')) return false;
    if (a.startsWith('/') || /^[A-Za-z]:[\\/]/.test(a)) return true;
    if (a.startsWith('~')) return true;
    if (a.split(/[\\/]/).includes('..')) return true;
    return false;
  });
}

/** For `ssh host <command...>`, the command that will run on the far side. */
function remainderAfterHost(argv) {
  let i = 1;
  while (i < argv.length) {
    const a = argv[i];
    // Skip ssh's own flags, including those that take a value.
    if (a.startsWith('-')) {
      i += /^-[bcDEeFIiJLlmOoPpQRSWw]$/.test(a) ? 2 : 1;
      continue;
    }
    break;
  }
  const rest = argv.slice(i + 1);
  return rest.length ? rest.join(' ') : null;
}

/**
 * Guidance for a finding, falling back to something honest and generic when
 * no specific entry exists. The fallback is deliberately vague about
 * consequences rather than inventing them: a made-up warning is worse than
 * a plain one.
 */
function guidanceFor(command, radius) {
  if (GUIDANCE[command]) return GUIDANCE[command];

  if (radius === REMOTE) {
    return {
      changes: 'State on another machine, cluster, or account.',
      unrecoverable: 'Unknown. Nothing on your machine records what happens on the other end, so assume it is not reversible from here.',
      before: ['confirm which environment this is pointed at'],
    };
  }
  if (radius === MACHINE) {
    return {
      changes: 'This machine, outside the project directory.',
      unrecoverable: 'Anything not under version control and not backed up.',
      before: ['check the exact path before running it'],
    };
  }
  return {
    changes: 'Files inside the project directory.',
    unrecoverable: 'Uncommitted work. Git cannot restore what it was never told about.',
    before: ['git status, so you know what is uncommitted'],
  };
}

module.exports = {
  RULES,
  GUIDANCE,
  guidanceFor,
  LOCAL,
  MACHINE,
  REMOTE,
  RADIUS_ORDER,
  touchesOutsideProject,
  remainderAfterHost,
  flagValue,
  isRemoteHost,
};
