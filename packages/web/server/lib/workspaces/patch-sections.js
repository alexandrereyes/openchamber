import crypto from 'node:crypto';

const DIFF_HEADER = 'diff --git ';

function splitLinesKeepingEndings(text) {
  const matches = text.match(/.*(?:\r\n|\n|\r|$)/g) ?? [];
  if (matches.at(-1) === '') matches.pop();
  return matches;
}

function lineContent(line) {
  return line.replace(/\r?\n$|\r$/, '');
}

function readToken(input, start) {
  let index = start;
  while (input[index] === ' ') index += 1;
  if (input[index] !== '"') {
    const end = input.indexOf(' ', index);
    if (end === -1) return { token: input.slice(index), next: input.length };
    return { token: input.slice(index, end), next: end + 1 };
  }

  let token = '"';
  index += 1;
  let escaped = false;
  while (index < input.length) {
    const char = input[index];
    token += char;
    index += 1;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') break;
  }
  return { token, next: index };
}

function unquoteGitPath(token) {
  if (!token.startsWith('"') || !token.endsWith('"')) return token;
  const body = token.slice(1, -1);
  return body.replace(/\\([\\"abfnrtv])/g, (_, escaped) => {
    switch (escaped) {
      case 'a': return '\u0007';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'v': return '\v';
      default: return escaped;
    }
  }).replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function stripGitSidePrefix(token) {
  const value = unquoteGitPath(token);
  if (value.startsWith('a/') || value.startsWith('b/')) return value.slice(2);
  return value;
}

function parseDiffHeader(line) {
  if (!line.startsWith(DIFF_HEADER)) return null;
  const rest = line.slice(DIFF_HEADER.length);
  const left = readToken(rest, 0);
  const right = readToken(rest, left.next);
  if (!left.token || !right.token) return null;
  return {
    oldPath: stripGitSidePrefix(left.token),
    newPath: stripGitSidePrefix(right.token),
  };
}

function classifySection(lines, headerPaths) {
  let oldPath = headerPaths.oldPath;
  let newPath = headerPaths.newPath;
  let changeType = 'M';
  let binary = false;
  let additions = 0;
  let deletions = 0;

  for (const rawLine of lines) {
    const line = lineContent(rawLine);
    if (line === 'new file mode' || line.startsWith('new file mode ')) changeType = 'A';
    else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) changeType = 'D';
    else if (line.startsWith('rename from ')) {
      changeType = 'R';
      oldPath = line.slice('rename from '.length);
    } else if (line.startsWith('rename to ')) {
      changeType = 'R';
      newPath = line.slice('rename to '.length);
    } else if (line.startsWith('copy from ')) {
      changeType = 'C';
      oldPath = line.slice('copy from '.length);
    } else if (line.startsWith('copy to ')) {
      changeType = 'C';
      newPath = line.slice('copy to '.length);
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      binary = true;
    }

    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }

  return { oldPath, newPath, path: newPath || oldPath, changeType, binary, additions, deletions };
}

export function parseWorkspacePatchSections(patch) {
  if (typeof patch !== 'string') throw new Error('Patch must be a string');
  const lines = splitLinesKeepingEndings(patch);
  const sections = [];
  let current = null;
  let preamble = '';

  for (const rawLine of lines) {
    const line = lineContent(rawLine);
    const headerPaths = parseDiffHeader(line);
    if (headerPaths) {
      if (current) sections.push(current);
      current = { headerPaths, lines: [rawLine] };
      continue;
    }
    if (!current) {
      preamble += rawLine;
      continue;
    }
    current.lines.push(rawLine);
  }
  if (current) sections.push(current);
  if (sections.length === 0 && patch.trim()) throw new Error('Patch does not contain any git file sections');

  return sections.map((section, index) => {
    const content = section.lines.join('');
    const classified = classifySection(section.lines, section.headerPaths);
    const id = crypto
      .createHash('sha256')
      .update(`${index}\0${classified.oldPath}\0${classified.newPath}\0${content}`)
      .digest('hex')
      .slice(0, 24);
    return { id, index, ...classified, additions: classified.additions, deletions: classified.deletions, content, preamble: index === 0 ? preamble : '' };
  });
}

export function summarizePatchSections(sections) {
  const files = sections.map((section) => ({
    id: section.id,
    path: section.path,
    oldPath: section.oldPath,
    newPath: section.newPath,
    changeType: section.changeType,
    binary: section.binary,
    additions: section.additions,
    deletions: section.deletions,
  }));
  return {
    files,
    totalFiles: files.length,
    additions: files.reduce((sum, item) => sum + item.additions, 0),
    deletions: files.reduce((sum, item) => sum + item.deletions, 0),
  };
}

export function buildPatchFromSectionIDs(sections, fileIDs) {
  const requested = new Set(fileIDs);
  const selected = sections.filter((section) => requested.has(section.id));
  if (selected.length !== requested.size) throw new Error('Selected patch file is no longer available');
  if (selected.length === 0) throw new Error('Select at least one file to apply');
  return `${sections[0]?.preamble ?? ''}${selected.map((section) => section.content).join('')}`;
}
