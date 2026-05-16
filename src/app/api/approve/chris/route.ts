import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";
import { getSupabase } from "@/lib/supabase";

// Chris clicks this link from the approval email.
// Sends the Inngest event that resumes the pipeline at step 5.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const customer_id = searchParams.get("customer_id");
  const campaign_id = searchParams.get("campaign_id");

  if (!customer_id || !campaign_id) {
    return NextResponse.json({ error: "Missing params" }, { status: 400 });
  }

  await inngest.send({
    name: "10milechris/chris.approved",
    data: { customer_id, campaign_id },
  });

  await getSupabase()
    .from("customers")
    .update({ status: "chris_approved" })
    .eq("id", customer_id);

  return new NextResponse(
    `<!DOCTYPE html>
<html>
<head><title>Approved</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:60px auto;text-align:center">
  <h2>✓ Campaign Approved</h2>
  <p>Customer approval email is being sent now. Pipeline will resume once the customer approves.</p>
</body>
</html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
