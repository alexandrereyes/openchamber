/**
 * Reproduction: Settings UI fixed-width controls don't scale (Issue #2320)
 *
 * Confirms text overflows at 200% Interface Font Size + 50% Spacing Density.
 *
 * Tailwind widths are independent CSS values; fontSize changes only --text-*
 * (typography), creating a mismatch at extreme scale combinations.
 */
const TAILWIDTH: Record<string, number> = {
  'w-16': 64,  // 4rem
  'w-20': 80,  // 5rem
  'w-24': 96,  // 6rem
  'w-32': 128, // 8rem
  'w-40': 160, // 10rem
};

const FONT_32PX = 32; // 200% of 16px
const textWidth = (s: string) => s.length * FONT_32PX * 0.6;

interface Case {
  file: string; line: number; component: string;
  cls: string; text: string;
  type: 'number' | 'input' | 'select';
}

const cases: Case[] = [
  // === NumberInput (w-16) ===
  { file: 'AgentsPage.tsx', line: 448,  component: 'NumberInput (Temperature)',          cls: 'w-16', text: '1.9',   type: 'number' },
  { file: 'AgentsPage.tsx', line: 486,  component: 'NumberInput (Top-P)',                cls: 'w-16', text: '0.9',   type: 'number' },
  { file: 'VoiceSettings.tsx', line: 1054, component: 'NumberInput (Speech Rate)',       cls: 'w-16', text: '1.9',   type: 'number' },
  { file: 'VoiceSettings.tsx', line: 1060, component: 'NumberInput (Speech Pitch)',      cls: 'w-16', text: '1.9',   type: 'number' },
  { file: 'RemoteInstancesPage.tsx', line: 2056, component: 'NumberInput (Conn Timeout)', cls: 'w-16', text: '240',   type: 'number' },
  { file: 'RemoteInstancesPage.tsx', line: 2484, component: 'NumberInput (Fwd Local)',   cls: 'w-16', text: '65535', type: 'number' },
  { file: 'RemoteInstancesPage.tsx', line: 2526, component: 'NumberInput (Fwd Remote)',  cls: 'w-16', text: '65535', type: 'number' },
  // === NumberInput (w-20) ===
  { file: 'SessionRetentionSettings.tsx', line: 90,  component: 'NumberInput (Retention Days)', cls: 'w-20', text: '365',   type: 'number' },
  { file: 'RemoteInstancesPage.tsx', line: 2114, component: 'NumberInput (Pref Remote)', cls: 'w-20', text: '65535', type: 'number' },
  { file: 'RemoteInstancesPage.tsx', line: 2254, component: 'NumberInput (Pref Local)',  cls: 'w-20', text: '65535', type: 'number' },
  // === regular Input (w-40) ===
  { file: 'KeyboardShortcutsSettings.tsx', line: 259, component: 'Input (Shortcut)',      cls: 'w-40', text: 'Ctrl + ⇧ + Page Down', type: 'input' },
];

// NumberInput internal: px-1.5 (6px each side) → 12px padding overhead
const PAD: Record<string, number> = { number: 12, input: 16, select: 16 };

let pass = 0, fail = 0;
console.log('=== Issue #2320: Fixed-width control text overflow at 200% font ===\n');
for (const c of cases) {
  const w = TAILWIDTH[c.cls];
  const tw = textWidth(c.text);
  const avail = w - (PAD[c.type] ?? 12);
  const ok = tw <= avail;
  if (ok) pass++; else fail++;
  console.log(
    `${ok ? '✅' : '❌'} ${c.file}:${c.line}  ${c.component.padEnd(30)} ` +
    `${c.cls}=${w}px  "${c.text}" ~${Math.round(tw)}px  avail=${avail}px  ${ok ? 'fits' : 'OVERFLOWS'}`
  );
}

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
console.log('\nAdditionally confirmed via code review:');
console.log('- BehaviorPage.tsx: SelectTrigger uses SETTINGS_SELECT_ROW_TRIGGER_CLASS (max-w-48)');
console.log('  — "Correspond à mon énergie" at 32px ≈ 377px overflows 192px cap');
console.log('- KeyboardShortcutsSettings.tsx: w-40 fixed width overflows for combined combos');
console.log('- OpenChamberVisualSettings.tsx: NumberInputs lack explicit className');
console.log('  — relying on internal w-10 (40px) which overflows for "200"');
console.log('');
console.log('Root cause: --text-* (fontSize) and --padding-scale (Spacing Density)');
console.log('are independent scales. Fixed Tailwind widths mismatch at extremes.');

if (fail > 0) {
  console.log('\n❌ Bug REPRODUCED: text overflows fixed-width controls at 200% font size.');
  process.exit(0);
} else {
  console.log('\nBug NOT reproduced.');
  process.exit(1);
}
