import { describe, expect, test } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DropdownMenu,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "./dropdown-menu";

describe("DropdownMenuLabel", () => {
  test("renders inside the radio group that it labels", () => {
    expect(() =>
      renderToStaticMarkup(
        <DropdownMenu>
          <DropdownMenuRadioGroup value="medium">
            <DropdownMenuLabel>Reasoning effort</DropdownMenuLabel>
            <DropdownMenuRadioItem value="medium">Medium</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenu>,
      ),
    ).not.toThrow();
  });
});
