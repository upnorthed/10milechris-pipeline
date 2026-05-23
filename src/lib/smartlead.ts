const BASE = "https://server.smartlead.ai/api/v1";

function apiKey() {
  const key = process.env.SMARTLEAD_API_KEY;
  if (!key) throw new Error("Missing SMARTLEAD_API_KEY");
  return key;
}

async function sl<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const url = `${BASE}${path}${path.includes("?") ? "&" : "?"}api_key=${apiKey()}`;
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Smartlead ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export interface MailboxPool {
  mailbox_ids: string[];
  email_accounts: Array<{ id: number; email: string }>;
}

// Fetch all active email accounts from Smartlead and return up to 3.
// Smartlead has no API for purchasing domains — mailboxes must be set up
// in the Smartlead dashboard first and then assigned here.
export async function getExistingMailboxes(): Promise<MailboxPool> {
  const accounts = await sl<Array<{ id: number; email: string; status?: string }>>(
    "/email-accounts?limit=100&offset=0"
  );

  if (!accounts || accounts.length === 0) {
    throw new Error("No email accounts found in Smartlead. Add mailboxes in the Smartlead dashboard first.");
  }

  // Take up to 3 active accounts (rotate across customers later)
  const pool = accounts.slice(0, 3);
  return {
    mailbox_ids: pool.map((a) => String(a.id)),
    email_accounts: pool,
  };
}

export interface SmartleadCampaign {
  id: string;
}

export async function createCampaign(
  name: string,
  senderName: string
): Promise<SmartleadCampaign> {
  return sl<SmartleadCampaign>("/campaigns", "POST", {
    name,
    client_id: null,
    track_settings: ["DONT_TRACK_EMAIL_OPEN", "DONT_TRACK_LINK_CLICK"],
    scheduler_cron_value: {
      timezone: "America/Chicago",
      days_of_the_week: [0, 1, 2, 3, 4, 5, 6],
      start_hour: "08:00",
      end_hour: "18:00",
      min_time_btw_emails: 5,
      max_new_leads_per_day: 50,
    },
    from_name: senderName,
  });
}

export async function addMailboxesToCampaign(
  campaignId: string,
  emailAccountIds: string[]
): Promise<void> {
  await sl(`/campaigns/${campaignId}/email-accounts`, "POST", {
    email_account_ids: emailAccountIds,
  });
}

export interface LeadData {
  email: string;
  first_name: string;
  last_name: string;
  company_name: string;
  website: string;
  custom_fields: Record<string, string>;
}

export async function uploadLeads(
  campaignId: string,
  leads: LeadData[]
): Promise<void> {
  // Smartlead accepts batches of up to 100
  const BATCH = 100;
  for (let i = 0; i < leads.length; i += BATCH) {
    const batch = leads.slice(i, i + BATCH);
    await sl(`/campaigns/${campaignId}/leads`, "POST", { lead_list: batch });
  }
}

export async function addSequenceToCampaign(
  campaignId: string,
  sequences: Array<{ subject: string; email_body: string; seq_number: number }>
): Promise<void> {
  await sl(`/campaigns/${campaignId}/sequences`, "POST", {
    sequences,
  });
}

export async function launchCampaign(campaignId: string): Promise<void> {
  await sl(`/campaigns/${campaignId}/status`, "POST", { status: "START" });
}
