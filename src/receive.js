import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomic, read, layout, lock, emptyState, append, recover, syncDir } from './store.js';
import { runKernel } from './kernel.js';

export async function receive({root, chat, binary, relay, wait = '30m', signal, execute = runKernel, fault}) {
  const p = layout(root, chat), release = lock(p.lock);
  let state;
  try {
    recover(root, chat);
    state = read(p.state, emptyState());
    if (state.ended) return {outcome: 'ended'};
    if (Date.now() < state.retryAt) await delay(state.retryAt - Date.now(), undefined, {signal});
    // Discard only an uncommitted stage. Its cursor never reached the live home.
    fs.rmSync(p.tx, {recursive: true, force: true});
    const stage = path.join(p.tx, 'home'), source = path.join(root, 'home', 'chats');
    fs.mkdirSync(path.join(stage, 'chats'), {recursive: true, mode: 0o700});
    for (const name of fs.readdirSync(source)) {
      if (name.startsWith(`${chat}.`) && fs.statSync(path.join(source, name)).isFile()) fs.copyFileSync(path.join(source, name), path.join(stage, 'chats', name));
    }
    const result = await execute(binary, ['chat','recv','--json','--wait',wait,'--wake','request,reply,delivery',chat], {home: stage, relay, signal});
    // CLI exit 4 deliberately emits an `error` event for ended/not-found. It
    // is terminal unavailability, not a transient network failure to retry.
    if (![0,4].includes(result.code) || (result.code !== 4 && result.events.some(e => e.event === 'error'))) throw new Error('Kernel receive failed; cursor was not committed.');
    // A successful empty stdout is anomalous, not no_events.
    if (result.code === 0 && result.events.length === 0) throw new Error('Missing receive result; cursor was not committed.');
    const previousCursor = read(path.join(source, `${chat}.cursor`), {after: 0}).after;
    append(state, result.events, String(previousCursor));
    if (result.code === 4) state.ended = true;
    state.failures = 0; state.retryAt = 0;
    const outcome = result.code === 4 ? 'ended_or_gone' : state.ended ? 'ended' : result.events.every(e => e.event === 'no_events') ? 'no_events' : 'received';
    state.lastOutcome = outcome;
    // Event records are durable before a staged cursor may become live.
    atomic(p.state, state);
    fault?.('inbox_committed');
    const files = fs.readdirSync(path.join(stage, 'chats'));
    for (const name of files) {
      const fd = fs.openSync(path.join(stage, 'chats', name), 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    syncDir(path.join(stage, 'chats')); syncDir(stage); syncDir(p.tx);
    atomic(path.join(p.tx, 'ready.json'), {files});
    fault?.('ready_committed');
    recover(root, chat);
    return {outcome, count: result.events.filter(e => e.event !== 'no_events').length};
  } catch (error) {
    if (fault) throw error;
    // Retain the inbox if already committed; never turn network/parse errors into empty success.
    state = read(p.state, state ?? emptyState());
    if (!signal?.aborted) {
      state.failures += 1;
      state.retryAt = Date.now() + Math.min(300_000, 2000 * 2 ** Math.min(state.failures - 1, 8));
    }
    state.lastOutcome = signal?.aborted ? 'canceled' : 'failed';
    atomic(p.state, state);
    return {outcome: state.lastOutcome, retryAt: state.retryAt};
  } finally { release(); }
}
