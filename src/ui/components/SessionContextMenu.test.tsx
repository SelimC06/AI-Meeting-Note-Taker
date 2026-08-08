import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

it("trash view: delete forever requires confirmation before calling onDeleteForever", () => {
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
    />
  );

  expect(screen.queryByText("[rename]")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("[delete forever]"));
  expect(onDeleteForever).not.toHaveBeenCalled();
  expect(screen.getByText("delete forever?")).toBeInTheDocument();

  fireEvent.click(screen.getByText("[confirm]"));
  expect(onDeleteForever).toHaveBeenCalledWith(trashedSession);
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
      />
    </div>
  );

  fireEvent.mouseDown(screen.getByTestId("outside"));
  expect(onClose).toHaveBeenCalledTimes(1);

  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(2);
});
