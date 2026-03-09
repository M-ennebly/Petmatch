import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * shop/redact — Shopify asks us to delete ALL data for a shop (48h after uninstall).
 *
 * Hard-deletes:
 *  - ChatMessages (may contain PII in message text / image URLs)
 *  - ChatSessions (linked to shop)
 *  - PetProfiles + related ProductMatch + SafetyLog (cascade)
 *  - Events (may contain session metadata)
 *  - SyncLogs
 *  - Products
 *  - MerchantSettings (cascade from Shop)
 *  - Shop record itself
 *  - Sessions (auth)
 *
 * Keeps: nothing for this shop.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
    const { shop, topic, payload } = await authenticate.webhook(request);

    console.log(`[GDPR] Received ${topic} for ${shop}`);

    const shopDomain = shop ?? (payload as any)?.shop_domain;

    if (!shopDomain) {
        console.log("[GDPR] shop/redact: no shop domain in payload, skipping.");
        return new Response();
    }

    // Track deletion counts for the compliance log
    const deleted: Record<string, number> = {};

    try {
        // 1. Delete ChatMessages via ChatSessions (messages may contain PII)
        const chatSessions = await db.chatSession.findMany({
            where: { shopDomain },
            select: { id: true },
        });
        const sessionIds = chatSessions.map((s) => s.id);

        if (sessionIds.length > 0) {
            const msgResult = await db.chatMessage.deleteMany({
                where: { sessionId: { in: sessionIds } },
            });
            deleted.chatMessages = msgResult.count;
        }

        // 2. Delete ChatSessions
        const sessResult = await db.chatSession.deleteMany({
            where: { shopDomain },
        });
        deleted.chatSessions = sessResult.count;

        // 3. Delete PetProfiles (cascades to ProductMatch + SafetyLog)
        const petResult = await db.petProfile.deleteMany({
            where: { shopDomain },
        });
        deleted.petProfiles = petResult.count;

        // 4. Delete Events
        const eventResult = await db.event.deleteMany({
            where: { shopId: shopDomain },
        });
        deleted.events = eventResult.count;

        // 5. Delete SyncLogs
        const syncResult = await db.syncLog.deleteMany({
            where: { shopDomain },
        });
        deleted.syncLogs = syncResult.count;

        // 6. Delete Products
        const prodResult = await db.product.deleteMany({
            where: { shopDomain },
        });
        deleted.products = prodResult.count;

        // 7. Delete Shop + MerchantSettings (cascade)
        const shopRecord = await db.shop.findUnique({ where: { domain: shopDomain } });
        if (shopRecord) {
            await db.shop.delete({ where: { domain: shopDomain } });
            deleted.shop = 1;
            deleted.merchantSettings = 1; // cascaded
        }

        // 8. Delete auth sessions
        const authResult = await db.session.deleteMany({
            where: { shop: shopDomain },
        });
        deleted.authSessions = authResult.count;

        console.log(`[GDPR] shop/redact complete for ${shopDomain}:`, deleted);
    } catch (error) {
        console.error(`[GDPR] shop/redact error for ${shopDomain}:`, error);
    }

    // Log to ComplianceLog (created AFTER deletions so it's the only record left)
    await db.complianceLog.create({
        data: {
            shopDomain,
            topic: topic ?? "shop/redact",
            payloadSummary: {
                shop_domain: shopDomain,
                deleted,
            },
        },
    });

    return new Response();
};
