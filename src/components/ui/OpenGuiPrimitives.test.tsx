// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { BaseDialog } from "./base-dialog";
import { ButtonGroup } from "./ButtonGroup";
import { FormField } from "./FormField";
import { ToggleSwitch } from "./ToggleSwitch";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(cleanup);

describe("OpenGUI UI primitives", () => {
  test("BaseDialog exposes its labelled content and optional regions", () => {
    render(
      <BaseDialog
        open
        onOpenChange={() => {}}
        title="Connection"
        description="Choose a Host"
        footer={<button type="button">Save</button>}
      >
        <p>Host settings</p>
      </BaseDialog>,
    );

    expect(screen.getByRole("dialog", { name: "Connection" })).toBeTruthy();
    expect(screen.getByText("Choose a Host")).toBeTruthy();
    expect(screen.getByText("Host settings")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  test("ButtonGroup preserves DOM props and stretches children only when requested", () => {
    const { rerender } = render(
      <ButtonGroup aria-label="Actions">
        <button type="button">One</button>
      </ButtonGroup>,
    );
    const group = screen.getByLabelText("Actions");
    expect(group.dataset.slot).toBe("button-group");
    expect(group.className).not.toContain("[&>*]:flex-1");

    rerender(
      <ButtonGroup aria-label="Actions" stretch>
        <button type="button">One</button>
      </ButtonGroup>,
    );
    expect(group.className).toContain("[&>*]:flex-1");
  });

  test("FormField associates its label and renders supporting text", () => {
    render(
      <FormField label="Name" htmlFor="name" description="Shown to teammates">
        <input id="name" />
      </FormField>,
    );

    expect(screen.getByRole("textbox", { name: "Name" })).toBeTruthy();
    expect(screen.getByText("Shown to teammates")).toBeTruthy();
  });

  test("ToggleSwitch reports the native checked state and honors disabled", async () => {
    const onCheckedChange = vi.fn();
    const { rerender } = render(
      <ToggleSwitch checked={false} onCheckedChange={onCheckedChange} label="Share Session" />,
    );
    await userEvent.click(screen.getByRole("checkbox", { name: "Share Session" }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);

    rerender(
      <ToggleSwitch
        checked={false}
        disabled
        onCheckedChange={onCheckedChange}
        label="Share Session"
      />,
    );
    await userEvent.click(screen.getByRole("checkbox", { name: "Share Session" }));
    expect(onCheckedChange).toHaveBeenCalledTimes(1);
  });
});
