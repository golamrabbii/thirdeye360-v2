/**
 * Node version guard — runs automatically before `npm run dev`, `build` and
 * `start` (npm pre* hooks). Next.js 14 needs Node >= 18.17; this machine's
 * default Node is v16, so fail fast with the exact fix instead of letting
 * Next print its cryptic version error.
 */
const REQUIRED = '>=18.17.0';

const [major, minor] = process.versions.node.split('.').map(Number);
const ok = major > 18 || (major === 18 && minor >= 17);

if (!ok) {
  console.error(
    [
      '',
      '  ✖ ThirdEye360 v2 needs Node.js ' +
        REQUIRED +
        ', but you are using ' +
        process.version +
        '.',
      '',
      '  Fix (nvm is installed on this machine):',
      '      nvm use          # reads .nvmrc in this folder',
      '    — or —',
      '      nvm install 22 && nvm use 22',
      '',
      '  Then run your command again.',
      '',
    ].join('\n')
  );
  process.exit(1);
}
