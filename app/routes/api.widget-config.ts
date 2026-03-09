import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import db from "../db.server";
import {
    buildCorsHeaders,
    preflightResponse,
} from "../lib/storefront-security.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
    // Handle preflight
    if (request.method === "OPTIONS") {
        return preflightResponse(request);
    }

    const url = new URL(request.url);
    const shopDomain = url.searchParams.get("shop");

    if (!shopDomain) {
        return json(
            { error: "Missing shop parameter" },
            { status: 400, headers: buildCorsHeaders(request) }
        );
    }

    const corsHeaders = buildCorsHeaders(request, shopDomain);

    try {
        const shop = await db.shop.findUnique({
            where: { domain: shopDomain },
            include: { merchantSettings: true },
        });

        const settings = shop?.merchantSettings;

        // Return the 5 specific fields with safe defaults
        const config = {
            primaryColor: settings?.primaryColor || "#22c55e",
            borderRadius: settings?.borderRadius ?? 16,
            position: settings?.widgetPosition || "bottom-right",
            greetingText: settings?.greetingText || "Hi! Tell me about your pet and what you're looking for.",
            avatarUrl: settings?.avatarUrl || null,
        };

        return json(config, {
            headers: {
                ...corsHeaders,
                "Cache-Control": "no-store",
            }
        });
    } catch (error) {
        console.error("Error loading widget config:", error);
        // Return graceful defaults if DB fails
        return json(
            {
                primaryColor: "#22c55e",
                borderRadius: 16,
                position: "bottom-right",
                greetingText: "Hi! Tell me about your pet and what you're looking for.",
                avatarUrl: null,
            },
            { headers: corsHeaders }
        );
    }
};
