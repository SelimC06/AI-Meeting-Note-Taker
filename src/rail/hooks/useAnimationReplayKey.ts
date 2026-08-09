import { useCallback, useState } from "react";

// A key-less element only plays a CSS `animation` once, on its original
// mount, not on later re-renders — so replaying an entrance animation (the
// docked pill's .rail-pop-in, the floating rail's own .rail-pop-in) each
// time it (re)appears requires forcing React to remount it. Use the
// returned number as that element's `key`, and call `bump()` whenever the
// animation should replay.
//
// `bump` is memoized (stable identity across renders) so it's safe to put
// in a `useEffect` dependency array — an unmemoized version would change
// identity every render, making an effect that both depends on it and
// calls it re-fire on every render it runs on, not just on the intended
// trigger.
export function useAnimationReplayKey(): [number, () => void] {
    const [generation, setGeneration] = useState(0);
    const bump = useCallback(() => setGeneration((g) => g + 1), []);
    return [generation, bump];
}
