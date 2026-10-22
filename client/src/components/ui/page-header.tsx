import { createContext, createElement, useCallback, useContext, useLayoutEffect, useState, type HTMLAttributes, type ReactNode } from "react";

/** Hubs that already own the page h1 wrap their children in <PageHeadingLevel level={2}>. */
const HeadingLevelContext = createContext<1 | 2>(1);
export function PageHeadingLevel({ level, children }: { level: 1 | 2; children: ReactNode }) {
  return <HeadingLevelContext.Provider value={level}>{children}</HeadingLevelContext.Provider>;
}

/**
 * Heading ownership. Exactly one mounted composition owns the page h1:
 *  - a page (or hub header) that renders at level 1 claims it, and
 *  - the employee shell title is only the fallback h1; it renders as plain text while a claim exists.
 * Embedded children sit under <PageHeadingLevel level={2}> and render h2, so they never claim.
 */
const HeadingClaimContext = createContext<((delta: 1 | -1) => void) | null>(null);
const HeadingClaimedContext = createContext(false);
export function PageHeadingOwnerProvider({ children }: { children: ReactNode }) {
  const [claims, setClaims] = useState(0);
  const adjust = useCallback((delta: 1 | -1) => setClaims(n => Math.max(0, n + delta)), []);
  return (
    <HeadingClaimContext.Provider value={adjust}>
      <HeadingClaimedContext.Provider value={claims > 0}>{children}</HeadingClaimedContext.Provider>
    </HeadingClaimContext.Provider>
  );
}
/** True while a mounted page or hub owns the h1, so the shell must not render another. */
export function usePageHeadingClaimed() { return useContext(HeadingClaimedContext); }

/** The employee shell title: the page's fallback h1 only while no mounted page or hub has claimed it. */
export function ShellPageTitle({ label, className }: { label: string; className?: string }) {
  const claimed = usePageHeadingClaimed();
  return claimed
    ? createElement("div", { className, "data-testid": "text-page-title", "aria-label": label }, label)
    : createElement("h1", { className, "data-testid": "text-page-title" }, label);
}

/** Resolves the heading level for this position in the tree and registers an h1 claim when it is level 1. */
export function useHeadingLevel(override?: 1 | 2): 1 | 2 {
  const inherited = useContext(HeadingLevelContext);
  const adjust = useContext(HeadingClaimContext);
  const level = override ?? inherited;
  useLayoutEffect(() => {
    if (level !== 1 || !adjust) return;
    adjust(1);
    return () => adjust(-1);
  }, [level, adjust]);
  return level;
}

/** A page title: h1 when this composition owns the page heading, h2 when embedded under another owner. */
export function PageTitle({ level, ...props }: HTMLAttributes<HTMLHeadingElement> & { level?: 1 | 2; "data-testid"?: string }) {
  const resolved = useHeadingLevel(level);
  return createElement(resolved === 2 ? "h2" : "h1", props);
}
