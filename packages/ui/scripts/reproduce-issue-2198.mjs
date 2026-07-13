/**
 * Reproduction script for issue #2198:
 * "Editor font size setting has no effect on chat input textarea"
 *
 * This script verifies that:
 * 1. The useUIStore has `editorFontSize` field (correct)
 * 2. CodeMirror editors (FilesView, PlanView) use `editorFontSize` (correct)
 * 3. ChatInput.tsx does NOT use `editorFontSize` (the bug)
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..', '..');

const files = {
  store: join(root, 'packages', 'ui', 'src', 'stores', 'useUIStore.ts'),
  chatInput: join(root, 'packages', 'ui', 'src', 'components', 'chat', 'ChatInput.tsx'),
  filesView: join(root, 'packages', 'ui', 'src', 'components', 'views', 'FilesView.tsx'),
  planView: join(root, 'packages', 'ui', 'src', 'components', 'views', 'PlanView.tsx'),
  skillsPage: join(root, 'packages', 'ui', 'src', 'components', 'sections', 'skills', 'SkillsPage.tsx'),
};

// 1. Check that editorFontSize exists in the store
const storeContent = readFileSync(files.store, 'utf-8');
const storeHasEditorFontSize = /editorFontSize/.test(storeContent);
const storeHasSetter = /setEditorFontSize/.test(storeContent);
const storeDefaultValue = storeContent.match(/editorFontSize:\s*(\d+)/);

console.log('=== Issue #2198 Reproduction: Editor font size on chat input ===\n');
console.log(`1. useUIStore has "editorFontSize" field:        ${storeHasEditorFontSize ? '✓ YES' : '✗ NO'}`);
console.log(`2. useUIStore has "setEditorFontSize" setter:    ${storeHasSetter ? '✓ YES' : '✗ NO'}`);
console.log(`3. Default value:                                 ${storeDefaultValue ? storeDefaultValue[1] : 'NOT FOUND'}`);

// 2. Check which components use editorFontSize
function checkComponentUsage(name, filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const usesEditorFontSize = /editorFontSize/.test(content);
    const hasStoreSelector = /useUIStore.*editorFontSize/.test(content) || /editorFontSize.*useUIStore/.test(content);
    const hasInlineStyle = /fontSize.*editorFontSize/.test(content) || /editorFontSize.*fontSize/.test(content);
    return { usesEditorFontSize, hasStoreSelector, hasInlineStyle };
  } catch (e) {
    return { usesEditorFontSize: false, hasStoreSelector: false, hasInlineStyle: false, error: e.message };
  }
}

const chatInputResult = checkComponentUsage('ChatInput.tsx', files.chatInput);
const filesViewResult = checkComponentUsage('FilesView.tsx', files.filesView);
const planViewResult = checkComponentUsage('PlanView.tsx', files.planView);
const skillsResult = checkComponentUsage('SkillsPage.tsx', files.skillsPage);

console.log(`\n4. ChatInput.tsx uses editorFontSize:            ${chatInputResult.usesEditorFontSize ? '✗ YES (but should be NO)' : '✗ NO (BUG!)'}`);
console.log(`   - Store selector present:                      ${chatInputResult.hasStoreSelector ? '✗ YES' : '✗ NO'}`);
console.log(`   - Inline fontSize style present:                ${chatInputResult.hasInlineStyle ? '✗ YES' : '✗ NO'}`);
if (chatInputResult.error) console.log(`   - Error: ${chatInputResult.error}`);

console.log(`\n5. FilesView.tsx uses editorFontSize:            ${filesViewResult.usesEditorFontSize ? '✓ YES' : '✗ NO'}`);
console.log(`   - Store selector present:                      ${filesViewResult.hasStoreSelector ? '✓ YES' : '✗ NO'}`);
console.log(`   - Inline fontSize style present:                ${filesViewResult.hasInlineStyle ? '✓ YES' : '✗ NO'}`);

console.log(`\n6. PlanView.tsx uses editorFontSize:             ${planViewResult.usesEditorFontSize ? '✓ YES' : '✗ NO'}`);
console.log(`   - Store selector present:                      ${planViewResult.hasStoreSelector ? '✓ YES' : '✗ NO'}`);
console.log(`   - Inline fontSize style present:                ${planViewResult.hasInlineStyle ? '✓ YES' : '✗ NO'}`);

console.log(`\n7. SkillsPage.tsx uses editorFontSize:           ${skillsResult.usesEditorFontSize ? '✓ YES' : '✗ NO'}`);
console.log(`   - Store selector present:                      ${skillsResult.hasStoreSelector ? '✓ YES' : '✗ NO'}`);
console.log(`   - Inline fontSize style present:                ${skillsResult.hasInlineStyle ? '✓ YES' : '✗ NO'}`);

console.log(`\n=== VERDICT ===`);
if (
  storeHasEditorFontSize &&
  storeHasSetter &&
  filesViewResult.usesEditorFontSize &&
  planViewResult.usesEditorFontSize &&
  !chatInputResult.usesEditorFontSize
) {
  console.log('BUG CONFIRMED: editorFontSize exists in the store and is applied to');
  console.log('CodeMirror editors (FilesView, PlanView, SkillsPage) but is NOT applied');
  console.log('to the chat input textarea in ChatInput.tsx.\n');
  console.log('Fix: Add to ChatInput.tsx:');
  console.log('  1. Store selector: const editorFontSize = useUIStore((state) => state.editorFontSize);');
  console.log('  2. Inline style:   fontSize: `${editorFontSize}px` on the Textarea component');
  process.exit(1);
} else {
  console.log('Could not confirm bug (unexpected state)');
  process.exit(0);
}
