/** Parse a bounded CSV preview, including quoted separators and line breaks. */
export function csvPreview(text: string, limit = 500): { rows: string[][]; truncated: boolean } {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const separator = firstLine.includes(",") ? "," : firstLine.includes(";") ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && char === separator) {
      row.push(cell);
      cell = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (char === "\r" && text[i + 1] === "\n") i++;
      if (rows.length === limit) return { rows, truncated: i < text.length - 1 };
    } else cell += char;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return { rows, truncated: false };
}
