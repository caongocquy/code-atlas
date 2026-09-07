export function maskSourceSyntax(source: string): string {
  const output = [...source];
  let state: "code" | "lineComment" | "blockComment" | "singleQuote" | "doubleQuote" | "template" = "code";

  const blank = (index: number): void => {
    if (source[index] !== "\n" && source[index] !== "\r") output[index] = " ";
  };

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (state === "code") {
      if (current === "/" && next === "/") {
        blank(index);
        blank(index + 1);
        index += 1;
        state = "lineComment";
      } else if (current === "/" && next === "*") {
        blank(index);
        blank(index + 1);
        index += 1;
        state = "blockComment";
      } else if (current === "'") {
        blank(index);
        state = "singleQuote";
      } else if (current === '"') {
        blank(index);
        state = "doubleQuote";
      } else if (current === "`") {
        blank(index);
        state = "template";
      }
      continue;
    }

    if (state === "lineComment") {
      if (current === "\n" || current === "\r") state = "code";
      else blank(index);
      continue;
    }

    if (state === "blockComment") {
      blank(index);
      if (current === "*" && next === "/") {
        blank(index + 1);
        index += 1;
        state = "code";
      }
      continue;
    }

    blank(index);
    if (current === "\\") {
      if (index + 1 < source.length) {
        blank(index + 1);
        index += 1;
      }
    } else if ((state === "singleQuote" && current === "'")
      || (state === "doubleQuote" && current === '"')
      || (state === "template" && current === "`")) {
      state = "code";
    }
  }

  return output.join("");
}
