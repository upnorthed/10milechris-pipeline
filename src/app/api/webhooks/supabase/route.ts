import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";

// Supabase database webhook fires when a new row is inserted into the customers table.
// Configure in Supabase: Database → Webhooks → New Webhook
//   Table: customers | Event: INSERT | URL: https://your-app.vercel.app/api/webhooks/supabase
export async function POST(req: NextRequest) {
  const payload = await req.json();

  // Supabase sends { type, table, record, schema, old_record }
  const { type, table, record } = payload;

  if (table !== "customers" || type !== "INSERT") {
    return NextResponse.json({ ok: true, skipped: true });
  }

  await inngest.send({
    name: "10milechris/customer.created",
    data: { customer_id: record.id },
  });

  return NextResponse.json({ ok: true, customer_id: record.id });
}
