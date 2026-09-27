import { runStoreContractTests } from '../../testing/run-store-contract.js';
import { MemoryRunStore } from './memory-run-store.js';

runStoreContractTests('MemoryRunStore', () =>
  Promise.resolve({ store: new MemoryRunStore(), dispose: () => Promise.resolve() }),
);
