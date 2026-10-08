import { spawn } from 'node:child_process';

export async function startWorker() {
  const child = spawn('bun', ['./test/financial-worker.ts'], {
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  let readyResolve: () => void;
  let resultResolve: (value: any) => void;
  let rejectResult: (reason: Error) => void;
  let rejectReady: (reason: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    rejectReady = reject;
  });
  const result = new Promise<any>((resolve, reject) => {
    resultResolve = resolve;
    rejectResult = reject;
  });
  // Evita rejeição não tratada se o processo falhar antes de ficar pronto.
  void result.catch(() => {});
  child.stdout.on('data', (chunk) => {
    output += chunk;
    if (output.includes('READY\n')) readyResolve();
    const match = output.match(/RESULT (.+)\n/);
    if (match) resultResolve(JSON.parse(match[1]));
  });
  child.on('error', (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  child.on('exit', (code) => {
    if (code && !output.includes('RESULT ')) {
      const error = new Error(`Worker falhou: ${errors}`);
      rejectReady(error);
      rejectResult(error);
    }
  });
  await ready;
  return {
    child,
    result,
    send(job: unknown) {
      child.stdin.end(JSON.stringify(job) + '\n');
    },
  };
}
