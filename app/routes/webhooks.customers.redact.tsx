import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * customers/redact — Shopify asks us to delete a specific customer's data.
 *
 * PetMatch does NOT store any personally-identifiable customer data.
 * Chat sessions use anonymous browser IDs — they are not linked to Shopify customer IDs.
 * We log this request for compliance and return 200.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
    const { shop, topic, payload } = await authenticate.webhook(request);

    console.log(`[GDPR] Received ${topic} for ${shop}`);

    // Log to ComplianceLog
    await db.complianceLog.create({
        data: {
            shopDomain: shop ?? "unknown",
            topic: topic ?? "customers/redact",
            payloadSummary: {
                shop_domain: (payload as any)?.shop_domain,
                customer_id: (payload as any)?.customer?.id,
                orders_to_redact: (payload as any)?.orders_to_redact?.length ?? 0,
                note: "No customer PII stored — no data to redact",
            },
        },
    });

    console.log(`[GDPR] Logged customers/redact for ${shop} — no PII to delete`);

    return new Response();
};
