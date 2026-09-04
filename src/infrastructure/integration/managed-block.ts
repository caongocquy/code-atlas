function count(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

function blockRange(text: string, startMarker: string, endMarker: string): { start: number; end: number } | undefined {
  const starts = count(text, startMarker);
  const ends = count(text, endMarker);
  if (starts === 0 && ends === 0) return undefined;
  if (starts !== 1 || ends !== 1) {
    throw new Error(`Managed block markers are unbalanced or duplicated: ${startMarker}`);
  }

  const start = text.indexOf(startMarker);
  const endMarkerStart = text.indexOf(endMarker, start + startMarker.length);
  if (endMarkerStart < 0) throw new Error(`Managed block end marker is missing: ${endMarker}`);
  return { start, end: endMarkerStart + endMarker.length };
}

export function hasManagedBlock(text: string, startMarker: string, endMarker: string): boolean {
  return blockRange(text, startMarker, endMarker) !== undefined;
}

export function updateManagedBlock(
  text: string,
  startMarker: string,
  endMarker: string,
  body: string,
  metadataComment = "<!-- code-atlas:final-newline={value} -->",
): string {
  const range = blockRange(text, startMarker, endMarker);
  const previousBlock = range ? text.slice(range.start, range.end) : "";
  const originalFinalNewline = previousBlock.match(/final-newline=(0|1)/)?.[1]
    ?? (text.endsWith("\n") ? "1" : "0");
  const metadata = metadataComment.replace("{value}", originalFinalNewline);
  const block = `${startMarker}\n${metadata}\n${body.trimEnd()}\n${endMarker}`;

  if (range) {
    return `${text.slice(0, range.start)}${block}${text.slice(range.end)}`;
  }

  const separator = text.length === 0 ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${separator}${block}\n`;
}

export function removeManagedBlock(
  text: string,
  startMarker: string,
  endMarker: string,
): string {
  const range = blockRange(text, startMarker, endMarker);
  if (!range) return text;

  const block = text.slice(range.start, range.end);
  const restoreFinalNewline = /final-newline=1/.test(block);

  let start = range.start;
  const before = text.slice(0, start);
  if (before.endsWith("\n\n")) start -= 2;
  else if (before.endsWith("\n")) start -= 1;

  let end = range.end;
  if (text.startsWith("\r\n", end)) end += 2;
  else if (text.startsWith("\n", end)) end += 1;
  const restored = `${text.slice(0, start)}${text.slice(end)}`;
  return restoreFinalNewline && !restored.endsWith("\n") ? `${restored}\n` : restored;
}
