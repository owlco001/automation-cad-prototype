import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readlinkSync, readdirSync } from 'node:fs';

const ownership = new WeakMap();
const OWNER = 'AUTOMATIONCAD_TASK_OWNER';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function identity(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return { pid, state: fields[0], start: fields[19], exe: readlinkSync(`/proc/${pid}/exe`) };
  } catch { return null; }
}

function ownedMembers(record) {
  if (process.platform !== 'linux') return [];
  const found = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const marker = readFileSync(`/proc/${name}/environ`, 'utf8').split('\0').find(value => value.startsWith(`${OWNER}=`))?.slice(OWNER.length + 1);
      if (marker !== record.token && !marker?.startsWith(`${record.token}/`)) continue;
      const member = identity(Number(name));
      if (member && member.state !== 'Z') found.push(member);
    } catch { /* A process may exit between enumeration and inspection. */ }
  }
  return found;
}

function signalMember(member, signal) {
  const current = identity(member.pid);
  if (!current || current.start !== member.start || current.exe !== member.exe) return;
  try { process.kill(member.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

/** A unique inherited marker also tracks sidecars which create their own process group. */
export function spawnOwnedProcess(command, args, options = {}) {
  const env = options.env ?? process.env;
  const parent = env[OWNER];
  const token = `${parent ? `${parent}/` : ''}${randomUUID()}`;
  const child = spawn(command, args, {
    ...options,
    detached: process.platform !== 'win32',
    env: { ...env, [OWNER]: token }
  });
  // Wait for exec/spawn acknowledgement before scanning inherited markers.
  // An immediate cancellation must not race the child's first exec.
  const ready = new Promise(resolve => {
    child.once('spawn', resolve);
    child.once('error', resolve);
  });
  const record = { token, pid: child.pid, stopping: null, ready };
  ownership.set(child, record);
  // Prevent an unobserved spawn error while callers are arranging listeners.
  child.once('error', () => {});
  console.log(`OWNED_PROCESS_START pid=${child.pid ?? 'unavailable'} owner=${token}`);
  return child;
}

/** Read-only verification for supervisors; an empty launcher is not sufficient. */
export function ownedProcessPids(child) {
  const record = ownership.get(child);
  if (!record) throw new Error('Unregistered process');
  if (process.platform !== 'linux') throw new Error('Marker-based verification requires Linux /proc');
  return ownedMembers(record).map(member => member.pid);
}

/** Idempotent, bounded cleanup; never infer descendant exit from launcher exit. */
export function stopOwnedProcess(child, { graceMs = 2000, killMs = 2000 } = {}) {
  if (!child) return Promise.resolve({ pids: [], escalated: [], remaining: [] });
  const record = ownership.get(child);
  if (!record) return Promise.reject(new Error('Refusing cleanup of an unregistered process'));
  if (record.stopping) return record.stopping;
  record.stopping = (async () => {
    await record.ready;
    if (process.platform === 'linux') {
      const seen = new Set();
      const escalated = new Set();
      async function drain(signal, budget) {
        const deadline = Date.now() + budget;
        do {
          const members = ownedMembers(record);
          if (!members.length) return [];
          for (const member of members) {
            seen.add(member.pid);
            if (signal === 'SIGKILL') escalated.add(member.pid);
            signalMember(member, signal);
          }
          await pause(Math.min(50, Math.max(1, deadline - Date.now())));
        } while (Date.now() < deadline);
        return ownedMembers(record);
      }
      let remaining = await drain('SIGTERM', graceMs);
      if (remaining.length) remaining = await drain('SIGKILL', killMs);
      const result = { pids: [...seen], escalated: [...escalated], remaining: remaining.map(x => x.pid) };
      console.log(`OWNED_PROCESS_STOP ${JSON.stringify(result)}`);
      if (result.remaining.length) throw new Error(`Owned processes still alive: ${result.remaining.join(',')}`);
      return result;
    }
    if (process.platform === 'win32') {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: graceMs + killMs, windowsHide: true });
        if (result.error || (result.status !== 0 && child.exitCode === null && child.signalCode === null)) throw result.error ?? new Error('taskkill failed');
      }
    } else if (child.pid) {
      const groupAlive = () => { try { process.kill(-child.pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
      if (groupAlive()) process.kill(-child.pid, 'SIGTERM');
      const deadline = Date.now() + graceMs;
      while (groupAlive() && Date.now() < deadline) await pause(50);
      if (groupAlive()) process.kill(-child.pid, 'SIGKILL');
      const killedAt = Date.now();
      while (groupAlive() && Date.now() - killedAt < killMs) await pause(50);
      if (groupAlive()) throw new Error(`Owned process group still alive: ${child.pid}`);
    }
    return { pids: record.pid ? [record.pid] : [], escalated: [], remaining: [] };
  })();
  return record.stopping;
}
