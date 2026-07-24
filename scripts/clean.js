import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const generatedDirectories = [
  'dist',
  'dist-ssr',
  'logs',
  'node_modules',
  'release',
];
const generatedFilePatterns = [
  /\.log(?:\..*)?$/,
  /^(?:npm|yarn|pnpm|lerna)-debug\.log.*$/,
  /^yarn-error\.log.*$/,
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const unsupportedArgs = args.filter((arg) => arg !== '--dry-run');

if (unsupportedArgs.length > 0) {
  console.error(`Unsupported argument: ${unsupportedArgs.join(', ')}`);
  process.exitCode = 1;
} else {
  const rootEntries = await readdir(projectRoot, { withFileTypes: true });
  const rootEntryNames = new Set(rootEntries.map((entry) => entry.name));
  const generatedFiles = rootEntries
    .filter(
      (entry) =>
        entry.isFile() &&
        generatedFilePatterns.some((pattern) => pattern.test(entry.name)),
    )
    .map((entry) => entry.name);
  const targets = [
    ...generatedDirectories.filter((name) => rootEntryNames.has(name)),
    ...generatedFiles,
  ].sort();

  if (targets.length === 0) {
    console.log('Nothing to clean.');
  } else {
    for (const target of targets) {
      if (!dryRun) {
        await rm(join(projectRoot, target), { force: true, recursive: true });
      }
      console.log(`${dryRun ? 'Would remove' : 'Removed'} ${target}`);
    }
  }
}
