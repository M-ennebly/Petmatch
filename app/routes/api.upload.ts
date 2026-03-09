import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import {
    buildCorsHeaders,
    preflightResponse,
    checkRateLimit,
    rateLimitResponse,
    validateShop,
} from "../lib/storefront-security.server";
import db from "../db.server";
// Intent extraction removed — ONE-BRAIN handles image context in the chat route

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED_MIME_PREFIX = "image/";

export const loader = async ({ request }: ActionFunctionArgs) => {
    if (request.method === "OPTIONS") {
        return preflightResponse(request);
    }
    return new Response(null, { status: 405, headers: buildCorsHeaders(request) });
};

export const action = async ({ request }: ActionFunctionArgs) => {
    // Handle preflight OPTIONS
    if (request.method === "OPTIONS") {
        return preflightResponse(request);
    }

    if (request.method !== "POST") {
        return json(
            { error: "Method not allowed" },
            { status: 405, headers: buildCorsHeaders(request) }
        );
    }

    const supabaseUrl = process.env.SUPABASE_URL!;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        const formData = await request.formData();
        const file = formData.get("file") as File;
        const shopDomain = formData.get("shopDomain") as string;
        const browserId = formData.get("browserId") as string;

        if (!file || !shopDomain || !browserId) {
            return json(
                { error: "Missing required fields: file, shopDomain, browserId" },
                { status: 400, headers: buildCorsHeaders(request, shopDomain) }
            );
        }

        const corsHeaders = buildCorsHeaders(request, shopDomain);

        // Validate shop exists and is active
        const shopRecord = await validateShop(shopDomain);
        if (!shopRecord) {
            return json({ error: "Invalid or inactive shop" }, { status: 403, headers: corsHeaders });
        }

        // Rate limit: 5 uploads/min per shop+browser
        const rlKey = `upload:${shopDomain}:${browserId}`;
        const rl = checkRateLimit(rlKey, 5);
        if (!rl.allowed) {
            return rateLimitResponse(request, rl.retryAfterMs, shopDomain);
        }

        // File size limit: 5 MB
        if (file.size > MAX_FILE_SIZE) {
            return json(
                { error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB.` },
                { status: 400, headers: corsHeaders }
            );
        }

        // MIME type check: only image/*
        if (!file.type.startsWith(ALLOWED_MIME_PREFIX)) {
            return json(
                { error: `Invalid file type "${file.type}". Only image files are accepted.` },
                { status: 400, headers: corsHeaders }
            );
        }

        // Generate unique filename
        const ext = file.name.split(".").pop();
        const fileName = `${shopDomain}/${browserId}/${Date.now()}.${ext}`;

        // Upload to Supabase Storage (bucket: chat-images)
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const { data, error } = await supabase.storage
            .from("chat-images")
            .upload(fileName, buffer, {
                contentType: file.type,
            });

        if (error) {
            console.error("Supabase upload error:", error);
            return json({ error: "Failed to upload image" }, { status: 500, headers: corsHeaders });
        }

        // Get the public URL
        const { data: publicUrlData } = supabase.storage
            .from("chat-images")
            .getPublicUrl(fileName);

        // Intent extraction removed — ONE-BRAIN handles image context in /api/chat

        return json(
            { success: true, imageUrl: publicUrlData.publicUrl },
            { headers: corsHeaders }
        );
    } catch (error: any) {
        console.error("Error processing upload:", error);
        return json(
            { error: "Internal Server Error" },
            { status: 500, headers: buildCorsHeaders(request) }
        );
    }
};
