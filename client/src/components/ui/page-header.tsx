import { createContext, ReactNode, useContext } from "react";

/** Hubs that already own the page h1 wrap their children in <PageHeadingLevel level={2}>. */
const HeadingLevelContext = createContext<1 | 2>(1);
export function PageHeadingLevel({ level, children }: { level: 1 | 2; children: ReactNode }) {
  return <HeadingLevelContext.Provider value={level}>{children}</HeadingLevelContext.Provider>;
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
  const inherited = useContext(HeadingLevelContext);
  const Heading = (headingLevel ?? inherited) === 2 ? "h2" : "h1";
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
