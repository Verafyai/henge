#!/usr/bin/env -S npx tsx
import { run } from './cli';

process.exitCode = await run(process.argv.slice(2), { out: (s) => console.log(s), err: (s) => console.error(s) });
