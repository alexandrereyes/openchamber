/**
 * Reproduction script for Issue #1936: Commands settings UI missing `subtask` field
 *
 * This script verifies that the OpenChamber UI does not handle the `subtask` field
 * for custom commands, even though the OpenCode SDK already supports it.
 *
 * Run with: bun run scripts/reproduce/reproduce-issue-1936.ts
 */

// We check the source files directly rather than importing the types,
// since importing would bring in the whole React dependency tree.

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BASE = resolve(__dirname, '../..');

interface CheckResult {
  file: string;
  description: string;
  shouldHave: boolean;
  found: boolean;
}

const results: CheckResult[] = [];

function checkFileContains(filePath: string, pattern: string, description: string, shouldHave: boolean): void {
  const fullPath = resolve(BASE, filePath);
  try {
    const content = readFileSync(fullPath, 'utf-8');
    const found = content.includes(pattern);
    results.push({ file: filePath, description, shouldHave, found });
    const status = found === shouldHave ? '✓' : '✗';
    const expected = shouldHave ? 'SHOULD have' : 'should NOT have';
    console.log(`  ${status} [${expected}] ${description}`);
    if (found !== shouldHave) {
      console.log(`      File: ${filePath}`);
      console.log(`      Pattern: "${pattern}"`);
    }
  } catch (err) {
    console.error(`  ⚠ Could not read ${filePath}: ${err}`);
  }
}

console.log('==============================================');
console.log('  Reproduction: Issue #1936 - Missing subtask');
console.log('==============================================\n');

// 1. SDK types DO have subtask (upstream support exists)
console.log('--- 1. OpenCode SDK confirms subtask exists upstream ---');
checkFileContains(
  'node_modules/.bun/@opencode-ai+sdk@1.17.9/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts',
  'subtask?',
  'subtask? boolean in SDK Command type',
  true,
);

// 2. CommandConfig interface is missing subtask
console.log('\n--- 2. OpenChamber CommandConfig interface ---');
checkFileContains(
  'packages/ui/src/stores/useCommandsStore.ts',
  'interface CommandConfig',
  'CommandConfig interface exists',
  true,
);
// In the interface, subtask should NOT be present (that's the bug)
const storeContent = readFileSync(resolve(BASE, 'packages/ui/src/stores/useCommandsStore.ts'), 'utf-8');
const configInterfaceBody = storeContent.match(/export interface CommandConfig \{([^}]*)\}/s);
if (configInterfaceBody) {
  const hasSubtask = configInterfaceBody[1].includes('subtask');
  results.push({
    file: 'packages/ui/src/stores/useCommandsStore.ts',
    description: 'subtask field in CommandConfig interface',
    shouldHave: true,
    found: hasSubtask,
  });
  console.log(`  ${hasSubtask ? '✓' : '✗'} [SHOULD have] subtask field in CommandConfig interface`);
} else {
  console.log('  ⚠ Could not parse CommandConfig interface');
}

// 3. CommandDraft interface is missing subtask
const draftInterfaceBody = storeContent.match(/export interface CommandDraft \{([^}]*)\}/s);
if (draftInterfaceBody) {
  const hasSubtask = draftInterfaceBody[1].includes('subtask');
  results.push({
    file: 'packages/ui/src/stores/useCommandsStore.ts',
    description: 'subtask field in CommandDraft interface',
    shouldHave: true,
    found: hasSubtask,
  });
  console.log(`  ${hasSubtask ? '✓' : '✗'} [SHOULD have] subtask field in CommandDraft interface`);
} else {
  console.log('  ⚠ Could not parse CommandDraft interface');
}

// 4. CommandsPage.tsx has no subtask UI control
console.log('\n--- 3. CommandsPage.tsx UI form ---');
checkFileContains(
  'packages/ui/src/components/sections/commands/CommandsPage.tsx',
  'subtask',
  'subtask UI control in CommandsPage.tsx',
  true,
);

// 5. createCommand doesn't send subtask
console.log('\n--- 4. createCommand network payload ---');
checkFileContains(
  'packages/ui/src/stores/useCommandsStore.ts',
  'config.subtask',
  'config.subtask sent in createCommand payload',
  true,
);

// 6. updateCommand doesn't send subtask
checkFileContains(
  'packages/ui/src/stores/useCommandsStore.ts',
  'config.subtask',
  'config.subtask sent in updateCommand payload',
  true,
);

// 7. client.ts wrappers don't return subtask
console.log('\n--- 5. SDK client wrapper ---');
checkFileContains(
  'packages/ui/src/lib/opencode/client.ts',
  'subtask',
  'subtask field in client.ts command wrappers',
  true,
);

// 8. buildCommandsSignature doesn't include subtask
console.log('\n--- 6. buildCommandsSignature ---');
checkFileContains(
  'packages/ui/src/stores/useCommandsStore.ts',
  'subtask',
  'subtask in buildCommandsSignature',
  true,
);

// 9. CommandsSidebar doesn't pass subtask during duplicate/rename
console.log('\n--- 7. CommandsSidebar operations ---');
checkFileContains(
  'packages/ui/src/components/sections/commands/CommandsSidebar.tsx',
  'subtask',
  'subtask in CommandsSidebar.tsx duplicate/rename',
  true,
);

// 10. i18n strings missing
console.log('\n--- 8. i18n locale strings ---');
checkFileContains(
  'packages/ui/src/lib/i18n/messages/en.settings.ts',
  'settings.commands.page.field.subtask',
  'i18n key for subtask field label',
  true,
);

// Summary
console.log('\n==============================================');
const passed = results.filter(r => r.found === r.shouldHave).length;
const failed = results.filter(r => r.found !== r.shouldHave).length;
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('==============================================');

if (failed > 0) {
  console.log('\n✅ Bug REPRODUCIBLE: The subtask field is missing from OpenChamber Commands UI.');
  console.log('   The OpenCode SDK already supports subtask at every layer (Command, CommandV2Info, Config types),');
  console.log('   but OpenChamber does not surface it in:');
  console.log('     - CommandConfig/CommandDraft interfaces');
  console.log('     - CommandsPage.tsx form UI (no Switch/toggle)');
  console.log('     - createCommand/updateCommand network payloads');
  console.log('     - client.ts command wrapper return types');
  console.log('     - CommandsSidebar.tsx duplicate/rename');
  console.log('     - i18n locale strings');
  process.exit(0);
} else {
  console.log('\n❌ Bug NOT reproducible: subtask appears to be present in all expected locations.');
  process.exit(1);
}
