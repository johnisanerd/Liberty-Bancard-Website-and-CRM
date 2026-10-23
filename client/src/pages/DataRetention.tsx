import { useRef, useState } from "react";
import { SEO } from "@/components/SEO";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { Mail, Phone, CheckCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { trackPhoneCallClick } from "@/lib/analytics";

const deleteRequestSchema = z.object({
  fullName: z.string().min(1, "Full name is required"),
  email: z.string().email("Valid email is required"),
  requestType: z.string().min(1, "Request type is required"),
  description: z.string().optional(),
});

type DeleteRequestForm = z.infer<typeof deleteRequestSchema>;

const RETENTION_DATA = [
  { type: "Account Data", period: "Duration of account + 3 years" },
  { type: "Processing Statements", period: "7 years (regulatory requirement)" },
  { type: "Communications", period: "5 years" },
  { type: "Marketing Data", period: "Until opt-out + 30 days" },
  { type: "Support Records", period: "5 years" },
  { type: "Audit Logs", period: "7 years" },
];

export default function DataRetention() {
  const { toast } = useToast();
  const [submitted, setSubmitted] = useState(false);
  const requestKey = useRef<string | null>(null);

  const form = useForm<DeleteRequestForm>({
    resolver: zodResolver(deleteRequestSchema),
    defaultValues: {
      fullName: "",
      email: "",
      requestType: "",
      description: "",
    },
  });

  const mutation = useMutation({
    mutationFn: async (data: DeleteRequestForm) => {
      requestKey.current ??= crypto.randomUUID();
      try {
        await apiRequest("POST", "/api/data-requests", data, { "Idempotency-Key": requestKey.current });
      } catch (error) {
        // apiRequest throws on a server answer (rotate: the next submit is a new request) and on network failure
        // (keep: the retry replays). A server answer carries an HTTP status prefix.
        if (error instanceof Error && /^\d{3}:/.test(error.message)) requestKey.current = null;
        throw error;
      }
    },
    onSuccess: () => {
      requestKey.current = null;
      setSubmitted(true);
      toast({ title: "Request received", description: "Our team will review it and contact you at the email address provided." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const onSubmit = (data: DeleteRequestForm) => {
    mutation.mutate(data);
  };

  return (
    <div className="min-h-screen flex flex-col font-body overflow-x-hidden">
      <SEO title="Data Retention & Deletion Policy" description="Liberty Bancard data retention periods and how to request data deletion, access, correction, or portability." path="/data-retention" />
      <Navbar />
      <main className="flex-grow pt-16">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          <h1 className="text-3xl md:text-4xl font-display font-bold text-foreground mb-2" data-testid="text-data-retention-heading">
            Data Retention & Deletion Policy
          </h1>
          <p className="text-sm text-muted-foreground mb-10" data-testid="text-data-retention-updated">
            Last updated: February 19, 2026
          </p>

          <div className="space-y-8 text-muted-foreground leading-relaxed">
            <section data-testid="section-data-collect">
              <h2 className="text-xl font-display font-semibold text-foreground mb-3">Data We Collect</h2>
              <p className="mb-3">
                Liberty Bancard collects and processes various categories of data in the course of providing our merchant services. These include:
              </p>
              <ul className="list-disc pl-6 space-y-1">
                <li><strong>Account Data:</strong> Name, email, phone number, business information, login credentials, and account preferences.</li>
                <li><strong>Processing Statements:</strong> Merchant processing statements uploaded for analysis and rate comparison.</li>
                <li><strong>Communications:</strong> Emails, SMS messages, chat transcripts, and other correspondence with our team.</li>
                <li><strong>Marketing Data:</strong> Communication preferences, opt-in/opt-out records, campaign engagement data.</li>
                <li><strong>Support Records:</strong> Support tickets, issue descriptions, resolution notes, and related documentation.</li>
                <li><strong>Audit Logs:</strong> System access logs, consent records, data processing activities, and security event logs.</li>
              </ul>
            </section>

            <section data-testid="section-retention-periods">
              <h2 className="text-xl font-display font-semibold text-foreground mb-3">Retention Periods</h2>
              <p className="mb-4">
                We retain your data only for as long as necessary to fulfill the purposes for which it was collected, comply with legal obligations, and support our legitimate business interests. Below are our standard retention periods:
              </p>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm" data-testid="table-retention-periods">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-3 pr-4 font-semibold text-foreground">Data Type</th>
                      <th className="text-left py-3 font-semibold text-foreground">Retention Period</th>
                    </tr>
                  </thead>
                  <tbody>
                    {RETENTION_DATA.map((row) => (
                      <tr key={row.type} className="border-b border-border" data-testid={`row-retention-${row.type.toLowerCase().replace(/\s+/g, "-")}`}>
                        <td className="py-3 pr-4 font-medium text-foreground">{row.type}</td>
                        <td className="py-3 text-muted-foreground">{row.period}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs">
                Certain data may be retained longer where required by applicable law, regulation, or ongoing legal proceedings.
              </p>
            </section>

            <section data-testid="section-your-rights">
              <h2 className="text-xl font-display font-semibold text-foreground mb-3">Your Rights</h2>
              <p className="mb-3">
                Depending on your jurisdiction, you may have the following rights regarding your personal data:
              </p>
              <ul className="list-disc pl-6 space-y-1">
                <li><strong>Right to Access:</strong> Request a copy of the personal data we hold about you.</li>
                <li><strong>Right to Correction:</strong> Request correction of inaccurate or incomplete personal data.</li>
                <li><strong>Right to Deletion:</strong> Request deletion of your personal data, subject to legal retention requirements.</li>
                <li><strong>Right to Data Portability:</strong> Receive your personal data in a structured, commonly used, machine-readable format.</li>
              </ul>
              <p className="mt-3">
                To exercise any of these rights, please use the form below or contact us at{" "}
                <a href="mailto:privacy@libertybancard.com" className="underline">privacy@libertybancard.com</a>.
              </p>
            </section>

            <section data-testid="section-how-to-request">
              <h2 className="text-xl font-display font-semibold text-foreground mb-3">How to Request Deletion</h2>
              <p className="mb-3">
                You may submit a data request using the form below. We will verify your identity before acting on your request. Some data may be retained where required by applicable law or regulation.
              </p>

              {submitted ? (
                <Card data-testid="card-request-success">
                  <CardContent className="pt-6 flex flex-col items-center gap-3 text-center">
                    <CheckCircle className="w-10 h-10 text-green-600" />
                    <h3 className="text-lg font-semibold text-foreground" data-testid="text-request-success">
                      Request received
                    </h3>
                    <p className="text-muted-foreground" data-testid="text-request-success-desc">
                      We have recorded your data request. It is received, not yet verified or completed. Our team will review it and contact you at the email address provided; we may ask you to confirm your identity first.
                    </p>
                    <Button variant="outline" className="min-h-11" onClick={() => { setSubmitted(false); form.reset(); }} data-testid="button-submit-another">
                      Submit Another Request
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                <Card data-testid="card-request-form">
                  <CardContent className="pt-6">
                    <Form {...form}>
                      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                        <FormField
                          control={form.control}
                          name="fullName"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Full Name</FormLabel>
                              <FormControl>
                                <Input className="min-h-11" placeholder="Your full name" {...field} data-testid="input-request-name" />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="email"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Email Address</FormLabel>
                              <FormControl>
                                <Input className="min-h-11" type="email" placeholder="you@example.com" {...field} data-testid="input-request-email" />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="requestType"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Request Type</FormLabel>
                              <Select onValueChange={field.onChange} value={field.value}>
                                <FormControl>
                                  <SelectTrigger className="min-h-11" data-testid="select-request-type">
                                    <SelectValue placeholder="Select request type" />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  <SelectItem value="Delete My Data" data-testid="option-delete">Delete My Data</SelectItem>
                                  <SelectItem value="Access My Data" data-testid="option-access">Access My Data</SelectItem>
                                  <SelectItem value="Correct My Data" data-testid="option-correct">Correct My Data</SelectItem>
                                  <SelectItem value="Data Portability" data-testid="option-portability">Data Portability</SelectItem>
                                </SelectContent>
                              </Select>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="description"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Description (optional)</FormLabel>
                              <FormControl>
                                <Textarea placeholder="Provide additional details about your request..." {...field} data-testid="input-request-description" />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <Button type="submit" className="min-h-11" disabled={mutation.isPending} data-testid="button-submit-request">
                          {mutation.isPending ? "Submitting..." : "Submit Request"}
                        </Button>
                      </form>
                    </Form>
                  </CardContent>
                </Card>
              )}
            </section>

            <section data-testid="section-data-retention-contact">
              <h2 className="text-xl font-display font-semibold text-foreground mb-3">Contact Us</h2>
              <p className="mb-3">
                For questions about this policy or to exercise your data protection rights, please contact us:
              </p>
              <div className="space-y-2">
                <a href="mailto:privacy@libertybancard.com" className="flex items-center gap-2 text-foreground hover:text-primary transition-colors" data-testid="link-data-retention-email">
                  <Mail className="w-4 h-4 shrink-0" />
                  <span>privacy@libertybancard.com</span>
                </a>
                <a href="tel:9542668214" className="flex items-center gap-2 text-foreground hover:text-primary transition-colors" data-testid="link-data-retention-phone" onClick={() => trackPhoneCallClick({ sourcePage: "/data-retention" })}>
                  <Phone className="w-4 h-4 shrink-0" />
                  <span>954-266-8214</span>
                </a>
              </div>
            </section>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
