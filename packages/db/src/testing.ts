/** For tests: build a fresh database (set PGLITE_DIR=memory:// first). */
export { runMigrations } from './migrate';
export { seed } from './seed';
export { postMachineVerdict, settleMachineChecks, testWorker } from './test-support';
export * from './community/test-fixtures';
