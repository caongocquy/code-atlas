export function maskSourceSyntax(source: string): string {
  const output = [...source];

  const blank = (index: number): void => {
    if (source[index] !== "\n" && source[index] !== "\r") output[index] = " ";
  };

  function previousToken(index: number): string | undefined {
    const prefix = source.slice(0, index).match(/[A-Za-z_$][\w$]*|[^\s]/g);
    return prefix?.at(-1);
  }

  function mayStartRegex(index: number): boolean {
    const previous = previousToken(index);
    if (!previous) return true;
    if (previous.length === 1) return "([{:;,=!?&|+-*%^~<>".includes(previous);
    return ["return", "case", "throw", "else", "do", "typeof", "void", "delete", "new", "in", "of", "yield", "await"].includes(previous);
  }

  function scanRegex(start: number): number {
    let inCharacterClass = false;
    for (let index = start; index < source.length; index += 1) {
      const current = source[index];
      blank(index);
      if (current === "\\") {
        blank(index + 1);
        index += 1;
        continue;
      }
      if (current === "\n" || current === "\r") return index;
      if (current === "[") inCharacterClass = true;
      if (current === "]") inCharacterClass = false;
      if (current === "/" && !inCharacterClass) {
        let end = index + 1;
        while (/[A-Za-z]/.test(source[end] ?? "")) {
          blank(end);
          end += 1;
        }
        return end;
      }
    }
    return source.length;
  }

  function scanQuoted(start: number, quote: "'" | '"'): number {
    blank(start);
    for (let index = start + 1; index < source.length; index += 1) {
      const current = source[index];
      blank(index);
      if (current === "\\") {
        blank(index + 1);
        index += 1;
      } else if (current === quote) {
        return index + 1;
      }
    }
    return source.length;
  }

  function scanTemplate(start: number): number {
    blank(start);
    for (let index = start + 1; index < source.length; index += 1) {
      const current = source[index];
      if (current === "\\") {
        blank(index);
        blank(index + 1);
        index += 1;
      } else if (current === "`" ) {
        blank(index);
        return index + 1;
      } else if (current === "$" && source[index + 1] === "{") {
        blank(index);
        blank(index + 1);
        index = scanCode(index + 2, true);
        if (source[index] === "}") blank(index);
      } else {
        blank(index);
      }
    }
    return source.length;
  }

  function scanCode(start: number, stopAtBrace = false): number {
    let braceDepth = 0;
    for (let index = start; index < source.length; index += 1) {
      const current = source[index];
      const next = source[index + 1];
      if (current === "/" && next === "/") {
        blank(index);
        blank(index + 1);
        index += 1;
        while (index + 1 < source.length && source[index + 1] !== "\n" && source[index + 1] !== "\r") {
          index += 1;
          blank(index);
        }
      } else if (current === "/" && next === "*") {
        blank(index);
        blank(index + 1);
        index += 1;
        while (index + 1 < source.length) {
          index += 1;
          blank(index);
          if (source[index - 1] === "*" && source[index] === "/") break;
        }
      } else if ((current === "'" || current === '"')) {
        index = scanQuoted(index, current);
        index -= 1;
      } else if (current === "`") {
        index = scanTemplate(index);
        index -= 1;
      } else if (current === "/" && mayStartRegex(index)) {
        index = scanRegex(index);
        index -= 1;
      } else if (stopAtBrace && current === "{") {
        braceDepth += 1;
      } else if (stopAtBrace && current === "}") {
        if (braceDepth === 0) return index;
        braceDepth -= 1;
      }
    }
    return source.length;
  }

  scanCode(0);

  return output.join("");
}
