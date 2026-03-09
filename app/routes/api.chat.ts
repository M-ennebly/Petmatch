import { json } from "@remix-run/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import db from "../db.server";
import {
    buildCorsHeaders,
    preflightResponse,
    checkRateLimit,
    rateLimitResponse,
    validateShop,
} from "../lib/storefront-security.server";
// ONE-BRAIN: all AI logic is now handled via openaiChat.server.ts (dynamically imported below)

const MAX_MESSAGE_LENGTH = 2000;

// ── GET: Fetch Chat History & Session ─────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
    // Handle preflight OPTIONS
    if (request.method === "OPTIONS") {
        return preflightResponse(request);
    }

    const url = new URL(request.url);
    const shopDomain = url.searchParams.get("shop");
    const browserId = url.searchParams.get("browserId");

    if (!shopDomain || !browserId) {
        return json(
            { error: "Missing required parameters: shop, browserId" },
            { status: 400, headers: buildCorsHeaders(request) }
        );
    }

    const corsHeaders = buildCorsHeaders(request, shopDomain);

    // Validate shop
    const shopRecord = await validateShop(shopDomain);
    if (!shopRecord) {
        return json({ error: "Invalid or inactive shop" }, { status: 403, headers: corsHeaders });
    }

    try {
        // Upsert session
        let session = await db.chatSession.findFirst({
            where: { shopDomain, browserId },
            include: {
                messages: {
                    orderBy: { createdAt: "asc" },
                },
            },
        });

        if (!session) {
            session = await db.chatSession.create({
                data: {
                    shopDomain,
                    browserId,
                },
                include: { messages: true },
            });
        }

        // Format messages for the frontend
        const history = session.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            imageUrl: m.imageUrl,
            createdAt: m.createdAt.toISOString(),
        }));

        return json({ sessionId: session.id, history }, { headers: corsHeaders });
    } catch (error) {
        console.error("Error loading chat history:", error);
        return json({ error: "Internal Server Error" }, { status: 500, headers: corsHeaders });
    }
};

// ── POST: Send a new message ──────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
    // Handle preflight
    if (request.method === "OPTIONS") {
        return preflightResponse(request);
    }

    try {
        const payload = await request.json();
        const { shop, browserId, content, imageUrl } = payload;

        if (!shop || !browserId || (!content && !imageUrl)) {
            return json(
                { error: "Invalid payload: shop, browserId, and content or imageUrl required" },
                { status: 400, headers: buildCorsHeaders(request, shop) }
            );
        }

        const corsHeaders = buildCorsHeaders(request, shop);

        // Validate shop
        const shopRecord = await validateShop(shop);
        if (!shopRecord) {
            return json({ error: "Invalid or inactive shop" }, { status: 403, headers: corsHeaders });
        }

        // Rate limit: 20 messages/min per shop+browser
        const rlKey = `chat:${shop}:${browserId}`;
        const rl = checkRateLimit(rlKey, 20);
        if (!rl.allowed) {
            return rateLimitResponse(request, rl.retryAfterMs, shop);
        }

        // Payload limit: message content ≤ 2000 chars
        if (content && typeof content === "string" && content.length > MAX_MESSAGE_LENGTH) {
            return json(
                { error: `Message too long. Maximum ${MAX_MESSAGE_LENGTH} characters allowed.` },
                { status: 400, headers: corsHeaders }
            );
        }

        // Find session
        let session = await db.chatSession.findFirst({
            where: { shopDomain: shop, browserId },
        });

        if (!session) {
            session = await db.chatSession.create({
                data: { shopDomain: shop, browserId },
            });
        }

        console.log(`[DEBUG:chat] Route: POST /api/chat | shop=${shop} | browserId=${browserId} | dbSessionId=${session.id}`);

        // 1. Save User Message
        const userMsg = await db.chatMessage.create({
            data: {
                sessionId: session.id,
                role: "user",
                content: content || "",
                imageUrl: imageUrl || null,
            },
        });

        // 1b. ONE-BRAIN Pipeline: Intent + Scoring + Reply in one call
        let botReplyContent: string = "";
        let responseSource: string = "";
        let recommendations: any[] = [];
        let quickReplies: string[] = [];
        let _debugInfo: any = { responseSource: '', catalogContextCount: 0, recommendedHandles: [], mappedProductsCount: 0, needMoreInfo: false };

        // ── Quick reply detection (photo type selection) ──────────────
        const QUICK_REPLY_MAP: Record<string, { followUp: string }> = {
            "my pet (breed/size)": { followUp: "What's your pet's age and what are you shopping for?" },
            "a product label (ingredients)": { followUp: "What are you trying to avoid or optimize? (allergies, digestion, weight, etc.)" },
            "something else": { followUp: "Tell me more about what you're looking for!" },
        };

        const normalizedContent = (content || "").toLowerCase().trim();
        const quickReplyMatch = QUICK_REPLY_MAP[normalizedContent];

        if (quickReplyMatch) {
            // User selected a quick reply
            botReplyContent = quickReplyMatch.followUp;
            responseSource = "quick-reply-followup";
        } else if (imageUrl && !content) {
            // Image uploaded without text
            botReplyContent = "Got it! What should I look for in this photo?";
            quickReplies = ["My pet (breed/size)", "A product label (ingredients)", "Something else"];
            responseSource = "image-upload-quick-reply";
        } else {
            // ONE-BRAIN Execution Path
            try {
                // Fetch context for the prompt
                const history = await db.chatMessage.findMany({
                    where: { sessionId: session.id },
                    orderBy: { createdAt: "asc" },
                    take: 10
                });

                // Pre-filter catalog
                // Simple keyword match to reduce token size. Grab up to 50 items.
                const allProducts = await db.product.findMany({
                    where: { shopDomain: shop, status: "ACTIVE" }
                });

                // Basic scoring for context injection
                const keywords = normalizedContent.split(" ").filter((w: string) => w.length > 2);
                let scoredContext = allProducts.map(p => {
                    let score = 0;
                    const text = (p.title + " " + (p.tags || []).join(" ") + " " + (p.productType || "")).toLowerCase();
                    for (const kw of keywords) {
                        if (text.includes(kw)) score++;
                    }
                    return { product: p, score };
                });

                scoredContext.sort((a, b) => b.score - a.score || a.product.title.localeCompare(b.product.title));

                // If the user's message has no keywords hitting items, just pass the 30 most recent as a general catalog cross-section
                let contextItems = scoredContext.slice(0, 50).map(s => s.product);
                if (scoredContext.length > 0 && scoredContext[0].score === 0) {
                    contextItems = allProducts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 30);
                }

                console.log(`[TRACE:chat] PRE-OPENAI | shop=${shop} | userText="${normalizedContent}" | catalogContextCount=${contextItems.length}`);
                console.log(`[TRACE:chat] First 3 catalog items:`, contextItems.slice(0, 3).map(p => ({ handle: p.handle, title: p.title })));

                const { generateChatResponseOpenAI } = await import("../ai/openaiChat.server");

                const aiResponse = await generateChatResponseOpenAI({
                    recentMessages: history.map(h => ({ role: h.role, content: h.content || "" })),
                    catalogContext: contextItems.map(p => ({
                        handle: p.handle,
                        title: p.title,
                        productType: p.productType || undefined,
                        tags: p.tags,
                        priceMin: p.minPrice,
                        priceMax: p.maxPrice
                    })),
                    imageUrl: imageUrl || undefined
                });

                botReplyContent = aiResponse.replyText;
                if (aiResponse.needMoreInfo && aiResponse.nextQuestion) {
                    // Only append if the question isn't already in replyText (dedup guard)
                    if (!aiResponse.replyText.includes(aiResponse.nextQuestion)) {
                        botReplyContent += " " + aiResponse.nextQuestion;
                    }
                }

                // Map recommended handles back to DB rows to guarantee valid URLs formatting
                if (!aiResponse.needMoreInfo && aiResponse.recommendedHandles && aiResponse.recommendedHandles.length > 0) {
                    const matchedProducts = contextItems.filter(p => aiResponse.recommendedHandles.includes(p.handle));
                    // Cap at 3 just to be safe
                    recommendations = matchedProducts.slice(0, 3).map(p => ({
                        id: p.id,
                        title: p.title,
                        handle: p.handle,
                        featuredImageUrl: p.featuredImage,
                        priceMin: p.minPrice,
                        priceMax: p.maxPrice,
                        firstVariantId: p.firstVariantId,
                        reason: "Recommended by Assistant",
                    }));
                }

                // TRACE: post-mapping diagnostic
                console.log(`[TRACE:chat] POST-MAP | recommendedHandles=[${aiResponse.recommendedHandles.join(',')}] | mappedProductsCount=${recommendations.length} | mappedHandles=[${recommendations.map(r => r.handle).join(',')}]`);
                if (aiResponse.recommendedHandles.length > 0 && recommendations.length === 0) {
                    console.error(`[TRACE:chat] ⚠️ HANDLE MISMATCH! OpenAI returned handles that don't exist in contextItems. This means the AI hallucinated handles.`);
                    console.error(`[TRACE:chat] AI handles: ${JSON.stringify(aiResponse.recommendedHandles)}`);
                    console.error(`[TRACE:chat] Available handles: ${JSON.stringify(contextItems.map(p => p.handle))}`);
                }


                // Populate debug info
                _debugInfo = {
                    responseSource: 'one-brain-openai',
                    catalogContextCount: contextItems.length,
                    recommendedHandles: aiResponse.recommendedHandles,
                    mappedProductsCount: recommendations.length,
                    needMoreInfo: aiResponse.needMoreInfo,
                };

                responseSource = "one-brain-openai";

            } catch (err: any) {
                console.error("[DEBUG:chat] ONE-BRAIN generation failed, falling back:", err);
                await db.errorLog.create({ data: { area: "one-brain", message: err.message || "OpenAI error" } });

                botReplyContent = "I'm here to help! What kind of pet are you shopping for?";
                responseSource = "ai-fail-fallback";
                recommendations = [];
            }
        }

        console.log(`[DEBUG:chat] Response source: ${responseSource} | recs=${recommendations.length}`);

        // Save bot message
        const botMsg = await db.chatMessage.create({
            data: {
                sessionId: session.id,
                role: "bot",
                content: botReplyContent,
            },
        });

        return json(
            {
                success: true,
                sessionId: session.id,
                userMessage: {
                    id: userMsg.id,
                    role: userMsg.role,
                    content: userMsg.content,
                    imageUrl: userMsg.imageUrl,
                    createdAt: userMsg.createdAt.toISOString(),
                },
                botMessage: {
                    id: botMsg.id,
                    role: botMsg.role,
                    content: botMsg.content,
                    imageUrl: botMsg.imageUrl,
                    createdAt: botMsg.createdAt.toISOString(),
                },
                recommendations,
                quickReplies,
                _debug: _debugInfo,
            },
            { headers: corsHeaders }
        );
    } catch (error) {
        console.error("Error processing message:", error);
        return json(
            { error: "Internal Server Error" },
            { status: 500, headers: buildCorsHeaders(request) }
        );
    }
};
