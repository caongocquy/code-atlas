const varint = (value: number): Buffer => {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
};

const scalar = (field: number, value: number): Buffer => Buffer.concat([varint(field << 3), varint(value)]);

const bytes = (field: number, value: Uint8Array): Buffer => Buffer.concat([
  varint((field << 3) | 2),
  varint(value.byteLength),
  Buffer.from(value),
]);

const string = (field: number, value: string): Buffer => bytes(field, Buffer.from(value, "utf8"));

export type ScipFixtureOccurrence = {
  range?: readonly number[];
  singleLineRange?: { line: number; startCharacter: number; endCharacter: number };
  multiLineRange?: { startLine: number; startCharacter: number; endLine: number; endCharacter: number };
  symbol: string;
  roles: number;
};

export function encodeScipOccurrence(occurrence: ScipFixtureOccurrence): Buffer {
  const range = occurrence.range === undefined ? [] : [bytes(1, Buffer.concat(occurrence.range.map(varint)))];
  const singleLineRange = occurrence.singleLineRange === undefined ? [] : [bytes(8, Buffer.concat([
    scalar(1, occurrence.singleLineRange.line),
    scalar(2, occurrence.singleLineRange.startCharacter),
    scalar(3, occurrence.singleLineRange.endCharacter),
  ]))];
  const multiLineRange = occurrence.multiLineRange === undefined ? [] : [bytes(9, Buffer.concat([
    scalar(1, occurrence.multiLineRange.startLine),
    scalar(2, occurrence.multiLineRange.startCharacter),
    scalar(3, occurrence.multiLineRange.endLine),
    scalar(4, occurrence.multiLineRange.endCharacter),
  ]))];
  return Buffer.concat([
    ...range,
    ...singleLineRange,
    ...multiLineRange,
    string(2, occurrence.symbol),
    scalar(3, occurrence.roles),
  ]);
}

export function encodeScipDocument(relativePath: string, occurrences: readonly ScipFixtureOccurrence[], positionEncoding?: number): Buffer {
  return Buffer.concat([
    string(1, relativePath),
    ...occurrences.map((occurrence) => bytes(2, encodeScipOccurrence(occurrence))),
    ...(positionEncoding === undefined ? [] : [scalar(6, positionEncoding)]),
  ]);
}

export function encodeScipIndex(documents: readonly Buffer[]): Buffer {
  return Buffer.concat(documents.map((document) => bytes(2, document)));
}
