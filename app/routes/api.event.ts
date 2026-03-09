import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import db from "../db.server";
import {
    buildCorsHeaders,
    preflightResponse,
    checkRateLimit,
    rateLimitResponse,
    validateShop,
} from "../lib/storefront-security.server";

export const loader = async ({ request }: ActionFunctionArgs) => {
    if (request.method === "OPTIONS") {
        return preflightResponse(request);
    }
    return new Response(null, { status: 405, headers: buildCorsHeaders(request) });
};

export const action = async ({ request }: ActionFunctionArgs) => {
    if (request.method === "OPTIONS") {
        return preflightResponse(request);
    }

    try {
        const payload = await request.json();
        const { shop, sessionId, eventType, metadata } = payload;

        if (!shop || !sessionId || !eventType) {
            return json(
                { error: "Missing required fields: shop, sessionId, eventType" },
                { status: 400, headers: buildCorsHeaders(request, shop) }
            );
        }

        const corsHeaders = buildCorsHeaders(request, shop);

        // Validate shop exists and is active
        const shopRecord = await validateShop(shop);
        if (!shopRecord) {
            return json({ error: "Invalid or inactive shop" }, { status: 403, headers: corsHeaders });
        }

        // Rate limit: 60 events/min per shop+session
        const rlKey = `event:${shop}:${sessionId}`;
        const rl = checkRateLimit(rlKey, 60);
        if (!rl.allowed) {
            return rateLimitResponse(request, rl.retryAfterMs, shop);
        }

        // Insert the event
        await db.event.create({
            data: {
                shopId: shop,
                sessionId,
                eventType,
                metadata: metadata || {},
            },
        });

        console.log(`[Event] ${eventType} for ${shop} (session: ${sessionId})`);

        return json({ success: true }, { headers: corsHeaders });
    } catch (error) {
        console.error("Error saving event:", error);
        return json(
            { error: "Failed to save event" },
            { status: 500, headers: buildCorsHeaders(request) }
        );
    }
};
