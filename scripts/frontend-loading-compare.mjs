import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { argumentsOf, buildContract, jsonFile, outputRoot } from './frontend-loading-core.mjs';

const options = argumentsOf(process.argv.slice(2), ['output-root']);
const output = outputRoot(options['output-root']);
const contract = buildContract(jsonFile(path.join(output, 'baseline/build.json')), jsonFile(path.join(output, 'after/build.json')));
writeFileSync(path.join(output, 'contract.json'), JSON.stringify(contract, null, 2) + '\n');
const before = contract.baseline.eager;
const after = contract.after.eager;
const report = `# Frontend production loading comparison\n\nFixed baseline: ${contract.baselineRevision}. Same Node, Vite, lockfile and explicit build parameters.\n\n`
  + '| Homepage eager closure | Before | After |\n|---|---:|---:|\n'
  + `| JS raw bytes | ${before.jsRawBytes} | ${after.jsRawBytes} |\n| JS gzip estimate bytes | ${before.jsGzipBytes} | ${after.jsGzipBytes} |\n`
  + `| CSS raw bytes | ${before.cssRawBytes} | ${after.cssRawBytes} |\n| CSS gzip estimate bytes | ${before.cssGzipBytes} | ${after.cssGzipBytes} |\n\n`
  + 'Gzip values are independent level-9 estimates per asset. Actual browser encoded bytes are measured separately; neither is a throughput claim.\n\n'
  + `Verified ${contract.lazyEntries.length} independent dynamic entries, ${contract.administratorDeferredDependencies.length} deferred administrator source dependencies, and ${contract.administratorTableImplementations.length} Table implementation modules outside the eager closure. This does not claim exhaustive ownership of every third-party module.\n\n`
  + '| Source module | Dynamic entry |\n|---|---|\n' + contract.lazyEntries.map(entry => `| ${entry.module} | ${entry.file} |`).join('\n') + '\n';
writeFileSync(path.join(output, 'comparison.md'), report);
process.stdout.write(report);
