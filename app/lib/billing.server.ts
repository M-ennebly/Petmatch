import { PLANS, type PlanKey } from "./billing.shared";

export async function getShopPlan(shopDomain: string): Promise<PlanKey> {
    const { default: db } = await import("../db.server");
    const sub = await db.subscription.findUnique({ where: { shopDomain } });
    if (!sub || sub.status !== "ACTIVE") return "FREE";
    return (sub.plan as PlanKey) || "FREE";
}

export async function getMonthlyUsage(shopDomain: string): Promise<{ messages: number; images: number }> {
    const { default: db } = await import("../db.server");
    const now = new Date();
    const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const events = await db.event.findMany({
        where: {
            shopId: shopDomain,
            createdAt: { gte: firstDayOfMonth },
            eventType: { in: ["message_sent", "image_uploaded"] }
        }
    });
    return {
        messages: events.filter(e => e.eventType === "message_sent").length,
        images: events.filter(e => e.eventType === "image_uploaded").length,
    };
}
