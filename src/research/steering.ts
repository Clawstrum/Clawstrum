import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../store.js';

export interface WorkerSteer {
  key: string;
  id: string;
  workerId: string;
  message: string;
  sequence: number;
  status: 'queued' | 'sending' | 'accepted' | 'rejected' | 'unknown';
  createdAt: number;
  updatedAt: number;
  reason?: string;
}
export function workerSteers(store: Store, workerId: string): WorkerSteer[] {
  return store
    .all<{ value: string }>(
      'SELECT value FROM metadata WHERE key LIKE ? ORDER BY key',
      `worker-steer:${workerId}:%`,
    )
    .map((row) => JSON.parse(row.value) as WorkerSteer)
    .sort((a, b) => a.sequence - b.sequence);
}
export function steerWorker(
  store: Store,
  sessionId: string,
  workerId: string,
  key: string,
  message: string,
) {
  // Public keys are capped at 200 by the tool schema; internal keys include the input scope.
  if (!key || key.length > 512 || !message.trim() || message.length > 8000)
    throw new Error(
      'Subagent steering requires a scoped key up to 512 characters and nonempty text up to 8000 characters',
    );
  return store.transaction(() => {
    const worker = store.get<{ status: string }>(
      'SELECT status FROM delegations WHERE id=? AND session_id=?',
      workerId,
      sessionId,
    );
    if (!worker) throw new Error('Unknown subagent in this conversation');
    const storageKey = `worker-steer:${workerId}:${createHash('sha256').update(key).digest('hex')}`;
    const old = store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', storageKey);
    if (old) {
      const record = JSON.parse(old.value) as WorkerSteer;
      if (record.message !== message)
        throw new Error('Steering key already names another instruction');
      return record;
    }
    if (!['queued', 'running'].includes(worker.status))
      throw new Error(
        'Subagent has ended; use research_delegate with resumeFrom for an explicit continuation',
      );
    const previous = workerSteers(store, workerId);
    if (previous.filter((r) => ['queued', 'sending'].includes(r.status)).length >= 20)
      throw new Error('Subagent already has 20 outstanding steering instructions');
    const record: WorkerSteer = {
      key: storageKey,
      id: randomUUID(),
      workerId,
      message,
      sequence: previous.length,
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    store.exec('INSERT INTO metadata(key,value) VALUES(?,?)', storageKey, JSON.stringify(record));
    return record;
  });
}
export function updateWorkerSteer(
  store: Store,
  record: WorkerSteer,
  status: WorkerSteer['status'],
  reason?: string,
) {
  const expected = status === 'sending' ? 'queued' : 'sending';
  return store.transaction(() => {
    const old = store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', record.key);
    if (!old) return false;
    const current = JSON.parse(old.value) as WorkerSteer;
    if (current.status !== expected && !(status === 'rejected' && current.status === 'queued'))
      return false;
    store.exec(
      'UPDATE metadata SET value=? WHERE key=?',
      JSON.stringify({ ...current, status, reason, updatedAt: Date.now() }),
      record.key,
    );
    return true;
  });
}
export function closeWorkerSteers(store: Store, workerId: string) {
  for (const record of workerSteers(store, workerId)) {
    if (record.status === 'queued')
      updateWorkerSteer(store, record, 'rejected', 'Subagent ended before delivery');
    if (record.status === 'sending')
      updateWorkerSteer(
        store,
        record,
        'unknown',
        'Subagent ended without an acknowledgment; inspect its artifacts before repeating this instruction',
      );
  }
}
