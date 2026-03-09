import { OpenAI } from "openai";

export type CatalogContextItem = {
    handle: string;
    title: string;
    productType?: string;
    tags?: string[];
    priceMin?: string;
    priceMax?: string;
};

export type OneBrainResponse = {
    replyText: string;
    recommendedHandles: string[];
    needMoreInfo: boolean;
    nextQuestion: string | null;
    _debug: {
        rawModelOutput: string;
        modelNeedMoreInfo: boolean;
        recommendedHandles: string[];
        nextQuestionLength: number;
    };
};

export async function generateChatResponseOpenAI({
    recentMessages,
    catalogContext,
    imageUrl,
}: {
    recentMessages: { role: string; content: string }[];
    catalogContext: CatalogContextItem[];
    imageUrl?: string;
}): Promise<OneBrainResponse> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error("Missing OPENAI_API_KEY");
    }

    const model = process.env.OPENAI_MODEL_INTENT || "gpt-4o-mini";
    const timeout = parseInt(process.env.OPENAI_TIMEOUT_MS || "10000", 10);
    const maxTokens = parseInt(process.env.OPENAI_MAX_OUTPUT_TOKENS || "450", 10);

    const openai = new OpenAI({
        apiKey,
        timeout,
    });

    const systemPrompt = `You are PetMatch — the friendliest person at a pet store. You love animals and get genuinely excited helping people.

PERSONALITY:
- Talk like a real person. Use contractions (you're, I'd, let's).
- Light emoji is fine 🐾 but don't overdo it.
- Match the customer's energy. Be enthusiastic but not annoying.
- NEVER repeat the same phrasing twice in a conversation.

RECOMMENDATION-FIRST RULE (critical):
Your #1 job is to RECOMMEND PRODUCTS, not ask questions.
- If the user mentions ANY product category (food, kibble, treats, toy, shampoo, collar, leash, bed, grooming, brush), their goal is KNOWN. Recommend 1-3 matching products from the Catalog Context immediately.
- If the user mentions a pet type (dog, cat, puppy, kitten) AND a category, you have ENOUGH info. Recommend now.
- You may include a casual follow-up in replyText like "Want me to narrow it down to grain-free options?" BUT still set needMoreInfo=false and still include recommendedHandles.
- Only set needMoreInfo=true when:
  (A) The user hasn't mentioned what they want at all (e.g. just "hello" or "hi"), OR
  (B) The catalog genuinely has ZERO products that could plausibly match, OR
  (C) A recommendation would be unsafe/misleading (medical/health) without one critical detail.

PRODUCT MATCHING:
- Look through the Catalog Context. Pick products whose title, type, or tags relate to what the user wants.
- If the match isn't perfect but reasonable, recommend it anyway with context: "This could work for your puppy!"
- Only recommend handles that exist in the Catalog Context.
- If catalog has nothing remotely relevant, be honest: "I don't see that in stock right now" and set needMoreInfo=false with empty handles.

JSON OUTPUT RULES:
- replyText: Your conversational reply. May include a casual follow-up question. Do NOT put formal standalone questions here.
- nextQuestion: ONLY used when needMoreInfo=true. Put exactly ONE question here. It gets appended to replyText automatically.
- needMoreInfo: true ONLY per the rules above. Default should be false when you can recommend.
- recommendedHandles: 0-3 product handles from catalog. MUST be [] when needMoreInfo=true.`;

    // Compact the catalog context to save tokens
    const compactCatalog = catalogContext.map(c => ({
        handle: c.handle,
        title: c.title,
        type: c.productType || "",
        tags: (c.tags || []).join(", "),
        price: c.priceMin === c.priceMax ? `$${c.priceMin}` : `$${c.priceMin}-$${c.priceMax}`
    }));

    const developerPrompt = `AVAILABLE CATALOG CONTEXT:
${JSON.stringify(compactCatalog, null, 2)}

${imageUrl ? "Note: The user just uploaded an image in this turn." : ""}
`;

    const messages: any[] = [
        { role: "system", content: systemPrompt },
        { role: "developer", content: developerPrompt },
    ];

    // Append up to 10 recent messages
    const recent = recentMessages.slice(-10);
    for (const msg of recent) {
        messages.push({ role: msg.role === "bot" ? "assistant" : "user", content: msg.content });
    }

    console.log(`[DEBUG:openaiChat] Sending ONE-BRAIN req. Catalog items: ${compactCatalog.length}`);

    try {
        const response = await openai.chat.completions.create({
            model,
            messages,
            max_tokens: maxTokens,
            temperature: 0.85,
            response_format: {
                type: "json_schema",
                json_schema: {
                    name: "assistant_reply",
                    strict: true,
                    schema: {
                        type: "object",
                        properties: {
                            replyText: { type: "string" },
                            recommendedHandles: {
                                type: "array",
                                items: { type: "string" }
                            },
                            needMoreInfo: { type: "boolean" },
                            nextQuestion: { type: ["string", "null"] }
                        },
                        required: ["replyText", "recommendedHandles", "needMoreInfo", "nextQuestion"],
                        additionalProperties: false
                    }
                }
            }
        });

        const rawContent = response.choices[0]?.message?.content;
        if (!rawContent) {
            throw new Error("No content returned from OpenAI");
        }

        console.log(`[TRACE:openaiChat] Raw model output: ${rawContent}`);

        const parsed = JSON.parse(rawContent);

        // Enforce the logic rules safely in case the strict mode hiccups
        let needMoreInfo = Boolean(parsed.needMoreInfo);
        let recommendedHandles = Array.isArray(parsed.recommendedHandles) ? parsed.recommendedHandles : [];
        let nextQuestion = parsed.nextQuestion || null;

        // Capture raw values for debug before enforcement
        const debugInfo = {
            rawModelOutput: rawContent,
            modelNeedMoreInfo: Boolean(parsed.needMoreInfo),
            recommendedHandles: Array.isArray(parsed.recommendedHandles) ? [...parsed.recommendedHandles] : [],
            nextQuestionLength: (parsed.nextQuestion || '').length
        };

        console.log(`[TRACE:openaiChat] Parsed: needMoreInfo=${needMoreInfo}, handles=[${recommendedHandles.join(',')}], nextQ=${nextQuestion ? nextQuestion.substring(0, 50) : 'null'}`);

        if (needMoreInfo) {
            recommendedHandles = [];
        } else {
            nextQuestion = null;
        }

        return {
            replyText: parsed.replyText || "Hello!",
            recommendedHandles,
            needMoreInfo,
            nextQuestion,
            _debug: debugInfo
        };

    } catch (error) {
        console.error("[DEBUG:openaiChat] Error generating ONE-BRAIN reply:", error);
        throw error;
    }
}
