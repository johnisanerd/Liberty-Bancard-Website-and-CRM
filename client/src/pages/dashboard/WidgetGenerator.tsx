import { PageTitle } from "@/components/ui/page-header";
import { useState, useRef, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Copy, Check, Code2, Eye, Info, ExternalLink, Sun, Moon, RefreshCw } from "lucide-react";

function IframePreview({ refCode, theme }: { refCode: string; theme: "light" | "dark" }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [key, setKey] = useState(0);

  useEffect(() => {
    setKey(k => k + 1);
  }, [refCode, theme]);

  const previewUrl = `/widget/preview?ref=${encodeURIComponent(refCode)}&theme=${theme}`;

  return (
    <div className="relative">
      <iframe
        key={key}
        ref={iframeRef}
        src={previewUrl}
        title="Widget Preview"
        data-testid="iframe-widget-preview"
        className="w-full border-0 rounded-lg"
        style={{ height: 420 }}
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
      />
      <button
        onClick={() => setKey(k => k + 1)}
        className="absolute top-2 right-2 p-1.5 rounded bg-background/80 border border-border hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        aria-label="Refresh preview"
        data-testid="button-refresh-preview"
        title="Refresh preview"
      >
        <RefreshCw className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

export default function WidgetGenerator() {
  const { toast } = useToast();
  const [refCode, setRefCode] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [copied, setCopied] = useState(false);

  const domain = typeof window !== "undefined" ? window.location.origin : "https://libertybancard.com";

  const embedSnippet = `<div id="lb-widget"></div>
<script src="${domain}/widget/savings-calculator.js" data-ref="${refCode || "YOUR_CODE"}" data-theme="${theme}"><\/script>`;

  const copySnippet = () => {
    navigator.clipboard.writeText(embedSnippet).then(() => {
      setCopied(true);
      toast({ title: "Embed snippet copied!", description: "Paste it into your website's HTML." });
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <PageTitle className="text-2xl font-bold text-foreground">Widget Generator</PageTitle>
        <p className="text-muted-foreground mt-1">
          Generate an embeddable savings calculator widget for partner websites. Partners paste one script tag and the widget appears automatically.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Widget Configuration</CardTitle>
              <CardDescription>Set the partner's referral code and visual theme.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="ref-code">Partner Referral Code</Label>
                <Input
                  id="ref-code"
                  placeholder="e.g. JOHN_CPA_2024"
                  value={refCode}
                  onChange={e => setRefCode(e.target.value.toUpperCase().replace(/\s+/g, "_"))}
                  data-testid="input-ref-code"
                />
                <p className="text-xs text-muted-foreground">
                  The code that tracks referrals back to this partner. Leave blank to use the generic embed.
                </p>
              </div>

              <div className="space-y-2">
                <Label>Theme</Label>
                <div className="flex gap-3">
                  <button
                    onClick={() => setTheme("light")}
                    data-testid="button-theme-light"
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                      theme === "light"
                        ? "border-primary bg-primary/5 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/50"
                    }`}
                  >
                    <Sun className="w-4 h-4" /> Light
                  </button>
                  <button
                    onClick={() => setTheme("dark")}
                    data-testid="button-theme-dark"
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                      theme === "dark"
                        ? "border-primary bg-primary/5 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/50"
                    }`}
                  >
                    <Moon className="w-4 h-4" /> Dark
                  </button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Code2 className="w-4 h-4" /> Embed Snippet
              </CardTitle>
              <CardDescription>Partners paste this into their website HTML.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="relative">
                <pre
                  data-testid="code-embed-snippet"
                  className="bg-muted rounded-lg p-4 text-xs font-mono text-foreground overflow-x-auto whitespace-pre-wrap break-all leading-relaxed"
                >
                  {embedSnippet}
                </pre>
              </div>
              <Button
                onClick={copySnippet}
                className="w-full gap-2"
                data-testid="button-copy-snippet"
              >
                {copied ? (
                  <>
                    <Check className="w-4 h-4" /> Copied!
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4" /> Copy Embed Snippet
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          <Card className="border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-900">
            <CardContent className="pt-4">
              <div className="flex items-start gap-3">
                <Info className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-blue-900 dark:text-blue-200">How it works</p>
                  <ul className="text-xs text-blue-800 dark:text-blue-300 space-y-1 list-disc list-inside">
                    <li>Widget renders on any website via a single script tag</li>
                    <li>No React or external dependencies required</li>
                    <li>CTA button links to <code className="font-mono">/upload-statement</code> with partner's referral code</li>
                    <li>UTM params auto-track every lead back to the embed</li>
                    <li>Works at any width from 300px to 600px</li>
                    <li>Preview below loads the actual widget script — what you see is exactly what partners get</li>
                  </ul>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Eye className="w-4 h-4" /> Live Preview
              </CardTitle>
              <CardDescription>
                Rendered from the real widget script — exactly what visitors on the partner's site will see.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-3">
              <IframePreview refCode={refCode} theme={theme} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Partner Instructions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Send your partner to the instructions page for step-by-step installation guidance.
              </p>
              <a href="/partners/embed-widget" target="_blank" rel="noopener noreferrer">
                <Button variant="outline" className="gap-2 w-full" data-testid="button-view-instructions">
                  <ExternalLink className="w-4 h-4" /> View Partner Instructions Page
                </Button>
              </a>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
