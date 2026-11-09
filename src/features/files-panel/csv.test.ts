import { expect, test } from "vite-plus/test";
import { csvPreview } from "./csv";

test("CSV previews preserve quoted commas, escaped quotes, CRLF and embedded newlines", () => {
  expect(csvPreview('Name,Note\r\n"Müller, A.","a\n""quote"""\r\n')).toEqual({
    rows: [
      ["Name", "Note"],
      ["Müller, A.", 'a\n"quote"'],
    ],
    truncated: false,
  });
  expect(csvPreview("Name;Ort\nAna;Berlin").rows).toEqual([
    ["Name", "Ort"],
    ["Ana", "Berlin"],
  ]);
});

test("CSV preview bounds rendered rows", () => {
  expect(csvPreview("a,b\n1,2\n3,4", 2)).toEqual({
    rows: [
      ["a", "b"],
      ["1", "2"],
    ],
    truncated: true,
  });
});
