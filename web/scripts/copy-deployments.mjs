// Makes the deployment address files and the contract interfaces available to the
// browser, so the interface picks its addresses from the chain the wallet is on.
import { cpSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const target = join(here, '..', 'public');

mkdirSync(join(target, 'deploy'), { recursive: true });
const source = join(root, 'deploy');
if (existsSync(source)) {
  for (const f of readdirSync(source)) {
    if (f.endsWith('.json')) cpSync(join(source, f), join(target, 'deploy', f));
  }
}
cpSync(join(root, 'shared', 'abi.json'), join(target, 'abi.json'));
cpSync(join(root, 'shared', 'assets.json'), join(target, 'assets.json'));
console.log('deployment files copied into web/public');
