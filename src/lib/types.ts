export interface Customer {
  id: string;
  business_name: string;
  website: string;
  place_id: string;
  lat: number;
  lng: number;
  vertical: string;
  cta_type: string;
  cta_value: string;
  sender_name: string;
  status: string;
}

export interface Recipient {
  id: string;
  customer_id: string;
  business_name: string;
  website: string;
  email: string;
  email_type: string;
  phone: string;
  address: string;
  place_id: string;
  status: string;
}

export interface Campaign {
  id: string;
  customer_id: string;
  smartlead_campaign_id: string;
  status: string;
  sequence_day: number;
}

export interface Email {
  id: string;
  campaign_id: string;
  recipient_id: string;
  subject: string;
  body: string;
  archetype: string;
  photo_url: string;
  sent_at: string | null;
  opened_at: string | null;
  replied_at: string | null;
  status: string;
}

export interface HookBank {
  id: string;
  customer_id: string;
  archetype: string;
  pain_phrase: string;
  frequency: number;
  source_review: string;
}

export interface EmailArchetype {
  archetype: "faq" | "fun_facts" | "history";
  subject: string;
  photo_url: string;
  bullets: [string, string];
  cta: string;
  body: string;
}

export type ApifyActorStatus =
  | "READY"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED-OUT"
  | "ABORTED";
