// Prepare isolated source-collection targets; this does not publish or run Docker.
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = await readFile(path.join(here, 'generated/runtime.Dockerfile'), 'utf8');
const sources = await readFile(path.join(here, 'source-stage.Dockerfile'), 'utf8');
if (!runtime.includes('FROM scratch AS browser-linux-runtime')) throw new Error('Run prepare-runtime.mjs first');
await writeFile(path.join(here, 'generated/sources.Dockerfile'), `${runtime}\n${sources}`);
console.log('Prepared separate runtime-source target. No compilation or publication performed.');
