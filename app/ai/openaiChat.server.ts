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
    storeKnowledge,
    customInstructions,
}: {
    recentMessages: { role: string; content: string }[];
    catalogContext: CatalogContextItem[];
    imageUrl?: string;
    storeKnowledge?: string;
    customInstructions?: string;
}): Promise<OneBrainResponse> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

    const model = process.env.OPENAI_MODEL_INTENT || "gpt-4o-mini";
    const timeout = parseInt(process.env.OPENAI_TIMEOUT_MS || "10000", 10);
    const maxTokens = parseInt(process.env.OPENAI_MAX_OUTPUT_TOKENS || "450", 10);

    const openai = new OpenAI({ apiKey, timeout });

    const catalogText = catalogContext.length > 0
        ? catalogContext.map(p =>
            `- ${p.title} (handle: ${p.handle})${p.productType ? `, type: ${p.productType}` : ""}${p.tags?.length ? `, tags: ${p.tags.join(", ")}` : ""}, price: $${p.priceMin}`
        ).join("\n")
        : "No products currently in catalog.";

    const systemPrompt = `You are Lumi, a friendly pet shopping assistant for this store. Have a natural conversation with the customer, understand their pet and needs, then recommend products.

RULES:
- Respond naturally like a helpful person, not a robot.
- If the message is a greeting or vague, warmly introduce yourself and ask about their pet.
- Only recommend products once you understand the pet type AND what they need.
- Ask only ONE question at a time.
- Keep replies short: 2-4 sentences.
- When recommending products, mention the product title naturally in your reply.
- If asked about store policies, returns, or shipping, answer from the Store Knowledge below.
- For medical emergencies, always say to contact a vet immediately.
${customInstructions ? `\nExtra instructions: ${customInstructions}` : ""}

STORE CATALOG:
${catalogText}

${storeKnowledge ? `STORE KNOWLEDGE (policies, FAQ, shipping):
${storeKnowledge}` : ""}

IMPORTANT: At the end of your reply, on a new line, add a JSON block like this (and nothing else after it):
{"handles": ["handle-1", "handle-2"]}
If you are not recommending any products, use: {"handles": []}
Only include handles that exist in the catalog above.`;

    const messages: any[] = [
        { role: "system", content: systemPrompt },
        ...recentMessages.map(m => ({
            role: m.role === "user" ? "user" : "assistant",
            content: m.content
        }))
    ];

    if (imageUrl) {
        messages[messages.length - 1].content = [
            { type: "text", text: messages[messages.length - 1].content },
            { type: "image_url", image_url: { url: imageUrl } }
        ];
    }

    try {
        const response = await openai.chat.completions.create({
            model,
            messages,
            max_tokens: maxTokens,
            temperature: 0.8,
        });

        const raw = response.choices[0]?.message?.content || "";
        console.log(`[TRACE:openaiChat] Raw: ${raw}`);

        // Split reply text from the JSON handles block
        const jsonMatch = raw.match(/\{"handles":\s*\[.*?\]\}/s);
        const replyText = raw.replace(jsonMatch?.[0] || "", "").trim();

        let recommendedHandles: string[] = [];
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[0]);
                recommendedHandles = Array.isArray(parsed.handles) ? parsed.handles : [];
            } catch {
                recommendedHandles = [];
            }
        }

        const needMoreInfo = recommendedHandles.length === 0;

        return {
            replyText: replyText || "I'm here to help! Tell me about your pet.",
            recommendedHandles,
            needMoreInfo,
            nextQuestion: null,
            _debug: {
                rawModelOutput: raw,
                modelNeedMoreInfo: needMoreInfo,
                recommendedHandles,
                nextQuestionLength: 0
            }
        };

    } catch (error) {
        console.error("[DEBUG:openaiChat] Error:", error);
        throw error;
    }
}
