import { expect, it } from "vitest";
import { render } from "@testing-library/react";
import LevelMeter from "./LevelMeter";

it("renders one bar per level", () => {
  const { container } = render(<LevelMeter levels={[0, 0.5, 1]} active={false} />);
  expect(container.querySelectorAll("span")).toHaveLength(3);
});

it("scales each bar's height with its level", () => {
  const { container } = render(<LevelMeter levels={[0, 1]} active={true} />);
  const bars = container.querySelectorAll("span");
  const lowHeight = (bars[0] as HTMLElement).style.height;
  const highHeight = (bars[1] as HTMLElement).style.height;
  expect(parseFloat(highHeight)).toBeGreaterThan(parseFloat(lowHeight));
});

it("uses the signal color when active and the dim line color when inactive", () => {
  const { container: activeContainer } = render(<LevelMeter levels={[0.5]} active={true} />);
  const { container: idleContainer } = render(<LevelMeter levels={[0.5]} active={false} />);
  expect(activeContainer.querySelector("span")?.className).toContain("bg-signal");
  expect(idleContainer.querySelector("span")?.className).toContain("bg-line");
});
