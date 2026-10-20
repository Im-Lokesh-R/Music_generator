// Promise-based wrapper around the generation Web Worker.
let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, type, payload } = e.data;
      const p = pending.get(id);
      if (!p) return;
      if (type === 'progress') p.onProgress?.(payload);
      else {
        pending.delete(id);
        type === 'error' ? p.reject(new Error(payload)) : p.resolve(payload);
      }
    };
  }
  return worker;
}

function call(type, payload, onProgress) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, type, payload });
  });
}

export const loadModel = (base = '/models') => call('loadModel', { base });
export const generate = (req, onProgress) => call('generate', req, onProgress);
