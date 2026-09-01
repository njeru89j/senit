import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const backendDirectory = resolve(scriptDirectory, '..');
const sourceDirectory = resolve(backendDirectory, '../frontend/dist/frontend/browser');
const targetDirectory = resolve(backendDirectory, 'public');

await rm(targetDirectory, { recursive: true, force: true });
await mkdir(targetDirectory, { recursive: true });
await cp(sourceDirectory, targetDirectory, { recursive: true });

console.log(`Copied Angular build to ${targetDirectory}`);
