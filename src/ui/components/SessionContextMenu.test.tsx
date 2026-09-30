import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SessionContextMenu from "./SessionContextMenu";
import type { Session } from "../api";

const session: Session = {
  id: "a1",
  created_at: "2026-08-01T00:00:00Z",
  title: "Sprint Planning",
  notes: "notes",
  video_path: "x",
  trashed_at: null,
};

const trashedSession: Session = { ...session, id: "t1", trashed_at: "2026-08-02T00:00:00Z" };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("active view: shows notes/export/rename/trash and calls callbacks", () => {
  const onOpenNotes = vi.fn();
  const onRename = vi.fn();
  const onTrash = vi.fn();
  render(
    <SessionContextMenu
      session={session}
      view="active"
      x={10}
      y={10}
      onClose={() => {}}
      onOpenNotes={onOpenNotes}
      onRename={onRename}
      onTrash={onTrash}
      onRestore={() => {}}
      onDeleteForever={() => {}}
      onExportError={() => {}}
    />
  );

  fireEvent.click(screen.getByText("[notes]"));
  expect(onOpenNotes).toHaveBeenCalledWith(session);

  fireEvent.click(screen.getByText("[rename]"));
  expect(onRename).toHaveBeenCalledWith(session);

  fireEvent.click(screen.getByText("[trash]"));
  expect(onTrash).toHaveBeenCalledWith(session);

  expect(screen.queryByText("[restore]")).not.toBeInTheDocument();
});

it("trash view: shows restore, and delete forever requires confirmation before calling onDeleteForever", () => {
  const onRestore = vi.fn();
  const onDeleteForever = vi.fn();
  render(
    <SessionContextMenu
      session={trashedSession}
      view="trash"
      x={10}
      y={10}
      onClose={() => {}}
      onOpenNotes={() => {}}
      onRename={() => {}}
      onTrash={() => {}}
      onRestore={onRestore}
      onDeleteForever={onDeleteForever}
      onExportError={() => {}}
    />
  );

  expect(screen.queryByText("[rename]")).not.toBeInTheDocument();
  expect(screen.queryByText("[trash]")).not.toBeInTheDocument();

  fireEvent.click(screen.getByText("[restore]"));
  expect(onRestore).toHaveBeenCalledWith(trashedSession);

  fireEvent.click(screen.getByText("[delete forever]"));
  expect(onDeleteForever).not.toHaveBeenCalled();
  expect(screen.getByText("delete forever?")).toBeInTheDocument();

  fireEvent.click(screen.getByText("[confirm]"));
  expect(onDeleteForever).toHaveBeenCalledWith(trashedSession);
});

it("trash view: delete-forever confirmation can be cancelled", () => {
  const onDeleteForever = vi.fn();
  render(
    <SessionContextMenu
      session={trashedSession}
      view="trash"
      x={10}
      y={10}
      onClose={() => {}}
      onOpenNotes={() => {}}
      onRename={() => {}}
      onTrash={() => {}}
      onRestore={() => {}}
      onDeleteForever={onDeleteForever}
      onExportError={() => {}}
    />
  );

  fireEvent.click(screen.getByText("[delete forever]"));
  fireEvent.click(screen.getByText("[cancel]"));

  expect(onDeleteForever).not.toHaveBeenCalled();
  expect(screen.getByText("[delete forever]")).toBeInTheDocument();
});

it("export notes: fetches the URL, closes the menu, and downloads the response as a blob", async () => {
  const onClose = vi.fn();
  const onExportError = vi.fn();
  const blob = new Blob(["# notes"], { type: "text/markdown" });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "Content-Disposition": 'attachment; filename="sprint-planning.md"' }),
      blob: () => Promise.resolve(blob),
    })
  );
  vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:fake"), revokeObjectURL: vi.fn() });

  render(
    <SessionContextMenu
      session={session}
      view="active"
      x={10}
      y={10}
      onClose={onClose}
      onOpenNotes={() => {}}
      onRename={() => {}}
      onTrash={() => {}}
      onRestore={() => {}}
      onDeleteForever={() => {}}
      onExportError={onExportError}
    />
  );

  fireEvent.click(screen.getByText("[export notes]"));
  await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledWith(blob));

  expect(onClose).toHaveBeenCalled();
  expect(onExportError).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it("export recording: surfaces a backend-offline error and does not close prematurely on failure", async () => {
  const onExportError = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

  render(
    <SessionContextMenu
      session={session}
      view="active"
      x={10}
      y={10}
      onClose={() => {}}
      onOpenNotes={() => {}}
      onRename={() => {}}
      onTrash={() => {}}
      onRestore={() => {}}
      onDeleteForever={() => {}}
      onExportError={onExportError}
    />
  );

  fireEvent.click(screen.getByText("[export recording]"));
  await waitFor(() =>
    expect(onExportError).toHaveBeenCalledWith("Couldn't export recording — backend offline")
  );
  vi.unstubAllGlobals();
});

it("export notes: surfaces an HTTP error status", async () => {
  const onExportError = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

  render(
    <SessionContextMenu
      session={session}
      view="active"
      x={10}
      y={10}
      onClose={() => {}}
      onOpenNotes={() => {}}
      onRename={() => {}}
      onTrash={() => {}}
      onRestore={() => {}}
      onDeleteForever={() => {}}
      onExportError={onExportError}
    />
  );

  fireEvent.click(screen.getByText("[export notes]"));
  await waitFor(() =>
    expect(onExportError).toHaveBeenCalledWith("Couldn't export notes — request failed: 404")
  );
  vi.unstubAllGlobals();
});

it("closes on outside click and on Escape", () => {
  const onClose = vi.fn();
  render(
    <div>
      <div data-testid="outside">outside</div>
      <SessionContextMenu
        session={session}
        view="active"
        x={10}
        y={10}
        onClose={onClose}
        onOpenNotes={() => {}}
        onRename={() => {}}
        onTrash={() => {}}
        onRestore={() => {}}
        onDeleteForever={() => {}}
        onExportError={() => {}}
      />
    </div>
  );

  fireEvent.mouseDown(screen.getByTestId("outside"));
  expect(onClose).toHaveBeenCalledTimes(1);

  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(2);
});

// ---------- menu semantics & keyboard ----------

function renderMenu(view: "active" | "trash", overrides: Partial<Parameters<typeof SessionContextMenu>[0]> = {}) {
  const props = {
    session: view === "active" ? session : trashedSession,
    view,
    x: 10,
    y: 10,
    onClose: vi.fn(),
    onOpenNotes: vi.fn(),
    onRename: vi.fn(),
    onTrash: vi.fn(),
    onRestore: vi.fn(),
    onDeleteForever: vi.fn(),
    onExportError: vi.fn(),
    ...overrides,
  };
  render(<SessionContextMenu {...props} />);
  return props;
}

it("is a labelled menu of menuitems, with focus on the first item when it opens", () => {
  renderMenu("active");
  expect(screen.getByRole("menu", { name: "Actions for Sprint Planning" })).toBeInTheDocument();
  const items = screen.getAllByRole("menuitem");
  expect(items.map((i) => i.textContent)).toEqual([
    "[notes]", "[export notes]", "[export recording]", "[rename]", "[trash]",
  ]);
  expect(items[0]).toHaveFocus();
});

it("arrow keys move between items (wrapping), Home/End jump to the ends", () => {
  renderMenu("active");
  const menu = screen.getByRole("menu");
  const items = screen.getAllByRole("menuitem");

  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(items[1]).toHaveFocus();
  fireEvent.keyDown(menu, { key: "End" });
  expect(items[4]).toHaveFocus();
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(items[0]).toHaveFocus();
  fireEvent.keyDown(menu, { key: "ArrowUp" });
  expect(items[4]).toHaveFocus();
  fireEvent.keyDown(menu, { key: "Home" });
  expect(items[0]).toHaveFocus();
});

it("Enter on a focused item activates it (real buttons)", () => {
  const props = renderMenu("active");
  const menu = screen.getByRole("menu");
  fireEvent.keyDown(menu, { key: "End" });
  fireEvent.click(document.activeElement!);
  expect(props.onTrash).toHaveBeenCalledWith(session);
});

it("Escape and Tab both close the menu", () => {
  const props = renderMenu("active");
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
  expect(props.onClose).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(props.onClose).toHaveBeenCalledTimes(2);
});

it("the delete-forever confirm step keeps focus in the menu, on [cancel]", () => {
  const props = renderMenu("trash");
  fireEvent.click(screen.getByRole("menuitem", { name: "[delete forever]" }));
  expect(screen.getByRole("menuitem", { name: "[cancel]" })).toHaveFocus();
  expect(screen.getByRole("group", { name: "delete forever?" })).toBeInTheDocument();

  fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
  expect(screen.getByRole("menuitem", { name: "[confirm]" })).toHaveFocus();
  fireEvent.click(document.activeElement!);
  expect(props.onDeleteForever).toHaveBeenCalledWith(trashedSession);
});

it("a click on a row's actions button doesn't count as an outside click", () => {
  const trigger = document.createElement("button");
  trigger.setAttribute("data-session-menu-trigger", "");
  document.body.appendChild(trigger);
  try {
    const props = renderMenu("active");
    fireEvent.mouseDown(trigger);
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  } finally {
    trigger.remove();
  }
});

it("leaves Escape to a dialog that's open on top of the menu", async () => {
  const { useDialog } = await import("../hooks/useDialog");
  function Dialog({ onEscape }: { onEscape: () => void }) {
    const { dialogProps, titleId } = useDialog({ onEscape });
    return (
      <div {...dialogProps}>
        <h2 id={titleId}>Consent</h2>
        <button>ok</button>
      </div>
    );
  }
  const onDialogEscape = vi.fn();
  const props = renderMenu("active");
  render(<Dialog onEscape={onDialogEscape} />);

  fireEvent.keyDown(document.activeElement!, { key: "Escape" });

  expect(onDialogEscape).toHaveBeenCalledTimes(1);
  expect(props.onClose).not.toHaveBeenCalled();
});
