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
import { generateChatResponseOpenAI } from "../ai/openaiChat.server";

const MAX_CONTENT_LENGTH = 2000;

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
        const { shop, sessionId, content } = payload;

        if (!shop || !content) {
            return json(
                { error: "Missing required fields: shop, content" },
                { status: 400, headers: buildCorsHeaders(request, shop) }
            );
        }

        const corsHeaders = buildCorsHeaders(request, shop);

        const shopRecord = await validateShop(shop);
        if (!shopRecord) {
            return json({ error: "Invalid or inactive shop" }, { status: 403, headers: corsHeaders });
        }

        const rlKey = `recommend:${shop}:${sessionId || "anon"}`;
        const rl = checkRateLimit(rlKey, 20);
        if (!rl.allowed) {
            return rateLimitResponse(request, rl.retryAfterMs, shop);
        }

        if (typeof content === "string" && content.length > MAX_CONTENT_LENGTH) {
            return json(
                { error: `Content too long. Maximum ${MAX_CONTENT_LENGTH} characters allowed.` },
                { status: 400, headers: corsHeaders }
            );
        }

        console.log(`[DEBUG:recommend] Route: POST /api/recommend | shop=${shop} | sessionId=${sessionId}`);

        let botReplyContent = "";
        let recommendations: any[] = [];

        try {
            const history = sessionId ? await db.chatMessage.findMany({
                where: { sessionId },
                orderBy: { createdAt: "asc" },
                take: 10
            }) : [];

            history.push({ role: "user", content: content, id: "temp", sessionId: sessionId || "", createdAt: new Date(), imageUrl: null });

            const allProducts = await db.product.findMany({
                where: { shopDomain: shop, status: "ACTIVE" }
            });

            const normalizedContent = content.toLowerCase().trim();
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

            let contextItems = scoredContext.slice(0, 50).map(s => s.product);
            if (scoredContext.length > 0 && scoredContext[0].score === 0) {
                contextItems = allProducts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 30);
            }

            const aiResponse = await generateChatResponseOpenAI({
                recentMessages: history.map(h => ({ role: h.role, content: h.content || "" })),
                catalogContext: contextItems.map(p => ({
                    handle: p.handle,
                    title: p.title,
                    productType: p.productType || undefined,
                    tags: p.tags,
                    priceMin: p.minPrice,
                    priceMax: p.maxPrice
                }))
            });

            botReplyContent = aiResponse.replyText;
            if (aiResponse.needMoreInfo && aiResponse.nextQuestion) {
                botReplyContent += " " + aiResponse.nextQuestion;
            }

            if (!aiResponse.needMoreInfo && aiResponse.recommendedHandles && aiResponse.recommendedHandles.length > 0) {
                const matchedProducts = contextItems.filter(p => aiResponse.recommendedHandles.includes(p.handle));
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

        } catch (err: any) {
            console.error("[DEBUG:recommend] ONE-BRAIN generation failed, falling back:", err);
            await db.errorLog.create({ data: { area: "one-brain-recommend", message: err.message || "OpenAI error" } });
            botReplyContent = "I'm here to help! What kind of pet are you shopping for?";
        }

        if (sessionId) {
            const session = await db.chatSession.findUnique({ where: { id: sessionId } });
            if (session) {
                const savedContent = botReplyContent +
                    (recommendations.length > 0
                        ? "\n\n[" + recommendations.map(r => r.title).join(" | ") + "]"
                        : "");

                // Do not duplicate the user's message here if they already posted it to chat,
                // but we should save the bot's response to maintain session state.
                await db.chatMessage.create({
                    data: {
                        sessionId,
                        role: "bot",
                        content: savedContent,
                    },
                });
            }
        }

        return json({
            replyText: botReplyContent,
            recommendations
        }, { headers: corsHeaders });

    } catch (error) {
        console.error("Error generating recommendations:", error);
        return json(
            { error: "Internal Server Error" },
            { status: 500, headers: buildCorsHeaders(request) }
        );
    }
};
