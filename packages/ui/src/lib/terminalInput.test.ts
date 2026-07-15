import { describe, expect, test } from 'bun:test';
import { terminalControlCharacter, terminalSequenceForKey } from './terminalInput';

describe('terminal input translation', () => {
  test('translates navigation, editing, and control keys', () => {
    expect(terminalSequenceForKey('arrow-up', null)).toBe('\u001b[A');
    expect(terminalSequenceForKey('arrow-left', 'ctrl')).toBe('\u001b[1;5D');
    expect(terminalSequenceForKey('arrow-right', 'cmd')).toBe('\u001b[1;3C');
    expect(terminalSequenceForKey('enter', null)).toBe('\r');
    expect(terminalControlCharacter('c')).toBe('\u0003');
    expect(terminalControlCharacter('[')).toBeNull();
  });
});
