import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { inngest } from "../client";
import { getSupabase } from "@/lib/supabase";
import {
  purchaseMailboxesAndDomain,
  createCampaign,
  addMailboxesToCampaign,
  addSequenceToCampaign,
  uploadLeads,
  launchCampaign,
} from "@/lib/smartlead";
import {
  triggerRecipientScrape,
  triggerHookBankScrape,
  getRunStatus,
  getDatasetItems,
  filterRecipients,
  extractHookPhrases,
} from "@/lib/apify";
import { sendChrisApprovalEmail, sendCustomerApprovalEmail } from "@/lib/resend";
import type { EmailArchetype, HookBank } from "@/lib/types";

const APPROVAL_TIMEOUT = "7d";

export const pipeline = inngest.createFunction(
  {
    id: "10milechris-pipeline",
    name: "10 Mile Chris Email Pipeline",
    retries: 2,
    timeouts: { finish: "7d" },
  },
  { event: "10milechris/customer.created" },
  async ({ event, step }) => {
    const { customer_id } = event.data;

    // ─── Fetch Customer ───────────────────────────────────────────────────────
    const customer = await step.run("fetch-customer", async () => {
      const sb = getSupabase();
      const { data, error } = await sb
        .from("customers")
        .select("*")
        .eq("id", customer_id)
        .single();
      if (error) throw new Error(`Customer not found: ${error.message}`);
      return data as {
        id: string;
        business_name: string;
        website: string | null;
        place_id: string | null;
        lat: number | null;
        lng: number | null;
        vertical: string | null;
        cta_type: string | null;
        cta_value: string | null;
        sender_name: string;
        status: string;
      };
    });

    // Bail if onboarding form hasn't been submitted yet — the Stripe webhook
    // creates a partial row (status='onboarding') before the customer fills in
    // their business details. We only run the pipeline on complete records.
    if (!customer.business_name || !customer.lat || !customer.lng || !customer.place_id) {
      return { skipped: true, reason: "onboarding incomplete", customer_id };
    }

    // ─── Step 1: Purchase Mailboxes ───────────────────────────────────────────
    const mailboxes = await step.run("purchase-mailboxes", async () => {
      return purchaseMailboxesAndDomain(customer.business_name);
    });

    const campaignRow = await step.run("create-campaign-record", async () => {
      const sb = getSupabase();
      const { data, error } = await sb
        .from("campaigns")
        .insert({
          customer_id,
          smartlead_campaign_id: null,
          status: "mailboxes_purchased",
          sequence_day: 1,
        })
        .select()
        .single();
      if (error) throw new Error(`Failed to create campaign: ${error.message}`);
      return data as { id: string };
    });

    await step.run("update-status-mailboxes", async () => {
      await getSupabase()
        .from("customers")
        .update({ status: "mailboxes_purchased" })
        .eq("id", customer_id);
    });

    // ─── Step 2: Trigger Apify Scrapes ───────────────────────────────────────
    const [recipientRunId, hookRunId] = await step.run(
      "trigger-apify-scrapes",
      async () => {
        const r = await triggerRecipientScrape(customer.lat!, customer.lng!);
        const h = await triggerHookBankScrape(
          customer.lat!,
          customer.lng!,
          customer.vertical ?? "restaurant"
        );
        return [r, h];
      }
    );

    // Poll until both runs complete
    const [recipientDatasetId, hookDatasetId] = await step.run(
      "poll-apify-completion",
      async () => {
        const poll = async (runId: string): Promise<string> => {
          for (let attempt = 0; attempt < 60; attempt++) {
            const { status, datasetId } = await getRunStatus(runId);
            if (status === "SUCCEEDED") return datasetId;
            if (["FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
              throw new Error(`Apify run ${runId} ended with status: ${status}`);
            }
            await new Promise((r) => setTimeout(r, 30_000)); // 30s poll
          }
          throw new Error(`Apify run ${runId} timed out after 30 minutes`);
        };
        const [rDs, hDs] = await Promise.all([poll(recipientRunId), poll(hookRunId)]);
        return [rDs, hDs];
      }
    );

    // Fetch and store recipients
    const recipients = await step.run("store-recipients", async () => {
      const raw = await getDatasetItems(recipientDatasetId);
      const filtered = filterRecipients(raw);
      const sb = getSupabase();
      const rows = filtered.map((p) => ({
        customer_id,
        business_name: p.title,
        website: p.website ?? null,
        email: (p.emails ?? [])[0] ?? null,
        email_type: "to",
        phone: p.phone ?? null,
        address: p.address ?? null,
        place_id: p.placeId ?? null,
        status: "pending",
      }));
      if (rows.length > 0) {
        await sb.from("recipients").insert(rows);
      }
      return filtered;
    });

    // Fetch and store hook bank
    const hookPhrases = await step.run("store-hook-bank", async () => {
      const raw = await getDatasetItems(hookDatasetId);
      const phrases = extractHookPhrases(raw);
      const sb = getSupabase();
      const rows = phrases.slice(0, 500).map((p) => ({
        customer_id,
        archetype: "pain",
        pain_phrase: p.phrase,
        frequency: 1,
        source_review: `${p.stars} stars`,
      }));
      if (rows.length > 0) {
        await sb.from("hook_bank").insert(rows);
      }
      return phrases;
    });

    await step.run("update-status-scraped", async () => {
      await getSupabase()
        .from("customers")
        .update({ status: "scraped" })
        .eq("id", customer_id);
    });

    // ─── Step 3: Generate 3 Email Bodies with Claude Haiku ───────────────────
    const emailArchetypes = await step.run("generate-email-bodies", async () => {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const painPhrases = hookPhrases
        .slice(0, 20)
        .map((p) => p.phrase)
        .join("\n- ");

      const archetypes: Array<"faq" | "fun_facts" | "history"> = [
        "faq",
        "fun_facts",
        "history",
      ];
      const results: EmailArchetype[] = [];

      const customerForPrompt = {
        ...customer,
        website: customer.website ?? "",
        vertical: customer.vertical ?? "restaurant",
        cta_type: customer.cta_type ?? "url",
        cta_value: customer.cta_value ?? "",
      };

      for (const archetype of archetypes) {
        const prompt = buildEmailPrompt(archetype, customerForPrompt, painPhrases);
        const response = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt }],
        });
        const text =
          response.content[0].type === "text" ? response.content[0].text : "";
        const parsed = parseEmailResponse(text, archetype, customerForPrompt);
        results.push(parsed);
      }

      return results;
    });

    await step.run("update-status-emails-generated", async () => {
      await getSupabase()
        .from("customers")
        .update({ status: "emails_generated" })
        .eq("id", customer_id);
    });

    // ─── Step 4: Personalize with Gemini ─────────────────────────────────────
    const recipientIds = await step.run("fetch-recipient-ids", async () => {
      const sb = getSupabase();
      const { data } = await sb
        .from("recipients")
        .select("id, business_name, website")
        .eq("customer_id", customer_id)
        .eq("status", "pending");
      return (data ?? []) as Array<{
        id: string;
        business_name: string;
        website: string;
      }>;
    });

    // Personalize in batches to checkpoint progress
    const PERSONALIZE_BATCH = 50;
    const totalBatches = Math.ceil(
      (recipientIds.length * emailArchetypes.length) / PERSONALIZE_BATCH
    );

    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      await step.run(`personalize-batch-${batchIdx}`, async () => {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
        const model = genAI.getGenerativeModel({
          model: "gemini-2.5-flash-lite",
        });

        const flatJobs: Array<{
          recipientId: string;
          businessName: string;
          website: string;
          archetype: EmailArchetype;
        }> = [];

        for (const r of recipientIds) {
          for (const arch of emailArchetypes) {
            flatJobs.push({
              recipientId: r.id,
              businessName: r.business_name,
              website: r.website,
              archetype: arch,
            });
          }
        }

        const batchJobs = flatJobs.slice(
          batchIdx * PERSONALIZE_BATCH,
          (batchIdx + 1) * PERSONALIZE_BATCH
        );

        const sb = getSupabase();

        for (const job of batchJobs) {
          try {
            const prompt = buildPersonalizationPrompt(
              job.businessName,
              job.website,
              job.archetype,
              { business_name: customer.business_name, vertical: customer.vertical ?? "restaurant" }
            );
            const result = await model.generateContent(prompt);
            const text = result.response.text();
            const { subject, bullets } = parsePersonalizationResponse(
              text,
              job.archetype
            );

            await sb.from("emails").insert({
              campaign_id: campaignRow.id,
              recipient_id: job.recipientId,
              subject,
              body: job.archetype.body,
              archetype: job.archetype.archetype,
              photo_url: job.archetype.photo_url,
              status: "draft",
            });
          } catch {
            // log and continue — don't fail the whole batch for one recipient
          }
        }
      });
    }

    await step.run("update-status-personalized", async () => {
      await getSupabase()
        .from("customers")
        .update({ status: "personalized" })
        .eq("id", customer_id);
    });

    // ─── Step 5: Chris Approval Gate ─────────────────────────────────────────
    const baseUrl =
      process.env.NEXT_PUBLIC_BASE_URL ?? "https://10milechris-pipeline.vercel.app";

    const samplePersonalizations = await step.run(
      "fetch-sample-personalizations",
      async () => {
        const sb = getSupabase();
        const { data } = await sb
          .from("emails")
          .select("*, recipients(business_name)")
          .eq("campaign_id", campaignRow.id)
          .limit(9);
        return (data ?? []).map((e: Record<string, unknown>) => ({
          recipientName:
            (e.recipients as { business_name: string } | null)?.business_name ??
            "Sample Business",
          archetype: e.archetype as string,
          subject: e.subject as string,
          bullets: ["Bullet 1", "Bullet 2"] as [string, string],
        }));
      }
    );

    await step.run("send-chris-approval-email", async () => {
      await sendChrisApprovalEmail({
        customerId: customer_id,
        customerName: customer.business_name,
        archetypes: emailArchetypes,
        samplePersonalizations,
        approveUrl: `${baseUrl}/api/approve/chris?customer_id=${customer_id}&campaign_id=${campaignRow.id}`,
      });
    });

    await step.run("update-status-pending-chris", async () => {
      await getSupabase()
        .from("customers")
        .update({ status: "pending_chris_approval" })
        .eq("id", customer_id);
    });

    // Wait for Chris to click approve
    const chrisApproval = await step.waitForEvent("wait-for-chris-approval", {
      event: "10milechris/chris.approved",
      match: "data.customer_id",
      timeout: APPROVAL_TIMEOUT,
    });

    if (!chrisApproval) {
      throw new Error(`Chris approval timed out for customer ${customer_id}`);
    }

    // ─── Step 6: Customer Approval Gate ──────────────────────────────────────
    const customerEmail = await step.run("fetch-customer-email", async () => {
      // Customer email comes from their user record or the website domain
      // For now, we derive it from the website or store it in a separate field
      const sb = getSupabase();
      const { data } = await sb
        .from("customers")
        .select("website, business_name")
        .eq("id", customer_id)
        .single();
      // Attempt to find a contact email — fall back to a placeholder
      const domain = (data?.website ?? "")
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "");
      return `info@${domain}`;
    });

    await step.run("send-customer-approval-email", async () => {
      await sendCustomerApprovalEmail({
        customerId: customer_id,
        customerEmail,
        customerName: customer.business_name,
        senderName: customer.sender_name,
        archetypes: emailArchetypes,
        approveUrl: `${baseUrl}/api/approve/customer?customer_id=${customer_id}&campaign_id=${campaignRow.id}`,
      });
    });

    await step.run("update-status-pending-customer", async () => {
      await getSupabase()
        .from("customers")
        .update({ status: "pending_customer_approval" })
        .eq("id", customer_id);
    });

    const customerApproval = await step.waitForEvent(
      "wait-for-customer-approval",
      {
        event: "10milechris/customer.approved",
        match: "data.customer_id",
        timeout: APPROVAL_TIMEOUT,
      }
    );

    if (!customerApproval) {
      throw new Error(
        `Customer approval timed out for customer ${customer_id}`
      );
    }

    // ─── Step 7: Launch Smartlead Campaign ───────────────────────────────────
    const smartleadCampaignId = await step.run(
      "create-smartlead-campaign",
      async () => {
        const campaign = await createCampaign(
          `10MC - ${customer.business_name} - ${new Date().toISOString().slice(0, 10)}`,
          customer.sender_name
        );
        return campaign.id;
      }
    );

    await step.run("assign-mailboxes-to-campaign", async () => {
      await addMailboxesToCampaign(
        smartleadCampaignId,
        mailboxes.mailbox_ids
      );
    });

    await step.run("add-email-sequences", async () => {
      const sequences = emailArchetypes.map((a, i) => ({
        subject: a.subject,
        email_body: a.body,
        seq_number: i + 1,
      }));
      await addSequenceToCampaign(smartleadCampaignId, sequences);
    });

    await step.run("upload-leads", async () => {
      const sb = getSupabase();
      const { data: emailRows } = await sb
        .from("emails")
        .select("*, recipients(business_name, website, email, address)")
        .eq("campaign_id", campaignRow.id)
        .eq("status", "draft");

      if (!emailRows || emailRows.length === 0) return;

      // Group by recipient — one lead entry with all 3 email personalizations as custom fields
      const recipientMap = new Map<
        string,
        {
          email: string;
          businessName: string;
          website: string;
          subjects: Record<string, string>;
        }
      >();

      for (const row of emailRows as Array<Record<string, unknown>>) {
        const r = row.recipients as {
          business_name: string;
          website: string;
          email: string;
        } | null;
        if (!r?.email) continue;
        if (!recipientMap.has(r.email)) {
          recipientMap.set(r.email, {
            email: r.email,
            businessName: r.business_name,
            website: r.website ?? "",
            subjects: {},
          });
        }
        const entry = recipientMap.get(r.email)!;
        entry.subjects[row.archetype as string] = row.subject as string;
      }

      const leads = Array.from(recipientMap.values()).map((r) => ({
        email: r.email,
        first_name: r.businessName.split(" ")[0],
        last_name: r.businessName.split(" ").slice(1).join(" ") || "Owner",
        company_name: r.businessName,
        website: r.website,
        custom_fields: {
          subject_faq: r.subjects["faq"] ?? "",
          subject_fun_facts: r.subjects["fun_facts"] ?? "",
          subject_history: r.subjects["history"] ?? "",
        },
      }));

      await uploadLeads(smartleadCampaignId, leads);
    });

    await step.run("launch-campaign", async () => {
      await launchCampaign(smartleadCampaignId);
    });

    await step.run("finalize-records", async () => {
      const sb = getSupabase();
      await sb
        .from("campaigns")
        .update({
          smartlead_campaign_id: smartleadCampaignId,
          status: "launched",
        })
        .eq("id", campaignRow.id);
      await sb
        .from("customers")
        .update({ status: "launched" })
        .eq("id", customer_id);
      await sb
        .from("emails")
        .update({ status: "queued" })
        .eq("campaign_id", campaignRow.id);
    });

    return {
      customer_id,
      campaign_id: campaignRow.id,
      smartlead_campaign_id: smartleadCampaignId,
      recipients_count: recipients.length,
      status: "launched",
    };
  }
);

// ─── Prompt helpers ──────────────────────────────────────────────────────────

function buildEmailPrompt(
  archetype: "faq" | "fun_facts" | "history",
  customer: {
    business_name: string;
    website: string;
    vertical: string;
    cta_type: string;
    cta_value: string;
    sender_name: string;
  },
  painPhrases: string
): string {
  const archetypeInstructions: Record<string, string> = {
    faq: "Write an email using a FAQ format — answer 2 common questions local business owners in this vertical have. Use a conversational tone.",
    fun_facts:
      "Write an email sharing 2 surprising fun facts about this industry vertical that would make a local business owner think differently about their marketing.",
    history:
      "Write an email with a brief, compelling history fact about this business vertical that ties into why email marketing matters today.",
  };

  return `You are writing a cold email for a local restaurant email marketing service called "${customer.sender_name}".

Business context:
- Sender: ${customer.sender_name} (${customer.website ?? "no website"})
- Vertical: ${customer.vertical ?? "restaurant"}
- CTA: ${customer.cta_type ?? "url"} → ${customer.cta_value ?? ""}

Common pain points from low-rated competitor reviews:
- ${painPhrases}

Email archetype: ${archetype.toUpperCase()}
Instructions: ${archetypeInstructions[archetype]}

Write a cold email with:
1. Subject line (under 50 chars, no emoji)
2. Photo description (describe what kind of photo would complement this email, 1 sentence)
3. Two bullet points (punchy, under 15 words each)
4. Full email body (150-200 words, first-person from sender, ends with CTA)

Format your response EXACTLY as:
SUBJECT: [subject line]
PHOTO: [photo description]
BULLET1: [first bullet]
BULLET2: [second bullet]
BODY:
[full email body]`;
}

function parseEmailResponse(
  text: string,
  archetype: "faq" | "fun_facts" | "history",
  customer: { cta_value: string }
): EmailArchetype {
  const subject = text.match(/SUBJECT:\s*(.+)/)?.[1]?.trim() ?? "Quick question";
  const photo = text.match(/PHOTO:\s*(.+)/)?.[1]?.trim() ?? "";
  const bullet1 = text.match(/BULLET1:\s*(.+)/)?.[1]?.trim() ?? "";
  const bullet2 = text.match(/BULLET2:\s*(.+)/)?.[1]?.trim() ?? "";
  const body = text.match(/BODY:\n([\s\S]+)/)?.[1]?.trim() ?? text;

  return {
    archetype,
    subject,
    photo_url: photo,
    bullets: [bullet1, bullet2],
    cta: customer.cta_value ?? "",
    body,
  };
}

function buildPersonalizationPrompt(
  recipientName: string,
  recipientWebsite: string,
  archetype: EmailArchetype,
  customer: { business_name: string; vertical: string }
): string {
  return `Personalize this cold email subject line and two bullets for a specific local restaurant.

Recipient: ${recipientName} (${recipientWebsite || "no website"})
Sender context: ${customer.business_name}, ${customer.vertical ?? "restaurant"} marketing service

Base subject: ${archetype.subject}
Base bullet 1: ${archetype.bullets[0]}
Base bullet 2: ${archetype.bullets[1]}

Rewrite the subject and bullets to feel like they were written specifically for ${recipientName}. Keep the same angle/archetype. Be specific, brief, and avoid generic phrases.

Respond EXACTLY as:
SUBJECT: [personalized subject, under 50 chars]
BULLET1: [personalized bullet 1, under 15 words]
BULLET2: [personalized bullet 2, under 15 words]`;
}

function parsePersonalizationResponse(
  text: string,
  archetype: EmailArchetype
): { subject: string; bullets: [string, string] } {
  const subject =
    text.match(/SUBJECT:\s*(.+)/)?.[1]?.trim() ?? archetype.subject;
  const bullet1 =
    text.match(/BULLET1:\s*(.+)/)?.[1]?.trim() ?? archetype.bullets[0];
  const bullet2 =
    text.match(/BULLET2:\s*(.+)/)?.[1]?.trim() ?? archetype.bullets[1];
  return { subject, bullets: [bullet1, bullet2] };
}
