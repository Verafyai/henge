#!/usr/bin/env node
// A stand-in Lean for tests. It never checks proofs; it reacts to marker words in the checked file
// so tests can drive every outcome of the real checker deterministically.
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('Lean (version 4.0.0, fake for tests)');
  process.exit(0);
}
if (process.env.VERIFY_TEST_SECRET) {
  console.error('environment leaked into the checker');
  process.exit(4);
}
const src = readFileSync(args.at(-1), 'utf8');
const name = /#print axioms (\S+)/.exec(src)?.[1] ?? '?';
const ok = () => {
  if (src.includes('USE_SORRY_AXIOM')) console.log(`'${name}' depends on axioms: [sorryAx]`);
  else if (src.includes('USE_CUSTOM_AXIOM')) console.log(`'${name}' depends on axioms: [propext, myAxiom]`);
  else if (src.includes('USE_CHOICE')) console.log(`'${name}' depends on axioms: [propext, Classical.choice, Quot.sound]`);
  else if (!src.includes('NO_AXIOM_LINE')) console.log(`'${name}' does not depend on any axioms`);
  process.exit(0);
};
if (src.includes('SLEEP_FOREVER')) setTimeout(() => {}, 1e9);
else if (src.includes('FAIL')) {
  console.error('Check.lean:2:2: error: unsolved goals');
  process.exit(1);
} else if (src.includes('TRY_NETWORK')) {
  const s = connect({ host: '1.1.1.1', port: 443, timeout: 2000 });
  s.on('connect', () => {
    console.error('network reachable');
    process.exit(3);
  });
  s.on('error', ok);
  s.on('timeout', ok);
} else ok();
