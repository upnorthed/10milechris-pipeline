import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "10milechris-pipeline",
  eventKey: process.env.INNGEST_EVENT_KEY,
});

// Typed event map
export type Events = {
  "10milechris/customer.created": {
    data: {
      customer_id: string;
    };
  };
  "10milechris/chris.approved": {
    data: {
      customer_id: string;
      campaign_id: string;
    };
  };
  "10milechris/customer.approved": {
    data: {
      customer_id: string;
      campaign_id: string;
    };
  };
};
