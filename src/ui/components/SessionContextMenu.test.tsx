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
