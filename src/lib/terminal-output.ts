/** Whether text contains terminal controls or common box-drawing output. */
export function looksLikeTerminalOutput(content: string): boolean {
  return (
    content.includes("\u001b[") ||
    content.includes("\u009b") ||
    content.includes("\r") ||
    content.includes("\b") ||
    /[│┌┐└┘├┤┬┴┼╭╮╯╰═║╔╗╚╝╠╣╦╩╬]/.test(content)
  );
}

function writeChar(line: string[], cursor: number, char: string): number {
  while (line.length < cursor) line.push(" ");
  line[cursor] = char;
  return cursor + 1;
}

/** Apply the cursor operations used by captured terminal output and strip escapes. */
export function normalizeTerminalOutput(content: string): string {
  const lines: string[] = [];
  let currentLine: string[] = [];
  let cursor = 0;

  const commitLine = () => {
    lines.push(currentLine.join(""));
    currentLine = [];
    cursor = 0;
  };

  for (let i = 0; i < content.length; i++) {
    const char = content[i] ?? "";

    if (char === "\u001b" || char === "\u009b") {
      let finalChar = "";
      let params = "";

      if (char === "\u001b" && content[i + 1] === "]") {
        i += 2;
        while (i < content.length) {
          if (content[i] === "\u0007") break;
          if (content[i] === "\u001b" && content[i + 1] === "\\") {
            i += 1;
            break;
          }
          i += 1;
        }
        continue;
      }

      if (char === "\u001b" && content[i + 1] === "[") i += 2;
      else if (char === "\u009b") i += 1;
      else continue;

      for (; i < content.length; i++) {
        const code = content.charCodeAt(i);
        if (code >= 0x40 && code <= 0x7e) {
          finalChar = content[i] ?? "";
          break;
        }
        params += content[i] ?? "";
      }

      const [firstParam = ""] = params.split(";");
      const amount = Number.parseInt(firstParam, 10);
      const count = Number.isFinite(amount) ? amount : 1;

      switch (finalChar) {
        case "C":
          cursor += count;
          break;
        case "D":
          cursor = Math.max(0, cursor - count);
          break;
        case "G":
          cursor = Math.max(0, count - 1);
          break;
        case "K": {
          const mode = Number.isFinite(amount) ? amount : 0;
          if (mode === 0) currentLine.length = cursor;
          else if (mode === 1) {
            for (let j = 0; j <= cursor && j < currentLine.length; j++) currentLine[j] = " ";
          } else if (mode === 2) {
            currentLine = [];
            cursor = 0;
          }
          break;
        }
        case "J":
          if (amount === 2 || amount === 3) {
            lines.length = 0;
            currentLine = [];
            cursor = 0;
          }
          break;
      }
      continue;
    }

    if (char === "\r") cursor = 0;
    else if (char === "\n") commitLine();
    else if (char === "\b") cursor = Math.max(0, cursor - 1);
    else if (char === "\t") {
      const spaces = 4 - (cursor % 4 || 0);
      for (let j = 0; j < spaces; j++) cursor = writeChar(currentLine, cursor, " ");
    } else cursor = writeChar(currentLine, cursor, char);
  }

  if (currentLine.length > 0 || content.endsWith("\n")) lines.push(currentLine.join(""));
  return lines.join("\n");
}
