import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const absWorkingDir = fileURLToPath(new URL('.', import.meta.url));
await Promise.all([
  build({ absWorkingDir, entryPoints: ['panel/main.ts'], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', outfile: 'panel/main.js' }),
  build({ absWorkingDir, entryPoints: ['service/main.ts'], bundle: true, format: 'esm', platform: 'node', target: 'node22', outfile: 'service/main.js' }),
]);
