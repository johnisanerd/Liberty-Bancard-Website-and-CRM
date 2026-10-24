import { useState } from "react";
import { Button } from "@/components/ui/button";

export interface FinalMessagePreview {
  channel: "email" | "sms";
  subject: string | null;
  html: string;
  text: string;
  htmlImagesOff: string;
  sender: { mode: string; address: string | null; name: string | null; note: string };
  replyTo: { mode: string; address: string | null; note: string };
  transport: { name: string; payloadFields: string[]; textTransmitted: boolean; note: string };
  logoCount: number;
  signaturePresent: boolean;
  signatureCount: number;
  footerCount: number;
  footer: { state: "applied" | "unavailable"; reason?: string };
  note: string;
}

type Device = "desktop" | "mobile";

const DARK_STYLE = { filter: "invert(1) hue-rotate(180deg)" } as const;

/**
 * The final email as the send path assembles it: footer, plain-text part, sender facts, plus device, dark-mode and
 * images-off views. The dark view approximates a mail client's automatic inversion; it is not a client render.
 */
export function FinalEmailPreview({ final }: { final: FinalMessagePreview }) {
  const [device, setDevice] = useState<Device>("desktop");
  const [dark, setDark] = useState(false);
  const [imagesOff, setImagesOff] = useState(false);
  const [plain, setPlain] = useState(false);
  const toggle = (on: boolean) => (on ? "default" : "outline");

  return (
    <div className="space-y-2 min-w-0" data-testid="final-email-preview">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Preview views">
        <Button type="button" size="sm" variant={toggle(device === "desktop")} className="min-h-11" aria-pressed={device === "desktop"} onClick={() => setDevice("desktop")} data-testid="view-desktop">Desktop</Button>
        <Button type="button" size="sm" variant={toggle(device === "mobile")} className="min-h-11" aria-pressed={device === "mobile"} onClick={() => setDevice("mobile")} data-testid="view-mobile">Mobile</Button>
        <Button type="button" size="sm" variant={toggle(dark)} className="min-h-11" aria-pressed={dark} onClick={() => setDark((v) => !v)} data-testid="view-dark">Dark</Button>
        <Button type="button" size="sm" variant={toggle(imagesOff)} className="min-h-11" aria-pressed={imagesOff} onClick={() => setImagesOff((v) => !v)} data-testid="view-images-off">Images off</Button>
        <Button type="button" size="sm" variant={toggle(plain)} className="min-h-11" aria-pressed={plain} onClick={() => setPlain((v) => !v)} data-testid="view-plain-text">Plain text</Button>
      </div>

      {plain && (
        <p className="text-xs text-muted-foreground" data-testid="final-plain-text-label">
          {final.transport.textTransmitted ? "Plain-text part sent with the message." : "Reference text generated from the HTML. It is not sent as a separate part; the provider call carries HTML only."}
        </p>
      )}
      {plain ? (
        <pre className="whitespace-pre-wrap break-words text-sm rounded-md border p-3 max-h-80 overflow-auto" data-testid="final-plain-text">{final.text || "Plain-text part unavailable."}</pre>
      ) : (
        <div className="overflow-x-auto rounded-md border bg-white">
          <iframe
            title="Final email preview"
            sandbox=""
            srcDoc={imagesOff ? final.htmlImagesOff : final.html}
            style={{ width: device === "mobile" ? 375 : "100%", maxWidth: "100%", ...(dark ? DARK_STYLE : {}) }}
            className="h-80 bg-white"
            data-testid="final-html-frame"
          />
        </div>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs" data-testid="final-facts">
        <dt className="font-medium">Sender</dt><dd className="min-w-0 break-words">{final.sender.address ? `${final.sender.name ? `${final.sender.name} ` : ""}<${final.sender.address}>` : "Unknown. "}{final.sender.address ? "" : final.sender.note}</dd>
        <dt className="font-medium">Reply-To</dt><dd className="min-w-0 break-words">{final.replyTo.address ?? final.replyTo.note}</dd>
        <dt className="font-medium">Logo</dt><dd>{final.logoCount === 1 ? "One logo" : final.logoCount === 0 ? "No logo in this wording" : `${final.logoCount} logos (expected at most one)`}</dd>
        <dt className="font-medium">Signature</dt><dd>{final.signatureCount > 1 ? `${final.signatureCount} signatures (expected at most one)` : final.signaturePresent ? "One signature" : "No signature in this wording"}</dd>
        <dt className="font-medium">Sent as</dt><dd className="min-w-0 break-words">{final.transport.payloadFields.join(", ")}</dd>
        <dt className="font-medium">Footer</dt>
        <dd className={final.footer.state === "applied" ? "" : "text-destructive"}>
          {final.footer.state === "applied" ? "Compliance footer applied (sample unsubscribe link)" : `Cannot be built: ${final.footer.reason}`}
        </dd>
      </dl>
      <p className="text-xs text-muted-foreground">{final.note}{dark ? " Dark view approximates automatic inversion in mail apps." : ""}</p>
    </div>
  );
}
