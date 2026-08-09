import { expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAnimationReplayKey } from "./useAnimationReplayKey";

it("starts at 0 and increments by 1 each time bump is called", () => {
  const { result } = renderHook(() => useAnimationReplayKey());
  expect(result.current[0]).toBe(0);

  act(() => result.current[1]());
  expect(result.current[0]).toBe(1);

  act(() => result.current[1]());
  act(() => result.current[1]());
  expect(result.current[0]).toBe(3);
});
