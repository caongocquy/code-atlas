const CONTROL_FLOW_KEYWORDS = new Set(["if", "while", "for", "switch", "catch"]);
const REGEX_PREFIXES = "([{:;,=!?&|+-*%^~<>";
const REGEX_KEYWORDS = new Set([
  "return",
  "case",
  "throw",
  "else",
  "do",
  "typeof",
  "void",
  "delete",
  "new",
  "in",
  "of",
  "yield",
  "await",
]);

type Delimiter = { kind: "(" | "[" | "{"; controlFlowParen?: boolean };

export function maskSourceSyntax(source: string): string {
  const output = [...source];

  const blank = (index: number): void => {
    if (source[index] !== "\n" && source[index] !== "\r") output[index] = " ";
  };

  function scanRegex(start: number): number {
    let inCharacterClass = false;
    blank(start);
    for (let index = start + 1; index < source.length; index += 1) {
      const current = source[index];
      blank(index);
      if (current === "\\") {
        blank(index + 1);
        index += 1;
        continue;
      }
      if (current === "\n" || current === "\r") return index;
      if (current === "[" && !inCharacterClass) inCharacterClass = true;
      if (current === "]" && inCharacterClass) inCharacterClass = false;
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

  function mayStartRegex(lastToken: string | undefined, closedControlFlowParen: boolean): boolean {
    if (closedControlFlowParen) return true;
    if (!lastToken) return true;
    if (lastToken.length === 1) return REGEX_PREFIXES.includes(lastToken);
    return REGEX_KEYWORDS.has(lastToken);
  }

  function scanTemplate(start: number): number {
    blank(start);
    for (let index = start + 1; index < source.length; index += 1) {
      const current = source[index];
      if (current === "\\") {
        blank(index);
        blank(index + 1);
        index += 1;
      } else if (current === "`") {
        blank(index);
        return index + 1;
      } else if (current === "$" && source[index + 1] === "{") {
        blank(index);
        blank(index + 1);
        const end = scanCode(index + 2, true, "{");
        if (source[end] === "}") {
          blank(end);
          index = end;
        } else {
          return source.length;
        }
      } else {
        blank(index);
      }
    }
    return source.length;
  }

  function scanCode(start: number, stopAtBrace = false, initialToken?: string): number {
    let braceDepth = 0;
    let lastToken = initialToken;
    let closedControlFlowParen = false;
    const delimiters: Delimiter[] = [];

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
      } else if (current === "'" || current === '"') {
        index = scanQuoted(index, current);
        lastToken = "literal";
        closedControlFlowParen = false;
        index -= 1;
      } else if (current === "`") {
        index = scanTemplate(index);
        lastToken = "literal";
        closedControlFlowParen = false;
        index -= 1;
      } else if (current === "/" && mayStartRegex(lastToken, closedControlFlowParen)) {
        index = scanRegex(index);
        lastToken = "literal";
        closedControlFlowParen = false;
        index -= 1;
      } else if (/[A-Za-z_$]/.test(current)) {
        let end = index + 1;
        while (/[A-Za-z0-9_$]/.test(source[end] ?? "")) end += 1;
        lastToken = source.slice(index, end);
        closedControlFlowParen = false;
        index = end - 1;
      } else if (current === "(") {
        delimiters.push({ kind: "(", controlFlowParen: CONTROL_FLOW_KEYWORDS.has(lastToken ?? "") });
        lastToken = current;
        closedControlFlowParen = false;
      } else if (current === ")") {
        let opening: Delimiter | undefined;
        for (let delimiterIndex = delimiters.length - 1; delimiterIndex >= 0; delimiterIndex -= 1) {
          if (delimiters[delimiterIndex]?.kind === "(") {
            opening = delimiters.splice(delimiterIndex, 1)[0];
            break;
          }
        }
        lastToken = current;
        closedControlFlowParen = Boolean(opening?.controlFlowParen);
      } else if (current === "[") {
        delimiters.push({ kind: "[" });
        lastToken = current;
        closedControlFlowParen = false;
      } else if (current === "]") {
        lastToken = current;
        closedControlFlowParen = false;
      } else if (current === "{") {
        delimiters.push({ kind: "{" });
        if (stopAtBrace) braceDepth += 1;
        lastToken = current;
        closedControlFlowParen = false;
      } else if (current === "}") {
        if (stopAtBrace && braceDepth === 0) return index;
        if (stopAtBrace) braceDepth -= 1;
        lastToken = current;
        closedControlFlowParen = false;
      } else if (!/\s/.test(current)) {
        lastToken = current;
        closedControlFlowParen = false;
      }
    }
    return source.length;
  }

  scanCode(0);

  return output.join("");
}
