export type ResponsiveAuditOptions = {
  coarsePointer: boolean;
  state: string;
  locale: string;
};

export type ResponsiveAuditFinding = {
  rule: string;
  selector: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  scroll: { width: number; height: number };
  client: { width: number; height: number };
  viewport: { width: number; height: number };
  detail: string;
};

/**
 * Runs inside the tested page. Keep this function self-contained so the real
 * browser DOM, styles, accessibility attributes, and geometry are the seam.
 * Exemptions are deliberately local and reviewable through data-responsive-allow.
 */
export function auditResponsiveDocument(options: ResponsiveAuditOptions) {
  const findings: ResponsiveAuditFinding[] = [];
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const usedExemptions = new Set<string>();
  const exemptionKey = (element: Element, value: string) => `${selector(element)}::${value}`;
  const hasAllowance = (element: Element, value: string) =>
    (element.getAttribute("data-responsive-allow") || "").split(/\s+/u).includes(value);
  const allowance = (element: Element, value: string) => {
    if (!hasAllowance(element, value)) return false;
    usedExemptions.add(exemptionKey(element, value));
    return true;
  };
  const text = (element: Element) =>
    (element.getAttribute("aria-label") || element.textContent || "")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 180);
  const selector = (element: Element) => {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current !== document.body && parts.length < 5) {
      let part = current.localName;
      const slot = current.getAttribute("data-slot");
      if (slot) part += `[data-slot="${CSS.escape(slot)}"]`;
      else {
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(
            (sibling) => sibling.localName === current!.localName,
          );
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  const visible = (element: Element) => {
    const style = getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.clip === "auto" &&
      style.clipPath !== "inset(50%)" &&
      element.getClientRects().length > 0 &&
      !element.closest('[aria-hidden="true"], [inert]')
    );
  };
  const record = (rule: string, element: Element, detail: string) => {
    const box = element.getBoundingClientRect();
    const htmlElement = element as HTMLElement;
    findings.push({
      rule,
      selector: selector(element),
      text: text(element),
      rect: {
        x: Math.round(box.x * 10) / 10,
        y: Math.round(box.y * 10) / 10,
        width: Math.round(box.width * 10) / 10,
        height: Math.round(box.height * 10) / 10,
      },
      scroll: { width: htmlElement.scrollWidth, height: htmlElement.scrollHeight },
      client: { width: htmlElement.clientWidth, height: htmlElement.clientHeight },
      viewport,
      detail,
    });
  };

  const elements = Array.from(document.body.querySelectorAll("*")).filter(visible);
  const horizontalScrollOwner = (element: Element) => {
    const owner = element.closest('[data-responsive-allow~="horizontal-scroll"]');
    if (!owner) return null;
    const ownerStyle = getComputedStyle(owner);
    const ownerElement = owner as HTMLElement;
    if (
      !["auto", "scroll"].includes(ownerStyle.overflowX) ||
      ownerElement.scrollWidth <= ownerElement.clientWidth + 1
    ) {
      return null;
    }
    usedExemptions.add(exemptionKey(owner, "horizontal-scroll"));
    return owner;
  };
  const clippedByLocalAncestor = (element: Element, box: DOMRect) => {
    let ancestor = element.parentElement;
    while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
      const ancestorStyle = getComputedStyle(ancestor);
      if (["hidden", "clip", "auto", "scroll"].includes(ancestorStyle.overflowX)) {
        const clip = ancestor.getBoundingClientRect();
        if (
          clip.left >= -1 &&
          clip.right <= viewport.width + 1 &&
          (box.left < clip.left - 1 || box.right > clip.right + 1)
        ) {
          return true;
        }
      }
      ancestor = ancestor.parentElement;
    }
    return false;
  };

  const knownExemptions = new Set([
    "horizontal-scroll",
    "text-clip",
    "hover-reveal",
    "compact-target",
    "overflow-visible",
    "action-overlap",
    "viewport-escape",
  ]);
  for (const exempted of Array.from(document.querySelectorAll("[data-responsive-allow]"))) {
    const values = (exempted.getAttribute("data-responsive-allow") || "")
      .split(/\s+/u)
      .filter(Boolean);
    for (const value of values) {
      if (!knownExemptions.has(value)) {
        record("invalid-responsive-exemption", exempted, `Unknown responsive exemption: ${value}`);
      }
    }
  }

  for (const element of elements) {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    if (
      box.width > 1 &&
      box.height > 1 &&
      !allowance(element, "viewport-escape") &&
      (((box.left < -1 || box.right > viewport.width + 1) &&
        !horizontalScrollOwner(element) &&
        !clippedByLocalAncestor(element, box)) ||
        (["fixed", "sticky"].includes(style.position) &&
          (box.top < -1 || box.bottom > viewport.height + 1)))
    ) {
      record("viewport-escape", element, "Visible element escapes the viewport");
    }

    const htmlElement = element as HTMLElement;
    const horizontalOverflow = htmlElement.scrollWidth > htmlElement.clientWidth + 1;
    if (horizontalOverflow) {
      const nativeTextEditor =
        element.localName === "textarea" ||
        (element.localName === "input" &&
          ![
            "button",
            "checkbox",
            "color",
            "file",
            "hidden",
            "image",
            "radio",
            "range",
            "reset",
            "submit",
          ].includes((element.getAttribute("type") || "text").toLowerCase()));
      if (nativeTextEditor) continue;
      const overflowVisibleDescendants = Array.from(
        element.querySelectorAll('[data-responsive-allow~="overflow-visible"]'),
      );
      const overflowFromExemptHitArea =
        htmlElement.scrollWidth - htmlElement.clientWidth <= 48 &&
        (hasAllowance(element, "overflow-visible") || overflowVisibleDescendants.length > 0);
      if (overflowFromExemptHitArea) {
        const exempted = hasAllowance(element, "overflow-visible")
          ? element
          : overflowVisibleDescendants[0]!;
        usedExemptions.add(exemptionKey(exempted, "overflow-visible"));
        continue;
      }
      const scrollable = ["auto", "scroll"].includes(style.overflowX);
      if (scrollable && !allowance(element, "horizontal-scroll")) {
        record(
          "unmarked-horizontal-scroll",
          element,
          'Horizontal scrolling requires data-responsive-allow="horizontal-scroll"',
        );
      } else if (!scrollable && style.overflowX !== "visible" && !allowance(element, "text-clip")) {
        record("clipped-content", element, `Content is clipped by overflow-x: ${style.overflowX}`);
      } else if (style.overflowX === "visible" && !allowance(element, "overflow-visible")) {
        record(
          "element-overflow",
          element,
          "Content overflows an element without a scroll contract",
        );
      }
    }
  }

  const actionSelector =
    'button, a[href], input:not([type="hidden"]), textarea, select, [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="slider"]';
  const actions = Array.from(document.querySelectorAll(actionSelector)).filter(visible);
  for (const action of actions) {
    const style = getComputedStyle(action);
    const actionBox = action.getBoundingClientRect();
    let clippedActionAncestor: Element | null = null;
    let clippingAncestor = action.parentElement;
    while (clippingAncestor && clippingAncestor !== document.body) {
      const clippingStyle = getComputedStyle(clippingAncestor);
      if (["hidden", "clip"].includes(clippingStyle.overflowX)) {
        const clip = clippingAncestor.getBoundingClientRect();
        const visibleWidth = Math.max(
          0,
          Math.min(actionBox.right, clip.right) - Math.max(actionBox.left, clip.left),
        );
        if (visibleWidth < actionBox.width * 0.8) {
          clippedActionAncestor = clippingAncestor;
          break;
        }
      }
      clippingAncestor = clippingAncestor.parentElement;
    }
    if (clippedActionAncestor && !horizontalScrollOwner(action)) {
      record(
        "clipped-action",
        action,
        `Core action is clipped by ${selector(clippedActionAncestor)}`,
      );
    }
    const labelledBy = action.getAttribute("aria-labelledby");
    const labelledText = labelledBy
      ? labelledBy
          .split(/\s+/u)
          .map((id) => document.getElementById(id)?.textContent || "")
          .join(" ")
      : "";
    const labels = Array.from((action as HTMLInputElement).labels || [])
      .map((label) => label.textContent || "")
      .join(" ");
    const name =
      action.getAttribute("aria-label") ||
      labelledText ||
      labels ||
      action.textContent ||
      action.getAttribute("title") ||
      action.getAttribute("placeholder") ||
      (action as HTMLInputElement).value;
    if (!name?.trim())
      record("unnamed-control", action, "Actionable control has no accessible name");
    if (
      Number.parseFloat(style.opacity) < 0.1 &&
      style.pointerEvents !== "none" &&
      !allowance(action, "hover-reveal")
    ) {
      record("hover-only-action", action, "Action is transparent until hover/focus");
    }
    if (options.coarsePointer && !allowance(action, "compact-target")) {
      const box = action.getBoundingClientRect();
      const inlineTextLink = action.localName === "a" && style.display === "inline";
      if (!inlineTextLink && (box.width < 43.5 || box.height < 43.5)) {
        record("coarse-target", action, "Coarse-pointer target must be at least 44×44 CSS px");
      }
    }
  }

  for (const dialog of Array.from(
    document.querySelectorAll(
      '[role="dialog"], [data-slot="dialog-content"], [data-slot="sheet-content"]',
    ),
  ).filter(visible)) {
    const box = dialog.getBoundingClientRect();
    if (
      box.left < -1 ||
      box.top < -1 ||
      box.right > viewport.width + 1 ||
      box.bottom > viewport.height + 1
    ) {
      record("overlay-viewport", dialog, "Dialog or sheet is outside the viewport");
    }
    if (
      (dialog as HTMLElement).scrollHeight > (dialog as HTMLElement).clientHeight + 1 &&
      getComputedStyle(dialog).overflowY === "visible"
    ) {
      record("overlay-clipping", dialog, "Tall dialog needs bounded internal scrolling");
    }
  }

  // Only report overlap when both controls are substantially covered and the
  // overlap point actually paints one action over the other. This avoids noisy
  // reports for adjacent fractional-pixel borders and intentionally inert modal backgrounds.
  for (let index = 0; index < actions.length; index += 1) {
    const first = actions[index]!;
    const a = first.getBoundingClientRect();
    if (a.width < 1 || a.height < 1) continue;
    for (let otherIndex = index + 1; otherIndex < actions.length; otherIndex += 1) {
      const second = actions[otherIndex]!;
      if (first.contains(second) || second.contains(first) || allowance(first, "action-overlap"))
        continue;
      const b = second.getBoundingClientRect();
      const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (width <= 2 || height <= 2) continue;
      const overlapArea = width * height;
      if (overlapArea < Math.min(a.width * a.height, b.width * b.height) * 0.2) continue;
      const x = Math.max(a.left, b.left) + width / 2;
      const y = Math.max(a.top, b.top) + height / 2;
      const painted = document.elementsFromPoint(x, y);
      const paintsFirst = painted.some((element) => first === element || first.contains(element));
      const paintsSecond = painted.some(
        (element) => second === element || second.contains(element),
      );
      if (paintsFirst && paintsSecond) {
        record("action-overlap", first, `Overlaps ${selector(second)}`);
      }
    }
  }

  return {
    state: options.state,
    locale: options.locale,
    viewport,
    root: {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    },
    exemptions: Array.from(document.querySelectorAll("[data-responsive-allow]")).flatMap(
      (element) =>
        (element.getAttribute("data-responsive-allow") || "")
          .split(/\s+/u)
          .filter(Boolean)
          .map((value) => ({
            selector: selector(element),
            value,
            used: usedExemptions.has(exemptionKey(element, value)),
          })),
    ),
    findings,
  };
}

export function responsiveAuditExpression(options: ResponsiveAuditOptions) {
  return `(${auditResponsiveDocument.toString()})(${JSON.stringify(options)})`;
}
