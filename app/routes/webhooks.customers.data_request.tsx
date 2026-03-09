import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * customers/data_request — Shopify asks us to report what customer data we store.
 *
 * PetMatch does NOT store any personally-identifiable customer data.
 * Chat sessions use anonymous browser IDs only.
 * We log this request for compliance and return 200.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
    const { shop, topic, payload } = await authenticate.webhook(request);

    console.log(`[GDPR] Received ${topic} for ${shop}`);

    // Log to ComplianceLog
    await db.complianceLog.create({
        data: {
            shopDomain: shop ?? "unknown",
            topic: topic ?? "customers/data_request",
            payloadSummary: {
                shop_domain: (payload as any)?.shop_domain,
                orders_requested: (payload as any)?.orders_requested?.length ?? 0,
                customer_id: (payload as any)?.customer?.id,
                note: "No PII stored — chat uses anonymous browserId only",
            },
        },
    });

    console.log(`[GDPR] Logged customers/data_request for ${shop}`);

    return new Response();
};
