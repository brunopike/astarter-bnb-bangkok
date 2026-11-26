import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {constants as fsFlags} from 'node:fs';
import {lstat, open, rename, unlink} from 'node:fs/promises';
import {dirname, isAbsolute, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

export const ASSISTANT_CHAT_MONTHLY_LIMIT_MICROUSD = 400_000_000;
const invoke = promisify(execFile);
const modulePath = fileURLToPath(import.meta.url);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const monthFormat = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const money = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = code => Object.assign(new Error(code), {code});
const requireValid = condition => { if (!condition) throw failure('BUDGET_UNAVAILABLE'); };

// Node has no POSIX flock binding. The local system Python hands a locked descriptor
// to the Node writer using execv. The kernel releases the lock even on process death.
const underLock = `
import fcntl, os, stat, sys
path, mode, node, module, command = sys.argv[1:]
def safe(st, kind):
    return kind(st.st_mode) and st.st_uid == os.geteuid() and st.st_mode & 0o077 == 0
if not safe(os.lstat(os.path.dirname(path)), stat.S_ISDIR): sys.exit(1)
lock = path + '.lock'
created = False
if mode == 'initialize' and not os.path.lexists(path):
    try:
        fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        created = True
    except FileExistsError: pass
if not created: fd = os.open(lock, os.O_RDWR | os.O_NOFOLLOW)
st = os.fstat(fd)
if not safe(st, stat.S_ISREG): sys.exit(1)
fcntl.flock(fd, fcntl.LOCK_EX)
if not os.path.samestat(st, os.lstat(lock)): sys.exit(1)
os.set_inheritable(fd, True)
os.execv(node, [node, module, '--locked-budget-update', path, 'new' if created else 'existing', command])
`;

function validateLedger(ledger, limit) {
  requireValid(ledger?.version === 1 && ledger.limitMicrousd === limit && ledger.months &&
    Object.getPrototypeOf(ledger.months) === Object.prototype);
  for (const [month, state] of Object.entries(ledger.months)) {
    requireValid(monthFormat.test(month) && state && money(state.spent) && typeof state.suspended === 'boolean' &&
      state.held && Object.getPrototypeOf(state.held) === Object.prototype);
    let total = state.spent;
    for (const [id, amount] of Object.entries(state.held)) {
      requireValid(uuid.test(id) && money(amount) && amount > 0 && amount <= limit);
      total += amount;
    }
    requireValid(money(total) && (state.suspended || total <= limit));
  }
}

async function save(file, ledger) {
  const temp = file + '.' + randomUUID() + '.tmp';
  const output = await open(temp, 'wx', 0o600);
  try {
    try {
      await output.writeFile(JSON.stringify({ledger, sha256: digest(ledger)}), 'utf8');
      await output.sync();
    } finally { await output.close(); }
    await rename(temp, file);
    const dir = await open(dirname(file), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function load(file, limit) {
  const handle = await open(file, fsFlags.O_RDONLY | fsFlags.O_NOFOLLOW | fsFlags.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    requireValid(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
    const {ledger, sha256} = JSON.parse(await handle.readFile('utf8'));
    requireValid(sha256 === digest(ledger));
    validateLedger(ledger, limit);
    return ledger;
  } finally { await handle.close(); }
}

async function updateLocked(file, newlyCreated, command) {
  const {mode, limit, month, id, maxMicrousd, actualMicrousd} = command;
  if (newlyCreated) {
    requireValid(mode === 'initialize');
    const exists = await lstat(file).then(() => true, e => { if (e.code !== 'ENOENT') throw e; return false; });
    requireValid(!exists);
    await save(file, {version: 1, limitMicrousd: limit, months: {}});
    return {};
  }
  const ledger = await load(file, limit);
  if (mode === 'initialize') return {};
  if (mode === 'reserve') {
    // A backwards clock cannot start spending against an older month's allowance.
    requireValid(!Object.keys(ledger.months).some(key => key > month));
    const state = ledger.months[month] ??= {spent: 0, held: {}, suspended: false};
    requireValid(!state.suspended && !Object.hasOwn(state.held, id));
    const committed = Object.values(state.held).reduce((sum, value) => sum + value, state.spent);
    if (maxMicrousd > limit - committed) throw failure('BUDGET_EXCEEDED');
    state.held[id] = maxMicrousd;
    await save(file, ledger);
    return {id, month, maxMicrousd};
  }
  const state = ledger.months[month];
  requireValid(mode === 'settle' && state);
  if (!Object.hasOwn(state.held, id)) return {settled: false};
  requireValid(state.held[id] === maxMicrousd && money(state.spent + actualMicrousd));
  delete state.held[id];
  state.spent += actualMicrousd;
  // Reconcile a verified overrun and stop further paid calls after broken price assumptions.
  if (actualMicrousd > maxMicrousd) state.suspended = true;
  await save(file, ledger);
  return {settled: true, suspended: state.suspended};
}

// Initialize once on a persistent volume. Reserve before sending; settle against
// that same UTC month only with verified billing. Unknown charges stay reserved.
// Only billing metadata is sent to the helper. It inherits no provider credentials.
export function createAssistantChatBudget({file, now = Date.now, limitMicrousd = ASSISTANT_CHAT_MONTHLY_LIMIT_MICROUSD} = {}) {
  async function transact(command) {
    try {
      requireValid(typeof file === 'string' && isAbsolute(file) && money(limitMicrousd) &&
        limitMicrousd > 0 && limitMicrousd <= ASSISTANT_CHAT_MONTHLY_LIMIT_MICROUSD);
      const {stdout} = await invoke('/usr/bin/python3', ['-I','-c',underLock,resolve(file),command.mode,
        process.execPath,modulePath,JSON.stringify({...command,limit: limitMicrousd})],
      {env: {}, timeout: 8000, maxBuffer: 2048});
      const response = JSON.parse(stdout);
      if (response.error === 'BUDGET_EXCEEDED') throw failure('BUDGET_EXCEEDED');
      requireValid(response.ok === true);
      return response.value;
    } catch (error) {
      throw failure(error?.code === 'BUDGET_EXCEEDED' ? 'BUDGET_EXCEEDED' : 'BUDGET_UNAVAILABLE');
    }
  }
  return {
    initialize: () => transact({mode: 'initialize'}),
    async reserve({maxMicrousd} = {}) {
      requireValid(money(maxMicrousd) && maxMicrousd > 0);
      const time = now();
      requireValid(Number.isSafeInteger(time) && time >= 0 && time <= 253402300799999);
      return transact({mode: 'reserve', month: new Date(time).toISOString().slice(0,7), id: randomUUID(), maxMicrousd});
    },
    async settle(reservation, {actualMicrousd} = {}) {
      requireValid(reservation && uuid.test(reservation.id) && monthFormat.test(reservation.month) &&
        money(reservation.maxMicrousd) && reservation.maxMicrousd > 0 && money(actualMicrousd));
      const {id, month, maxMicrousd} = reservation;
      return transact({mode: 'settle', id, month, maxMicrousd, actualMicrousd});
    }
  };
}

if (process.argv[1] === modulePath && process.argv[2] === '--locked-budget-update') {
  try {
    const value = await updateLocked(process.argv[3], process.argv[4] === 'new', JSON.parse(process.argv[5]));
    process.stdout.write(JSON.stringify({ok: true, value}));
  } catch (error) {
    process.stdout.write(JSON.stringify({error: error?.code === 'BUDGET_EXCEEDED' ? 'BUDGET_EXCEEDED' : 'BUDGET_UNAVAILABLE'}));
  }
}
