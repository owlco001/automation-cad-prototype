import { spawn } from 'node:child_process';
if (process.argv.includes('--worker')) {
  if (process.argv.includes('--ignore-term')) process.on('SIGTERM', () => {});
  console.log(JSON.stringify({ worker: process.pid }));
  setInterval(() => {}, 1000);
} else {
  const args = [import.meta.filename, '--worker', ...(process.argv.includes('--stubborn') ? ['--ignore-term'] : [])];
  const worker = spawn(process.execPath, args, { detached: process.argv.includes('--detached-worker'), stdio: ['ignore', 'pipe', 'inherit'] });
  worker.stdout.once('data', () => {
    console.log(JSON.stringify({ root: process.pid, worker: worker.pid }));
    if (process.argv.includes('--exit-root')) {
      worker.stdout.destroy(); worker.unref(); process.exit(0);
    }
  });
  setInterval(() => {}, 1000);
}
