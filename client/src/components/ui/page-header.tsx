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

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  testId?: string;
  /** Use 2 when the page is embedded under another page's h1 (for example inside the Administration hub). */
  headingLevel?: 1 | 2;
}

export function PageHeader({ title, subtitle, actions, testId, headingLevel }: PageHeaderProps) {
  const Heading = useHeadingLevel(headingLevel) === 2 ? "h2" : "h1";
  return (
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4" data-testid={testId}>
      <div className="min-w-0">
        <Heading className="text-2xl font-bold text-foreground truncate" data-testid="text-page-heading">
          {title}
        </Heading>
        {subtitle && (
          <p className="text-sm text-muted-foreground mt-0.5">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-2 flex-wrap shrink-0">
          {actions}
        </div>
      )}
    </div>
  );
}
