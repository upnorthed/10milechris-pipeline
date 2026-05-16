import { Resend } from "resend";
import type { EmailArchetype } from "./types";

function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("Missing RESEND_API_KEY");
  return new Resend(key);
}

function archetypeLabel(a: string) {
  return a === "faq" ? "FAQ" : a === "fun_facts" ? "Fun Facts" : "History";
}

export async function sendChrisApprovalEmail(params: {
  customerId: string;
  customerName: string;
  archetypes: EmailArchetype[];
  samplePersonalizations: Array<{
    recipientName: string;
    archetype: string;
    subject: string;
    bullets: [string, string];
  }>;
  approveUrl: string;
}): Promise<void> {
  const resend = getResend();

  const html = `
<h2>Pipeline Approval: ${params.customerName}</h2>
<p>The 10 Mile Chris pipeline has generated 3 email archetypes for <strong>${params.customerName}</strong>. Review and approve below.</p>

${params.archetypes
  .map(
    (a) => `
<hr/>
<h3>${archetypeLabel(a.archetype)}</h3>
<p><strong>Subject:</strong> ${a.subject}</p>
<p><strong>Body:</strong></p>
<pre style="background:#f5f5f5;padding:12px;border-radius:4px;white-space:pre-wrap">${a.body}</pre>
`
  )
  .join("")}

<hr/>
<h3>Sample Personalizations</h3>
${params.samplePersonalizations
  .map(
    (s) => `
<p><strong>${s.recipientName}</strong> — ${archetypeLabel(s.archetype)}</p>
<p>Subject: ${s.subject}</p>
<p>• ${s.bullets[0]}<br/>• ${s.bullets[1]}</p>
`
  )
  .join("")}

<hr/>
<p><a href="${params.approveUrl}" style="background:#0070f3;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">Approve Campaign →</a></p>
<p style="color:#888;font-size:12px;">Clicking approve will trigger the customer approval email.</p>
  `;

  await resend.emails.send({
    from: "10 Mile Chris Pipeline <pipeline@10milechris.com>",
    to: "chris@10milechris.com",
    subject: `[Approve] ${params.customerName} campaign ready`,
    html,
  });
}

export async function sendCustomerApprovalEmail(params: {
  customerId: string;
  customerEmail: string;
  customerName: string;
  senderName: string;
  archetypes: EmailArchetype[];
  approveUrl: string;
}): Promise<void> {
  const resend = getResend();

  const html = `
<h2>Your Email Campaign Drafts</h2>
<p>Hi! Here are your 3 email campaign drafts. Review them and click approve when you're ready to launch.</p>

${params.archetypes
  .map(
    (a) => `
<hr/>
<h3>${archetypeLabel(a.archetype)}</h3>
<p><strong>Subject:</strong> ${a.subject}</p>
<div style="background:#f9f9f9;padding:16px;border-radius:6px;margin:8px 0">${a.body.replace(/\n/g, "<br/>")}</div>
`
  )
  .join("")}

<hr/>
<p><a href="${params.approveUrl}" style="background:#16a34a;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">Approve & Launch Campaign →</a></p>
<p style="color:#888;font-size:12px;">Sent by ${params.senderName} via 10 Mile Chris</p>
  `;

  await resend.emails.send({
    from: `${params.senderName} <pipeline@10milechris.com>`,
    to: params.customerEmail,
    subject: `Your email campaign is ready to review`,
    html,
  });
}
