// Publishes dist/ to the repo's gh-pages branch, which GitHub Pages serves.
// Run via `npm run deploy` (builds first). Uses the origin remote and your git login.
import { execSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';

const run = (cmd) => execSync(cmd, { cwd: 'dist', stdio: 'inherit' });

if (!existsSync('dist/index.html')) throw new Error('dist/ is missing: run `npm run build` first.');
const remote = execSync('git remote get-url origin').toString().trim();

rmSync('dist/.git', { recursive: true, force: true });
writeFileSync('dist/.nojekyll', ''); // serve files as-is, no Jekyll processing
run('git init -q -b gh-pages');
run('git add -A');
run('git commit -q -m "Deploy site"');
run(`git push -f ${remote} gh-pages`);
rmSync('dist/.git', { recursive: true, force: true });
console.log('Deployed dist/ to gh-pages.');
