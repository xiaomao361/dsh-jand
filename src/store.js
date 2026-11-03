import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  syncDir(path.dirname(file));
}
export function syncDir(dir) {
  if (process.platform === 'win32') return; // Node cannot open directories for fsync on Windows.
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export function chatId(chat) {
  if (!/^[a-f0-9]{32}$/.test(chat)) throw new Error('Use the full 32-character chat id.');
  return chat;
}
export function layout(root, chat) {
  chatId(chat);
  const dir = path.join(root, 'conversations', chat);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {dir, state: path.join(dir, 'inbox.json'), tx: path.join(dir, 'transaction'), lock: path.join(dir, 'reader.lock')};
}
export function lock(file) {
  // Serialize acquisition AND stale recovery. Without this gate two contenders
  // can observe a dead PID and one can steal the other's newly acquired lock.
  const gate = `${file}.gate`;
  try { fs.mkdirSync(gate, {mode: 0o700}); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Lock acquisition in progress or interrupted; retry or inspect the gate.'); throw error; }
  try {
    if (fs.existsSync(file)) {
      const owner = read(path.join(file, 'owner.json'), null);
      if (!owner) throw new Error('Reader lock is incomplete; inspect it before recovery.');
      let dead = false;
      try { process.kill(owner.pid, 0); }
      catch (e) { if (e.code === 'ESRCH') dead = true; else throw new Error('Reader lock ownership could not be verified.'); }
      if (!dead) throw new Error('One receiver or command already owns this chat.');
      fs.rmSync(file, {recursive: true});
    }
    fs.mkdirSync(file, {mode: 0o700});
    atomic(path.join(file, 'owner.json'), {pid: process.pid});
  } finally { fs.rmdirSync(gate); }
  let released = false;
  return () => { if (released) return; released = true; fs.rmSync(file, {recursive: true}); syncDir(path.dirname(file)); };
}
export const emptyState = () => ({version: 1, records: [], acked: [], failures: 0, retryAt: 0, ended: false});
export function append(state, events, operation) {
  for (const [i, event] of events.entries()) {
    if (event.event === 'no_events') continue;
    const id = event.id ? `message:${event.id}` : createHash('sha256').update(`${operation}:${i}:${JSON.stringify(event)}`).digest('hex');
    if (!state.records.some(r => r.id === id)) state.records.push({id, event, receivedAt: new Date().toISOString(), untrusted: true});
    if (['closed', 'expired', 'declined'].includes(event.event)) state.ended = true;
  }
  return state;
}
export function inbox(root, chat) {
  const p = layout(root, chat), release = lock(p.lock);
  try {
    recover(root, chat);
    const state = read(p.state, emptyState());
    return {ended: state.ended, failures: state.failures, retryAt: state.retryAt, lastOutcome: state.lastOutcome,
      records: state.records.filter(r => !state.acked.includes(r.id))};
  } finally { release(); }
}
export function acknowledge(root, chat, ids) {
  const p = layout(root, chat), release = lock(p.lock);
  try {
    recover(root, chat);
    const state = read(p.state, emptyState());
    const unique = [...new Set(ids)];
    for (const id of unique) if (!state.records.some(r => r.id === id)) throw new Error('Unknown inbox record id. Use record.id from jand_inbox (e.g. message:h1).');
    const additions = unique.filter(id => !state.acked.includes(id));
    if (additions.length) { state.acked.push(...additions); atomic(p.state, state); }
    return {acknowledged: additions.length, already: unique.length - additions.length};
  } finally { release(); }
}
export function recover(root, chat) {
  const p = layout(root, chat), ready = read(path.join(p.tx, 'ready.json'), null);
  if (!ready) return;
  // Inbox was fsynced before ready. Roll forward cursor and sidecars from the
  // immutable stage after a crash at any point in the multi-file commit.
  for (const name of ready.files) {
    if (!name.startsWith(`${chat}.`) || path.basename(name) !== name) throw new Error('Invalid recovery journal.');
    const source = path.join(p.tx, 'home', 'chats', name);
    const target = path.join(root, 'home', 'chats', name);
    fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});
    const temp = `${target}.commit`;
    fs.copyFileSync(source, temp);
    const fd = fs.openSync(temp, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, target);
    syncDir(path.dirname(target));
  }
  fs.rmSync(p.tx, {recursive: true}); syncDir(p.dir);
}
