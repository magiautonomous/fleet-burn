#!/usr/bin/env node
// Thin shim: the logic lives in bin/cli.js so it is testable in-process.
import { run } from './cli.js';

const chunks = [];
const readStdin = process.argv.includes('-')
  ? new Promise((resolve) => {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', () => resolve(chunks.join('')));
      process.stdin.on('error', () => resolve(chunks.join('')));
    })
  : Promise.resolve(null);

const stdin = await readStdin;
const result = run(process.argv.slice(2), { stdin, stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) });
process.exitCode = result.code;
