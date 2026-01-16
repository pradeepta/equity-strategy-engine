/**
 * CLI: Export Strategy
 * Exports a strategy's YAML content to a file
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { getRepositoryFactory } from '../database/RepositoryFactory';

dotenv.config();

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let strategyId: string | undefined;
  let outputPath: string | undefined;
  let versionNumber: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--id=')) {
      strategyId = args[i].split('=')[1];
    } else if (args[i].startsWith('--output=')) {
      outputPath = args[i].split('=')[1];
    } else if (args[i].startsWith('--version=')) {
      versionNumber = parseInt(args[i].split('=')[1]);
    }
  }

  // Validate arguments
  if (!strategyId) {
    console.error('Error: --id=<strategyId> is required');
    console.log('');
    console.log('Usage: npm run strategy:export -- --id=<strategyId> --output=<filepath> [--version=<versionNumber>]');
    console.log('');
    console.log('Example: npm run strategy:export -- --id=clfx123 --output=./backup.yaml');
    console.log('Example: npm run strategy:export -- --id=clfx123 --output=./backup.yaml --version=3');
    process.exit(1);
  }

  if (!outputPath) {
    console.error('Error: --output=<filepath> is required');
    console.log('');
    console.log('Usage: npm run strategy:export -- --id=<strategyId> --output=<filepath> [--version=<versionNumber>]');
    process.exit(1);
  }

  // Export strategy
  const factory = getRepositoryFactory();
  const strategyRepo = factory.getStrategyRepo();

  try {
    let yamlContent: string;
    let strategyName: string;

    if (versionNumber) {
      // Export specific version
      const versions = await strategyRepo.getVersionHistory(strategyId);
      const targetVersion = versions.find((v) => v.versionNumber === versionNumber);

      if (!targetVersion) {
        console.error(`Error: Version ${versionNumber} not found`);
        await factory.disconnect();
        process.exit(1);
      }

      yamlContent = targetVersion.yamlContent;
      strategyName = targetVersion.name;

      console.log('');
      console.log(`📤 Exporting strategy version ${versionNumber}...`);
    } else {
      // Export current version
      const strategy = await strategyRepo.findById(strategyId);

      if (!strategy) {
        console.error(`Error: Strategy not found: ${strategyId}`);
        await factory.disconnect();
        process.exit(1);
      }

      yamlContent = strategy.yamlContent;
      strategyName = strategy.name;

      console.log('');
      console.log('📤 Exporting strategy (current version)...');
    }

    console.log(`   Strategy: ${strategyName}`);
    console.log(`   Output: ${outputPath}`);

    // Write to file
    await fs.promises.writeFile(outputPath, yamlContent, 'utf-8');

    console.log('');
    console.log('✅ Strategy exported successfully!');
    console.log('');

    await factory.disconnect();
  } catch (error: any) {
    console.error('');
    console.error('❌ Failed to export strategy:', error.message);
    console.error('');
    await factory.disconnect();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
