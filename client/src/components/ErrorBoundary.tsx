import { Component, type ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageTitle } from "@/components/ui/page-header";
import { AlertTriangle, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  showDetails: boolean;
  isChunkError: boolean;
}

const CHUNK_RELOAD_KEY = "chunk_reload_attempted";
const CHUNK_RELOAD_EXPIRY_MS = 60_000;

function isChunkLoadError(error: Error): boolean {
  return (
    error.name === "ChunkLoadError" ||
    /loading chunk \d+ failed/i.test(error.message) ||
    /failed to fetch dynamically imported module/i.test(error.message) ||
    /importing a module script failed/i.test(error.message)
  );
}

type GuardStatus =
  | { ok: true; isRecent: true }
  | { ok: true; isRecent: false }
  | { ok: false };

function readReloadGuard(): GuardStatus {
  if (typeof window === "undefined") return { ok: false };
  try {
    const raw = sessionStorage.getItem(CHUNK_RELOAD_KEY);
    if (!raw) return { ok: true, isRecent: false };
    const parsed = JSON.parse(raw) as { attemptedAt?: unknown };
    if (typeof parsed.attemptedAt !== "number") return { ok: true, isRecent: false };
    const isRecent = Date.now() - parsed.attemptedAt < CHUNK_RELOAD_EXPIRY_MS;
    return { ok: true, isRecent };
  } catch {
    return { ok: false };
  }
}

function writeReloadGuard(): boolean {
  if (typeof window === "undefined") return false;
  try {
    sessionStorage.setItem(CHUNK_RELOAD_KEY, JSON.stringify({ attemptedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

function clearReloadGuard(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(CHUNK_RELOAD_KEY);
  } catch {
  }
}

export class ErrorBoundary extends Component<Props, State> {
  private _swMessageHandler: ((evt: MessageEvent) => void) | null = null;

  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, showDetails: false, isChunkError: false };
  }

  static getDerivedStateFromError(error: Error): Omit<State, "showDetails"> {
    return { hasError: true, error, isChunkError: isChunkLoadError(error) };
  }

  componentDidMount() {
    if (!this.state.hasError) {
      clearReloadGuard();
    }
    // Listen for the service worker's CHUNK_NOT_FOUND message so an already-open
    // tab can recover once (bounded) when the SW detects a missing hashed asset.
    if (typeof navigator !== "undefined" && navigator.serviceWorker) {
      this._swMessageHandler = (evt: MessageEvent) => {
        if (evt.data?.type === "CHUNK_NOT_FOUND" && !this.state.hasError) {
          const guard = readReloadGuard();
          if (!guard.ok || guard.isRecent) return;
          const wrote = writeReloadGuard();
          if (!wrote) return;
          console.info("[ErrorBoundary] SW signalled missing chunk — reloading once");
          window.location.reload();
        }
      };
      navigator.serviceWorker.addEventListener("message", this._swMessageHandler);
    }
  }

  componentWillUnmount() {
    if (this._swMessageHandler && typeof navigator !== "undefined" && navigator.serviceWorker) {
      navigator.serviceWorker.removeEventListener("message", this._swMessageHandler);
    }
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error("ErrorBoundary caught an error:", error, info);

    if (!isChunkLoadError(error)) return;

    const guard = readReloadGuard();

    if (!guard.ok) return;

    if (guard.isRecent) {
      // Already tried reloading — show the persistent error screen so the user
      // isn't trapped in an infinite reload loop.
      return;
    }

    const wrote = writeReloadGuard();
    if (!wrote) return;

    if (typeof window !== "undefined") {
      window.location.reload();
    }
  }

  handleReload = () => {
    clearReloadGuard();
    window.location.reload();
  };

  toggleDetails = () => {
    this.setState((prev) => ({ showDetails: !prev.showDetails }));
  };

  render() {
    if (this.state.hasError) {
      const { error, showDetails, isChunkError } = this.state;
      return (
        <div className="min-h-screen flex items-center justify-center bg-background p-4" data-testid="error-boundary-fallback">
          <Card className="max-w-md w-full">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
                <AlertTriangle className="w-8 h-8 text-destructive" />
              </div>
              <PageTitle className="text-xl font-semibold text-foreground mb-2" data-testid="text-error-boundary-title">
                {isChunkError ? "Page failed to load" : "Something went wrong"}
              </PageTitle>
              <p className="text-sm text-muted-foreground mb-2" data-testid="text-error-boundary-message">
                {isChunkError
                  ? "A page chunk could not be loaded. This can happen after a deployment. Reloading will fix it."
                  : "An unexpected error occurred. You can try reloading the page or report this issue so we can look into it."}
              </p>
              <p className="text-xs text-muted-foreground mb-6 font-mono">
                Liberty Bancard
              </p>
              <div className="flex flex-col sm:flex-row gap-3 mb-4">
                <Button onClick={this.handleReload} className="gap-2" data-testid="button-reload-page">
                  <RefreshCw className="w-4 h-4" />
                  Reload page
                </Button>
                {!isChunkError && (
                  <Button
                    variant="outline"
                    asChild
                    data-testid="link-report-issue"
                  >
                    <a href="mailto:support@libertybancard.com?subject=App%20Error%20Report">
                      Report Issue
                    </a>
                  </Button>
                )}
              </div>
              {!isChunkError && error?.message && (
                <div className="w-full text-left">
                  <button
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mx-auto"
                    onClick={this.toggleDetails}
                    data-testid="button-toggle-error-details"
                  >
                    {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    {showDetails ? "Hide" : "Show"} error details
                  </button>
                  {showDetails && (
                    <pre
                      className="mt-2 p-3 bg-muted rounded text-xs text-muted-foreground overflow-auto max-h-32 text-left w-full"
                      data-testid="text-error-details"
                    >
                      {error.message}
                    </pre>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
