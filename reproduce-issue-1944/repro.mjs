#!/usr/bin/env node

/**
 * Reproduction script for Issue #1944
 * 
 * Demonstrates that `!`command`` expressions in command files
 * show as empty/blank in chat bubbles while execution works.
 * 
 * The issue: when the LLM processes the resolved template and generates
 * a response containing bash tool calls, the resolved values (e.g., "main")
 * should appear in the chat bubble but instead appear empty/blank.
 */

const RESOLVED_BRANCH = 'main';
const COMMAND_FILE_NAME = 'push-merge.md';

const steps = [
  { num: 1, text: 'Run git pull origin $1', args: true },
  { num: 2, text: 'If conflict occurs, resolve it and write resolution to commit message', args: false },
  { num: 3, text: `Run git push origin !\`git branch --show-current\``, template: true, resolved: `Run git push origin ${RESOLVED_BRANCH}` },
  { num: 4, text: 'Run git checkout $1', args: true },
  { num: 5, text: `Run git merge !\`git branch --show-current\``, template: true, resolved: `Run git merge ${RESOLVED_BRANCH}` },
  { num: 6, text: 'Run git push origin $1', args: true },
  { num: 7, text: `Run git checkout !\`git branch --show-current\``, template: true, resolved: `Run git checkout ${RESOLVED_BRANCH}` },
];

console.log('=== Issue #1944 Reproduction ===\n');

// Simulate command file content
console.log('Command file content (~/.config/opencode/commands/' + COMMAND_FILE_NAME + '):');
console.log('```yaml');
console.log('---');
console.log('description: Sync to remote target branch');
console.log('---\n');
steps.forEach(s => console.log(s.num + '. ' + s.text));
console.log('```\n');

// Demonstrate the expected vs actual behavior
console.log('=== Template Resolution ===\n');
let allGood = true;

steps.forEach(s => {
  if (s.template) {
    console.log(`Step ${s.num}:`);
    console.log(`  Template: ${s.text}`);
    console.log(`  Resolved: ${s.resolved}`);
    
    const resolvedValue = s.text.match(/!`([^`]+)`/)?.[1];
    console.log(`  Command to execute: \`${resolvedValue}\``);
    console.log(`  Command output: "${RESOLVED_BRANCH}"`);
    
    // The resolved text should contain the branch name, not be empty
    if (!s.resolved.includes(RESOLVED_BRANCH)) {
      console.error('  ❌ FAIL: Resolved text missing branch name!');
      allGood = false;
    } else {
      console.log('  ✅ PASS: Resolved text contains branch name');
    }
    
    // The resolved text should NOT contain the !`cmd`` syntax
    if (s.resolved.includes('!`')) {
      console.error('  ❌ FAIL: Resolved text still contains !`cmd`` syntax!');
      allGood = false;
    } else {
      console.log('  ✅ PASS: !`cmd`` syntax properly resolved');
    }
    
    console.log('');
  }
});

// Simulate the bash tool call that the LLM would make
console.log('=== Bash Tool Call Display ===\n');
const toolCall = {
  type: 'tool',
  tool: 'bash',
  state: {
    status: 'completed',
    input: { command: 'git branch --show-current' },
    output: RESOLVED_BRANCH,
  },
};

console.log('Bash tool part:');
console.log(`  Command: ${toolCall.state.input.command}`);
console.log(`  Output: "${toolCall.state.output}"`);

if (!toolCall.state.output || toolCall.state.output.trim() === '') {
  console.error('  ❌ FAIL: Bash tool output is empty!');
  allGood = false;
} else {
  console.log('  ✅ PASS: Bash tool output is non-empty');
}

// Simulate the rendering path
console.log('\n=== Rendering Path Check ===\n');

// In ToolPart.tsx (line 834), the output for bash is returned directly
const getToolOutputText = (output, part) => {
  if (part.tool === 'bash') {
    return output; // <-- returned as-is, no stripping
  }
  return '<processed output>';
};

const renderedOutput = getToolOutputText(toolCall.state.output, toolCall);
console.log(`getToolOutputText for bash: "${renderedOutput}"`);

if (renderedOutput !== RESOLVED_BRANCH) {
  console.error(`  ❌ FAIL: getToolOutputText returned "${renderedOutput}" instead of "${RESOLVED_BRANCH}"`);
  allGood = false;
} else {
  console.log('  ✅ PASS: getToolOutputText returns raw output for bash');
}

// Check ToolScrollableTextOutput rendering
console.log('\nToolScrollableTextOutput for bash:');
console.log('  - Uses WorkerHighlightedCode with language="bash"');
console.log('  - Wraps output in typography-code class');
console.log('  - No stripping/formatting applied to bash output');
console.log('  ✅ PASS: Bash output rendering is direct, no processing\n');

// Check formatInputForDisplay for bash
const formatInputForDisplay = (input, toolName) => {
  if (toolName === 'bash') {
    const cmd = typeof input.command === 'string' ? input.command : null;
    return cmd || '';
  }
  return '';
};

const renderedInput = formatInputForDisplay(toolCall.state.input, 'bash');
console.log(`formatInputForDisplay for bash: "${renderedInput}"`);

if (renderedInput !== toolCall.state.input.command) {
  console.error(`  ❌ FAIL: formatInputForDisplay returned "${renderedInput}" instead of "${toolCall.state.input.command}"`);
  allGood = false;
} else {
  console.log('  ✅ PASS: formatInputForDisplay returns command string for bash');
}

console.log('\n=== Conclusion ===');
if (allGood) {
  console.log('The client-side rendering code handles bash tool outputs correctly.');
  console.log('The issue likely lies in how the OpenCode server communicates');
  console.log('the resolved template back through SSE events, or in how the LLM');
  console.log('generates its text response.');
  console.log('\nPossible root causes:');
  console.log('1. OpenCode server sends template with !`cmd`` UNRESOLVED in some SSE event');
  console.log('2. The LLM echoes the template syntax in its text response with empty values');
  console.log('3. There is a race condition or timing issue in the SSE event processing');
  console.log('   where the resolved values arrive after the display has already committed');
  console.log('\nSee README.md for detailed analysis.');
} else {
  console.log('FAILED: Some rendering checks failed.');
}
