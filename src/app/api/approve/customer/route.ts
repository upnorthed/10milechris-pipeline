import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";
import { getSupabase } from "@/lib/supabase";

// Customer clicks this link from their approval email.
// Sends the Inngest event that resumes the pipeline at step 6.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const customer_id = searchParams.get("customer_id");
  const campaign_id = searchParams.get("campaign_id");

  if (!customer_id || !campaign_id) {
    return NextResponse.json({ error: "Missing params" }, { status: 400 });
  }

  await inngest.send({
    name: "10milechris/customer.approved",
    data: { customer_id, campaign_id },
  });

  await getSupabase()
    .from("customers")
    .update({ status: "customer_approved" })
    .eq("id", customer_id);

  return new NextResponse(
    `<!DOCTYPE html>
<html>
<head><title>Campaign Approved</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:60px auto;text-align:center">
  <h2>🚀 Campaign Approved!</h2>
  <p>Your email campaign is now launching. You'll start hearing from local restaurants soon.</p>
  <p style="color:#888;margin-top:40px;font-size:14px">Powered by 10 Mile Chris</p>
</body>
</html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
