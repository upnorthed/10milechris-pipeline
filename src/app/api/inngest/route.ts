import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { pipeline } from "@/inngest/index";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [pipeline],
  signingKey: process.env.INNGEST_SIGNING_KEY,
});
